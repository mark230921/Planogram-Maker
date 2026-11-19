const GOOGLE_SHEET_API_URL = "https://script.google.com/macros/s/AKfycbxCnqhXH2V-h3lbXa1_CbKR9ERP5T9kRnb-kFuHUrsxbRO9IK4ReUs07SK5jp7XgNNk_Q/exec";
const TAGS_PER_PAGE = 44;
const DB_ITEMS_PER_PAGE = 10; // Exactly 10 items per page

let activeScannerTarget = 'maker'; 
let html5QrCode = null;
let productsDatabase = {};
let normalizedBarcodeIndex = {}; // Pre-indexed for fast barcode searching
let tagList = [];
let currentPreviewProduct = null;
let toastTimeout = null;

// Pagination state for Database table
let currentDbPage = 1;
let filteredDbProducts = [];

// Active barcode reference for price modal update
let editingBarcode = null;

// ---- PIN protection (works with the secured Apps Script) ----
// The PIN is kept in memory only (never saved on the device) and forgotten after 5 minutes.
let cachedPin = null;
let cachedPinAt = 0;
const PIN_MEMORY_MS = 5 * 60 * 1000;

function escHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function getCachedPin() {
    if (cachedPin && Date.now() - cachedPinAt < PIN_MEMORY_MS) return cachedPin;
    cachedPin = null;
    return null;
}

function askPin(title, message) {
    return new Promise(resolve => {
        const old = document.getElementById("pinModal");
        if (old) old.remove();

        const m = document.createElement("div");
        m.id = "pinModal";
        m.className = "theme-modal";
        m.style.display = "flex";
        m.innerHTML =
            '<div class="modal-content" role="dialog" aria-modal="true">' +
            '<h3 style="margin-top:0;margin-bottom:6px;">' + escHtml(title || "Enter PIN") + '</h3>' +
            '<p style="margin:0 0 12px;font-size:13px;color:var(--text-muted);">' + escHtml(message || "") + '</p>' +
            '<input type="password" id="pinInput" class="input-control" inputmode="numeric" autocomplete="off" placeholder="PIN">' +
            '<div style="display:flex;gap:10px;margin-top:14px;">' +
            '<button type="button" id="pinCancel" class="btn btn-danger-light" style="flex:1;">Cancel</button>' +
            '<button type="button" id="pinOk" class="btn btn-primary" style="flex:1;">OK</button>' +
            '</div></div>';
        document.body.appendChild(m);

        const input = document.getElementById("pinInput");
        const done = value => { m.remove(); resolve(value); };
        document.getElementById("pinCancel").onclick = () => done(null);
        document.getElementById("pinOk").onclick = () => done(input.value.trim() || null);
        input.addEventListener("keydown", e => { if (e.key === "Enter") done(input.value.trim() || null); });
        setTimeout(() => input.focus(), 100);
    });
}

// Sends a protected request to the Google Sheet script and returns its answer: { ok, error }
async function postToSheet(payload, pinTitle, pinMessage) {
    let pin = getCachedPin();
    if (!pin) {
        pin = await askPin(pinTitle, pinMessage);
        if (!pin) return { ok: false, error: "cancelled" };
    }
    try {
        // text/plain keeps this a "simple" request, so the browser can read the answer
        const res = await fetch(GOOGLE_SHEET_API_URL, {
            method: "POST",
            body: JSON.stringify(Object.assign({}, payload, { pin: pin }))
        });
        const json = await res.json();
        if (json && json.ok) {
            cachedPin = pin;
            cachedPinAt = Date.now();
        } else {
            cachedPin = null;
        }
        return json || { ok: false, error: "error" };
    } catch (err) {
        console.error("Sheet request error:", err);
        cachedPin = null;
        return { ok: false, error: "network" };
    }
}

function sheetErrorText(code) {
    if (code === "denied") return "Wrong PIN, or this PIN is not allowed to do this.";
    if (code === "locked") return "Too many wrong PINs. Please wait a few minutes.";
    if (code === "network") return "Could not reach the server. Check your connection.";
    if (code === "busy") return "Server is busy. Please try again.";
    return "Not saved: " + (code || "unknown error");
}

// ---- Confirm modal (same look as the other modals; replaces window.confirm) ----
let confirmResolver = null;

function showConfirm({ title = "Confirm", message = "", subMessage = "", okText = "OK", danger = false } = {}) {
    return new Promise(resolve => {
        if (confirmResolver) confirmResolver(false);   // close any pop-up that is still open
        confirmResolver = resolve;

        document.getElementById("confirmTitle").innerText = title;
        document.getElementById("confirmMessage").innerText = message;
        document.getElementById("confirmSubMessage").innerText = subMessage;

        const okBtn = document.getElementById("confirmOkBtn");
        okBtn.innerText = okText;
        okBtn.className = "btn " + (danger ? "btn-danger-solid" : "btn-black");
        okBtn.style.flex = "1";

        document.getElementById("confirmModal").style.display = "flex";
    });
}

function resolveConfirm(result) {
    document.getElementById("confirmModal").style.display = "none";
    const resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(result);
}

// ---- Alert modal (same look as the other modals; replaces window.alert) ----
const ALERT_ICONS = {
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

let alertResolver = null;

function showAlert({ title = "Notice", message = "", detail = "", type = "warning", okText = "OK" } = {}) {
    return new Promise(resolve => {
        if (alertResolver) alertResolver();   // close any alert that is still open
        alertResolver = resolve;

        const icon = document.getElementById("alertIcon");
        icon.className = "alert-icon " + type;
        icon.innerHTML = ALERT_ICONS[type] || ALERT_ICONS.warning;

        document.getElementById("alertTitle").innerText = title;
        document.getElementById("alertMessage").innerText = message;
        document.getElementById("alertDetail").innerText = detail;
        document.getElementById("alertOkBtn").innerText = okText;

        document.getElementById("alertModal").style.display = "flex";
    });
}

function closeAlert() {
    document.getElementById("alertModal").style.display = "none";
    const resolve = alertResolver;
    alertResolver = null;
    if (resolve) resolve();
}

// Theme Management
function openThemeModal() {
    document.getElementById("themeModal").style.display = "flex";
}

function closeThemeModal() {
    document.getElementById("themeModal").style.display = "none";
}

// Open one of the pages that now live inside Settings
function openSettingsTab(tabId) {
    closeThemeModal();
    switchTab(tabId);
    window.scrollTo(0, 0);
}

function setTheme(themeName) {
    if (themeName === 'default') {
        document.body.removeAttribute('data-theme');
        localStorage.removeItem('appTheme');
    } else {
        document.body.setAttribute('data-theme', themeName);
        localStorage.setItem('appTheme', themeName);
    }
    closeThemeModal();
}

function loadSavedTheme() {
    const savedTheme = localStorage.getItem('appTheme');
    if (savedTheme) {
        document.body.setAttribute('data-theme', savedTheme);
    }
}

// Helper: Debounce function to delay search execution while typing
function debounce(func, delay = 300) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

// Audio Beep Generator using Web Audio API
function playScanBeep() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.12);
    } catch (e) {
        console.log("Audio beep note:", e);
    }
}

// Show Toast Notification for 2 seconds
function showToast(message = "Item not found") {
    const toast = document.getElementById("toastNotification");
    if (!toast) return;

    toast.innerText = message;
    toast.classList.add("show");

    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }

    toastTimeout = setTimeout(() => {
        toast.classList.remove("show");
    }, 2000);
}

document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("searchInput")) return;   // Planogram page only
    loadSavedTheme();
    fetchProductsFromGoogleSheet();

    const searchInput = document.getElementById("searchInput");
    const debouncedSearch = debounce((val) => handleTyping(val), 250);
    
    searchInput.addEventListener("input", (e) => {
        debouncedSearch(e.target.value);
    });

    searchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSearch(searchInput.value, true);
        }
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideSuggestions();
    });
    // 'click' only fires on a real tap, so scrolling outside never closes it by accident
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#searchSuggestions") && e.target.id !== "searchInput") hideSuggestions();
    });

    const dbSearchInput = document.getElementById("dbSearchInput");
    if (dbSearchInput) {
        const debouncedDbFilter = debounce((val) => filterDatabaseTable(val), 250);
        dbSearchInput.addEventListener("input", (e) => {
            debouncedDbFilter(e.target.value);
        });
    }

    // Allow pressing Enter in price modal input to save
    const modalInput = document.getElementById("modalNewPriceInput");
    if (modalInput) {
        modalInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                submitNewPrice();
            }
        });
    }
});

function formatPriceNumber(rawPrice) {
    if (!rawPrice) return "0.00";
    let cleaned = String(rawPrice).replace(/[^0-9.]/g, '');
    let num = parseFloat(cleaned);
    if (isNaN(num)) return "0.00";
    return num.toFixed(2);
}

function getYearDayMonthDate() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return yy + dd + mm;
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    if (btn) btn.classList.add('active');

    // The PDF can only be drawn once its tab is visible (needs a real width)
    if (tabId === 'pdfsTab') showActivePdf();
}

const PRODUCT_CACHE_KEY = 'planogram_product_db_cache';
let productsLoaded = false;      // true once any product list (saved copy or fresh) is indexed
let productsReady = Promise.resolve();   // resolves when the fresh download has finished
let pendingSearch = null;        // text typed while products were still loading

// Only keep what the planogram needs: small, so it is saved and read back instantly
function slimProducts(list) {
    return (Array.isArray(list) ? list : (list && (list.data || list.products || list.items || list.result)) || [])
        .map(p => ({ barcode: String(p.barcode == null ? '' : p.barcode).trim(), name: p.name, price: p.price }))
        .filter(p => p.barcode);
}

// Build the lookup tables from the product list (used for both the saved copy and the fresh download)
function applyProductData(data) {
    productsDatabase = {};
    normalizedBarcodeIndex = {};

    if (!Array.isArray(data) || data.length === 0) {
        filteredDbProducts = [];
        renderDatabaseTable();
        return false;
    }

    data.forEach(item => {
        const cleanBarcode = String(item.barcode || '').trim();
        if (cleanBarcode) {
            item.barcode = cleanBarcode;
            item.formattedPrice = formatPriceNumber(item.price);
            item.lowerName = (item.name || '').toLowerCase();

            productsDatabase[cleanBarcode] = item;

            const stripped = cleanBarcode.replace(/^0+/, '');
            normalizedBarcodeIndex[stripped] = cleanBarcode;
        }
    });

    productsLoaded = true;

    // Reverse the array so the last added items appear first in the table
    filteredDbProducts = Object.values(productsDatabase).reverse();
    currentDbPage = 1;
    renderDatabaseTable();
    rerunPendingSearch();
    return true;
}

// If the user typed while products were loading, show the results as soon as they arrive
function rerunPendingSearch() {
    if (!pendingSearch) return;
    const input = document.getElementById("searchInput");
    const q = pendingSearch;
    pendingSearch = null;
    if (input && input.value.trim() === q) handleTyping(q);
}

// Keep a copy of the product list on this device so the next visit is instant
function saveProductCache(list) {
    try {
        localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify(slimProducts(list || Object.values(productsDatabase))));
    } catch (e) { /* storage full or blocked: just skip the cache */ }
}

function fetchProductsFromGoogleSheet() {
    if (!GOOGLE_SHEET_API_URL || GOOGLE_SHEET_API_URL.includes("YOUR_GOOGLE_APPS_SCRIPT")) {
        console.warn("Please specify your Google Apps Script Web App URL.");
        return Promise.resolve();
    }

    // 1) Instant: use the last saved copy while the fresh one downloads (same idea as the Decals page)
    let hasCache = false;
    try {
        const cached = JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY));
        if (Array.isArray(cached) && cached.length) hasCache = applyProductData(slimProducts(cached));
    } catch (e) {}

    // 2) Fetch the fresh copy in the background and swap it in
    productsReady = fetch(GOOGLE_SHEET_API_URL)
        .then(res => res.json())
        .then(data => {
            const list = slimProducts(data);
            if (list.length) saveProductCache(list);   // save first (before the lists get extra fields)
            applyProductData(list);
        })
        .catch(err => {
            console.error("Fetch Error:", err);
            if (hasCache) return;   // keep working from the saved copy
            document.getElementById("dbTableBody").innerHTML = `<tr><td colspan="4" style="color:red; text-align:center;">Error connecting to Google Sheet API.</td></tr>`;
        });
    return productsReady;
}

// Render Database Table with Pagination (10 items per page)
function renderDatabaseTable() {
    const tbody = document.getElementById("dbTableBody");
    tbody.innerHTML = "";

    if (!filteredDbProducts || filteredDbProducts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No products found in Database.</td></tr>`;
        renderPaginationControls(0);
        return;
    }

    const totalPages = Math.ceil(filteredDbProducts.length / DB_ITEMS_PER_PAGE);
    if (currentDbPage > totalPages) currentDbPage = totalPages;
    if (currentDbPage < 1) currentDbPage = 1;

    const startIdx = (currentDbPage - 1) * DB_ITEMS_PER_PAGE;
    const endIdx = startIdx + DB_ITEMS_PER_PAGE;
    const pageItems = filteredDbProducts.slice(startIdx, endIdx);

    const fragment = document.createDocumentFragment();

    pageItems.forEach(item => {
        const cleanBarcode = item.barcode;
        const formattedPrice = item.formattedPrice || formatPriceNumber(item.price);
        const itemName = escHtml(item.name || '');

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td title="${cleanBarcode}">${cleanBarcode}</td>
            <td title="${itemName}"><div class="truncate-cell">${itemName}</div></td>
            <td>p ${formattedPrice}</td>
            <td>
                <div class="db-action-buttons">
                    <button type="button" class="btn-action btn-edit" onclick="changeProductPrice('${cleanBarcode}')"> + </button>
                    <button type="button" class="btn-action btn-del" onclick="removeProductFromDatabase('${cleanBarcode}')"> × </button>
                </div>
            </td>
        `;
        fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
    renderPaginationControls(totalPages);
}

// Render Pagination Controls & Update Top Badge Total
function renderPaginationControls(totalPages) {
    let paginationContainer = document.getElementById("dbPagination");
    if (!paginationContainer) {
        paginationContainer = document.createElement("div");
        paginationContainer.id = "dbPagination";
        paginationContainer.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 10px;";
        const tableCard = document.querySelector("#databaseTab .card:last-child");
        if (tableCard) tableCard.appendChild(paginationContainer);
    }

    // Update top badge inside red marking area
    const totalBadge = document.getElementById("dbTotalBadge");
    if (totalBadge) {
        totalBadge.innerText = `Total: ${filteredDbProducts.length}`;
    }

    if (totalPages <= 1 && filteredDbProducts.length === 0) {
        paginationContainer.innerHTML = `<span style="font-size:12px; font-weight:bold; width:100%; text-align:center;">Database has 0 items</span>`;
        return;
    }

    paginationContainer.innerHTML = `
        <button type="button" class="btn-action" style="padding:6px 12px;" onclick="changeDbPage(-1)" ${currentDbPage === 1 ? 'disabled' : ''}>&laquo; Prev</button>
        <span style="font-size:12px; font-weight:bold;">Page ${currentDbPage} of ${totalPages || 1}</span>
        <button type="button" class="btn-action" style="padding:6px 12px;" onclick="changeDbPage(1)" ${currentDbPage === totalPages || totalPages === 0 ? 'disabled' : ''}>Next &raquo;</button>
    `;
}

function changeDbPage(direction) {
    currentDbPage += direction;
    renderDatabaseTable();
}

function filterDatabaseTable(query) {
    const cleanQuery = String(query || '').toLowerCase().trim();
    const allProducts = Object.values(productsDatabase).reverse();
    
    if (!cleanQuery) {
        filteredDbProducts = allProducts;
    } else {
        filteredDbProducts = allProducts.filter(item => 
            (item.barcode && item.barcode.toLowerCase().includes(cleanQuery)) ||
            (item.lowerName && item.lowerName.includes(cleanQuery))
        );
    }

    currentDbPage = 1;
    renderDatabaseTable();
}

// Custom Price Modal Handlers
function changeProductPrice(barcode) {
    const product = productsDatabase[barcode];
    if (!product) return;

    editingBarcode = barcode;
    document.getElementById("priceModalProductName").innerText = `${product.name} (${barcode})`;
    const priceInput = document.getElementById("modalNewPriceInput");
    priceInput.value = product.formattedPrice || product.price;
    
    document.getElementById("priceModal").style.display = "flex";
    setTimeout(() => {
        priceInput.focus();
        priceInput.select();
    }, 100);
}

function closePriceModal() {
    document.getElementById("priceModal").style.display = "none";
    editingBarcode = null;
}

async function submitNewPrice() {
    if (!editingBarcode) return;
    const barcode = editingBarcode;
    const product = productsDatabase[barcode];
    if (!product) {
        closePriceModal();
        return;
    }

    const newPrice = formatPriceNumber(document.getElementById("modalNewPriceInput").value);
    closePriceModal();

    const result = await postToSheet(
        { action: "updatePrice", barcode: barcode, price: newPrice, name: product.name },
        "Admin PIN", "Enter the admin PIN to change this price."
    );

    if (!result.ok) {
        if (result.error !== "cancelled") {
            await showAlert({ title: "Price not changed", message: sheetErrorText(result.error), type: "error" });
        }
        return;
    }

    // Only change the screen after the server accepted it
    productsDatabase[barcode].price = newPrice;
    productsDatabase[barcode].formattedPrice = newPrice;
    saveProductCache();
    filterDatabaseTable(document.getElementById("dbSearchInput").value);
    showToast("Price updated");
}

async function removeProductFromDatabase(barcode) {
    const product = productsDatabase[barcode];
    if (!product) return;

    const ok = await showConfirm({
        title: "Remove Product",
        message: `${product.name} (${barcode})`,
        subMessage: "This will remove it from the Google Sheet database.",
        okText: "Remove",
        danger: true
    });
    if (!ok) return;

    const result = await postToSheet(
        { action: "delete", barcode: barcode },
        "Admin PIN", "Enter the admin PIN to remove this product."
    );

    if (!result.ok) {
        if (result.error !== "cancelled") {
            await showAlert({ title: "Not removed", message: sheetErrorText(result.error), type: "error" });
        }
        return;
    }

    // Only change the screen after the server accepted it
    delete productsDatabase[barcode];
    const stripped = barcode.replace(/^0+/, '');
    delete normalizedBarcodeIndex[stripped];
    saveProductCache();
    filterDatabaseTable(document.getElementById("dbSearchInput").value);
    showToast("Product removed");
}

// ---- Keyword suggestions while typing in Search or Scan Product ----
let suggestMatches = [];

function hideSuggestions() {
    const box = document.getElementById("searchSuggestions");
    if (!box) return;
    box.classList.remove("show");
    box.innerHTML = "";
    suggestMatches = [];
}

function searchProductsByKeyword(query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const p of Object.values(productsDatabase)) {
        if (words.every(w => (p.lowerName && p.lowerName.includes(w)) || p.barcode.includes(w))) {
            out.push(p);
            if (out.length >= 50) break;
        }
    }
    return out;
}

function handleTyping(value) {
    const q = String(value || '').trim();
    pendingSearch = null;
    if (!q) {
        hideSuggestions();
        hidePreviewOnly();
        return;
    }

    // Exact barcode (typed or from a scanner): straight to the preview card, as before
    const isBarcode = productsDatabase[q] || normalizedBarcodeIndex[q.replace(/^0+/, '')];
    if (isBarcode || /^\d{8,14}$/.test(q)) {
        hideSuggestions();
        handleSearch(q);
        return;
    }

    hidePreviewOnly();
    if (q.length < 2) {
        hideSuggestions();
        return;
    }

    const box = document.getElementById("searchSuggestions");
    suggestMatches = searchProductsByKeyword(q);
    box.innerHTML = "";

    if (!suggestMatches.length) {
        const empty = document.createElement("div");
        empty.className = "suggest-empty";
        empty.textContent = productsLoaded
            ? "No saved product matches."
            : "Loading products...";
        pendingSearch = productsLoaded ? null : q;   // re-run automatically once the products arrive
        box.appendChild(empty);
    } else {
        suggestMatches.forEach(p => {
            const row = document.createElement("div");
            row.className = "suggest-item";
            const nameEl = document.createElement("span");
            nameEl.className = "suggest-name";
            nameEl.textContent = p.name || '';
            const priceEl = document.createElement("span");
            priceEl.className = "suggest-price";
            priceEl.textContent = "p " + (p.formattedPrice || formatPriceNumber(p.price));
            row.appendChild(nameEl);
            row.appendChild(priceEl);
            // 'click' only fires on a real tap, so scrolling the list never picks an item
            row.addEventListener("mousedown", (e) => e.preventDefault());   // keep the keyboard open
            row.addEventListener("click", () => pickSuggestion(p));
            box.appendChild(row);
        });
    }
    box.classList.add("show");
}

function pickSuggestion(product) {
    if (!product) return;
    playScanBeep();
    document.getElementById("searchInput").value = product.name || product.barcode;
    let prod = {...product};
    prod.storeNo = document.getElementById("storeCodeInput").value.trim();
    prod.categoryNo = document.getElementById("categoryCodeInput").value.trim();
    prod.location = document.getElementById("locationCodeInput").value.trim();
    showPreview(prod);   // also closes the list
}

function handleSearch(query, notifyIfMissing = false) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
        hidePreviewOnly();
        return;
    }

    const storeCode = document.getElementById("storeCodeInput").value.trim();
    const categoryCode = document.getElementById("categoryCodeInput").value.trim();
    const locationCode = document.getElementById("locationCodeInput").value.trim();

    if (productsDatabase[cleanQuery]) {
        playScanBeep();
        let prod = {...productsDatabase[cleanQuery]};
        prod.storeNo = storeCode;
        prod.categoryNo = categoryCode;
        prod.location = locationCode;
        showPreview(prod);
        return;
    }

    const strippedQuery = cleanQuery.replace(/^0+/, '');
    const matchedBarcodeKey = normalizedBarcodeIndex[strippedQuery];
    if (matchedBarcodeKey && productsDatabase[matchedBarcodeKey]) {
        playScanBeep();
        let prod = {...productsDatabase[matchedBarcodeKey]};
        prod.storeNo = storeCode;
        prod.categoryNo = categoryCode;
        prod.location = locationCode;
        showPreview(prod);
        return;
    }

    const lowerQuery = cleanQuery.toLowerCase();
    const matchedByNameKey = Object.keys(productsDatabase).find(b => 
        productsDatabase[b].lowerName && productsDatabase[b].lowerName.includes(lowerQuery)
    );

    if (matchedByNameKey) {
        playScanBeep();
        let prod = {...productsDatabase[matchedByNameKey]};
        prod.storeNo = storeCode;
        prod.categoryNo = categoryCode;
        prod.location = locationCode;
        showPreview(prod);
        return;
    }

    currentPreviewProduct = null;
    document.getElementById("previewCard").style.display = "none";

    // Only warn on a deliberate scan / Enter press, never while the user is still typing
    if (notifyIfMissing) showBarcodeNotFound(cleanQuery);
}

async function showBarcodeNotFound(code) {
    await showAlert({
        title: "Barcode not found",
        message: "Barcode not found in Database or Rescan the barcode of product",
        detail: "Scanned code: " + code,
        type: "warning",
        okText: "OK"
    });
    // Clear the box so the next scan / entry starts fresh
    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.value.trim() === code) searchInput.value = "";
}

function showPreview(product) {
    hideSuggestions();
    currentPreviewProduct = product;
    const displayPrice = formatPriceNumber(product.price);

    document.getElementById("prevName").innerText = product.name || 'UNKNOWN ITEM';
    document.getElementById("prevPrice").innerText = `p ${displayPrice}`;
    document.getElementById("prevBarcode").innerText = product.barcode || '';
    document.getElementById("prevStore").innerText = product.storeNo || '';
    document.getElementById("prevCategory").innerText = product.categoryNo || '';
    document.getElementById("prevLocation").innerText = product.location || '';

    document.getElementById("previewCard").style.display = "flex";
}

function hidePreviewOnly() {
    currentPreviewProduct = null;
    document.getElementById("previewCard").style.display = "none";
}

function cancelPreview() {
    hideSuggestions();
    currentPreviewProduct = null;
    document.getElementById("previewCard").style.display = "none";
    const searchInput = document.getElementById("searchInput");
    searchInput.value = "";
    searchInput.blur();
}

function confirmAddTag() {
    if (!currentPreviewProduct) return;
    const storeCode = document.getElementById("storeCodeInput").value.trim();
    const categoryCode = document.getElementById("categoryCodeInput").value.trim();
    const locationCode = document.getElementById("locationCodeInput").value.trim();

    tagList.push({
        name: currentPreviewProduct.name,
        price: formatPriceNumber(currentPreviewProduct.price),
        barcode: currentPreviewProduct.barcode,
        storeNo: storeCode,
        categoryNo: categoryCode,
        location: locationCode,
        dateCode: getYearDayMonthDate()
    });

    renderSheet();
    cancelPreview();
}

function renderSheet() {
    const sheetOuter = document.getElementById("sheetOuter");
    const countSpan = document.getElementById("tagCountNum");
    const pageSpan = document.getElementById("pageCountNum");

    sheetOuter.innerHTML = "";
    countSpan.innerText = tagList.length;

    const totalPages = Math.ceil(tagList.length / TAGS_PER_PAGE) || 0;
    pageSpan.innerText = totalPages;

    if (tagList.length === 0) {
        sheetOuter.innerHTML = `
            <div class="a4-page">
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg width="24" height="24" fill="#64748B" viewBox="0 0 24 24"><path d="M2 4h2v16H2V4zm4 0h1v16H6V4zm3 0h2v16H9V4zm4 0h1v16h-1V4zm3 0h2v16h-2V4zm4 0h1v16h-1V4z"/></svg>
                    </div>
                    <div style="font-weight: 700; font-size: 14px;">A4 Sheet is Empty</div>
                    <div style="font-size: 12px; color: #94A3B8;">(Scanned items populate 44 tags per A4 page)</div>
                </div>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (let p = 0; p < totalPages; p++) {
        const pageDiv = document.createElement("div");
        pageDiv.className = "a4-page";
        
        const gridDiv = document.createElement("div");
        gridDiv.className = "tags-grid";

        const pageTags = tagList.slice(p * TAGS_PER_PAGE, (p + 1) * TAGS_PER_PAGE);

        pageTags.forEach((tag, idx) => {
            const globalIndex = p * TAGS_PER_PAGE + idx;
            const tagDiv = document.createElement("div");
            tagDiv.className = "shelf-tag";
            const svgId = `barcode-svg-${globalIndex}`;

            const storeHtml = tag.storeNo ? `<span>${tag.storeNo}</span>` : `<span></span>`;
            const catHtml = tag.categoryNo ? `<span>[${tag.categoryNo}]</span>` : `<span></span>`;
            const locHtml = tag.location ? `<span>${tag.location}</span>` : `<span></span>`;
            const dateHtml = tag.dateCode ? `<span>${tag.dateCode}</span>` : `<span></span>`;

            tagDiv.innerHTML = `
                <button type="button" class="delete-tag-btn" onclick="removeTag(${globalIndex})" title="Remove Tag">×</button>
                <div class="tag-name">${tag.name}</div>
                <div class="tag-price-row">
                    <span class="peso-sign">p</span>
                    <span class="tag-price-amount">${tag.price}</span>
                </div>
                <div class="barcode-container">
                    <svg id="${svgId}" class="barcode-svg"></svg>
                </div>
                <div class="tag-footer">
                    ${storeHtml}
                    ${catHtml}
                    ${locHtml}
                    ${dateHtml}
                </div>
            `;
            gridDiv.appendChild(tagDiv);
        });

        pageDiv.appendChild(gridDiv);
        fragment.appendChild(pageDiv);
    }

    sheetOuter.appendChild(fragment);

    tagList.forEach((tag, globalIndex) => {
        const svgId = `barcode-svg-${globalIndex}`;
        const targetSvg = document.getElementById(svgId);
        if (targetSvg) {
            try {
                JsBarcode(`#${svgId}`, tag.barcode, {
                    format: "CODE128",
                    width: 1.1,
                    height: 20,
                    displayValue: false,
                    margin: 0
                });
            } catch (e) {
                targetSvg.outerHTML = `<p style="color:red; font-size:6pt; margin:0;">Invalid Barcode</p>`;
            }
        }
    });
}

function removeTag(index) {
    tagList.splice(index, 1);
    renderSheet();
}

function undoTag() {
    tagList.pop();
    renderSheet();
}

function clearAllTags() {
    tagList = [];
    renderSheet();
}

let isSavingPdf = false;

// Let the browser paint / free memory between heavy steps so the page never freezes
const nextFrame = () => new Promise(r => setTimeout(r, 40));

async function saveToPDF() {
    if (isSavingPdf) return;               // ignore double taps
    if (tagList.length === 0) {
        showAlert({
            title: "No Shelf tags to export",
            message: "Please add at least one shelf tag to the A4 sheet before saving to PDF.",
            type: "warning",
            okText: "Exit"
        });
        return;
    }
    if (typeof html2canvas === "undefined" || !window.jspdf || !window.jspdf.jsPDF) {
        showAlert({
            title: "PDF library not loaded",
            message: "html2canvas / jsPDF did not load. Check your internet connection, make sure both index.html and script.js are updated, then reload the app.",
            type: "error"
        });
        return;
    }

    isSavingPdf = true;
    const pdfBtn = document.querySelector(".btn-pdf");
    if (pdfBtn) pdfBtn.disabled = true;

    // Hidden off-screen stage: pages are cloned here at real A4 size, so the
    // visible sheet (scaled, clipped, scrolling) is never touched.
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;background:#fff;pointer-events:none;";
    document.body.appendChild(stage);

    const filename = 'Temporary Shelf Tag by Mark Jake.pdf';
    const sourcePages = Array.from(document.querySelectorAll("#sheetOuter .a4-page"));
    const pageCount = sourcePages.length;
    const tagCount = tagList.length;

    try {
        showToast("Creating PDF...");

        // Make sure the shelf tag fonts are loaded before capturing
        try {
            await Promise.all([
                document.fonts.load("900 10pt 'Roboto Condensed'"),
                document.fonts.load("900 15pt 'Roboto'"),
                document.fonts.load("700 12pt 'Roboto'"),
                document.fonts.load("400 5pt 'Roboto'")
            ]);
            await document.fonts.ready;
        } catch (e) {
            console.warn("Font preload failed, continuing with fallback:", e);
        }

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });

        // Capture ONE page at a time to keep memory low
        for (let i = 0; i < pageCount; i++) {
            showToast(`Creating PDF... page ${i + 1} of ${pageCount}`);
            await nextFrame();

            const clone = sourcePages[i].cloneNode(true);
            clone.style.transform = "none";
            clone.style.margin = "0";
            clone.style.border = "none";
            clone.style.boxShadow = "none";
            clone.style.breakAfter = "auto";
            clone.style.pageBreakAfter = "auto";
            clone.style.background = "#fff";
            clone.querySelectorAll(".delete-tag-btn").forEach(b => b.remove());
            stage.innerHTML = "";
            stage.appendChild(clone);
            await nextFrame();

            let canvas;
            try {
                canvas = await html2canvas(clone, { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff" });
            } catch (e) {
                console.warn("Capture at 2x failed, retrying at 1x:", e);
                canvas = await html2canvas(clone, { scale: 1, useCORS: true, logging: false, backgroundColor: "#ffffff" });
            }

            if (i > 0) pdf.addPage("a4", "portrait");
            pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297, undefined, "FAST");

            canvas.width = 0;      // free memory right away
            canvas.height = 0;
            stage.innerHTML = "";
            await nextFrame();
        }

        const blob = pdf.output("blob");

        // Keep a copy inside the app first, so it is saved even if the browser blocks the download
        const rec = {
            id: 'pdf_' + Date.now(),
            name: filename,
            createdAt: Date.now(),
            size: blob.size,
            pages: pageCount,
            tags: tagCount,
            blob: blob
        };
        await pdfStorePut(rec);
        await loadSavedPdfs(rec.id);

        try { downloadBlob(blob, filename); } catch (e) { console.warn("Auto-download failed:", e); }

        // PDF is safely stored - clear the sheet and preview so a new one can be started
        tagList = [];
        renderSheet();
        cancelPreview();

        switchTab('pdfsTab');
        showToast("PDF saved");
    } catch (err) {
        console.error("PDF Export Error:", err);
        showAlert({
            title: "Could not create the PDF",
            message: "Something went wrong while exporting your tags.",
            detail: "Reason: " + (err && err.message ? err.message : err),
            type: "error"
        });
    } finally {
        stage.remove();
        isSavingPdf = false;
        if (pdfBtn) pdfBtn.disabled = false;
    }
}

async function saveProductToGoogleSheet(e) {
    e.preventDefault();
    const statusMsg = document.getElementById("statusMsg");
    const saveBtn = document.getElementById("saveDbBtn");

    const barcodeInput = String(document.getElementById("dbBarcode").value).trim();

    if (productsDatabase[barcodeInput]) {
        statusMsg.style.color = "red";
        statusMsg.innerText = `Error: Barcode "${barcodeInput}" already exists in the database!`;
        return;
    }

    const field = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    const payload = {
        action: "add",
        name: document.getElementById("dbName").value.trim().toUpperCase(),
        price: formatPriceNumber(document.getElementById("dbPrice").value),
        barcode: barcodeInput,
        storeNo: field("dbStoreNo"),
        categoryNo: field("dbCategoryNo"),
        location: field("dbLocation")
    };

    saveBtn.disabled = true;
    statusMsg.style.color = "#555";
    statusMsg.innerText = "Saving row to Google Sheet...";

    const result = await postToSheet(payload, "Store PIN", "Enter the PIN to add this product.");
    saveBtn.disabled = false;

    if (!result.ok) {
        statusMsg.style.color = "red";
        statusMsg.innerText = result.error === "cancelled" ? "Cancelled." : sheetErrorText(result.error);
        return;
    }

    statusMsg.style.color = "green";
    statusMsg.innerText = "Product added successfully to Google Sheet!";
    document.getElementById("dbProductForm").reset();
    setTimeout(fetchProductsFromGoogleSheet, 1500);
}

function openScanner(target) {
    activeScannerTarget = target;
    document.getElementById("scannerModal").style.display = "flex";
    html5QrCode = new Html5Qrcode("reader");

    html5QrCode.start(
        { facingMode: "environment" },
        { 
            fps: 15, 
            qrbox: { width: 220, height: 110 },
            aspectRatio: 1.0
        },
        (decodedText) => {
            const cleanText = String(decodedText).trim();
            playScanBeep();
            if (activeScannerTarget === 'maker') {
                document.getElementById("searchInput").value = cleanText;
                handleSearch(cleanText, true);
            } else {
                document.getElementById("dbBarcode").value = cleanText;
            }
            closeScanner();
        },
        () => {}
    ).then(() => {
        setTimeout(() => {
            const videoEl = document.querySelector("#reader video");
            if (videoEl && videoEl.srcObject) {
                const track = videoEl.srcObject.getVideoTracks()[0];
                if (track) {
                    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
                    if (capabilities.focusMode) {
                        track.applyConstraints({
                            advanced: [{ focusMode: "continuous" }]
                        }).catch(err => console.log("Autofocus constraint note:", err));
                    }
                }
            }
        }, 500);
    }).catch(err => {
        showAlert({
            title: "Camera unavailable",
            message: "Unable to access the camera. Please allow camera permission and try again.",
            detail: String(err),
            type: "error"
        });
        closeScanner();
    });
}

function closeScanner() {
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            html5QrCode.clear();
            document.getElementById("scannerModal").style.display = "none";
        }).catch(() => {
            document.getElementById("scannerModal").style.display = "none";
        });
    } else {
        document.getElementById("scannerModal").style.display = "none";
    }
}

/* =====================================================================
   SAVED PDFs PAGE  (storage, viewer, list, share)
   ===================================================================== */
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const PDF_DB_NAME = "planogramPdfDB";
const PDF_STORE = "pdfs";

let savedPdfs = [];        // newest first, each item includes its Blob
let activePdfId = null;    // PDF currently shown in the viewer
let renderedPdfId = null;  // PDF currently drawn in the viewer
let pdfRenderToken = 0;
let memoryPdfs = [];       // fallback if IndexedDB is unavailable (e.g. private mode)
let shareFile = null;      // File prepared for the share sheet

// ---- Storage (IndexedDB, so saved PDFs survive closing the app) ----
function openPdfDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("IndexedDB not available"));
        const req = indexedDB.open(PDF_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(PDF_STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function pdfStoreRun(mode, fn) {
    const db = await openPdfDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_STORE, mode);
        const req = fn(tx.objectStore(PDF_STORE));
        tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
    });
}

async function pdfStorePut(rec) {
    try {
        await pdfStoreRun("readwrite", store => store.put(rec));
    } catch (e) {
        console.warn("Saving to IndexedDB failed, keeping PDF in memory only:", e);
        memoryPdfs = memoryPdfs.filter(p => p.id !== rec.id);
        memoryPdfs.push(rec);
    }
}

async function pdfStoreAll() {
    let stored = [];
    try {
        stored = await pdfStoreRun("readonly", store => store.getAll());
    } catch (e) {
        console.warn("Reading IndexedDB failed:", e);
    }
    return stored.concat(memoryPdfs);
}

async function pdfStoreDelete(id) {
    memoryPdfs = memoryPdfs.filter(p => p.id !== id);
    try {
        await pdfStoreRun("readwrite", store => store.delete(id));
    } catch (e) {
        console.warn("Deleting from IndexedDB failed:", e);
    }
}

function isDecalPdf(rec) {
    return rec.kind === "decals" || rec.name === "7-Eleven-Decals.pdf";
}

async function loadSavedPdfs(selectId) {
    // Decals PDFs live in the same storage but belong to the Decals page only
    savedPdfs = (await pdfStoreAll()).filter(p => !isDecalPdf(p)).sort((a, b) => b.createdAt - a.createdAt);

    if (selectId) {
        activePdfId = selectId;
    } else if (!savedPdfs.some(p => p.id === activePdfId)) {
        activePdfId = savedPdfs.length ? savedPdfs[0].id : null;
    }

    renderPdfList();
    showActivePdf();
}

// Share PDF button on the Planogram Maker page: shares the newest saved PDF
let savedPdfsReady = null;   // resolves once the saved list has been read from storage

async function shareLastPdf() {
    try { if (savedPdfsReady) await savedPdfsReady; } catch (e) {}
    if (!savedPdfs.length) {
        showAlert({
            title: "No PDF to share yet",
            message: "Tap Save to PDF first, then tap Share PDF.",
            type: "warning"
        });
        return;
    }
    openShareModal(savedPdfs[0].id);   // savedPdfs is sorted newest first
}

// ---- Helpers ----
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function pdfMetaText(rec) {
    const when = new Date(rec.createdAt).toLocaleString();
    return `${when} • ${rec.pages} page${rec.pages === 1 ? "" : "s"} • ${rec.tags} tag${rec.tags === 1 ? "" : "s"} • ${formatFileSize(rec.size)}`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadSavedPdf(id) {
    const rec = savedPdfs.find(p => p.id === id);
    if (rec) downloadBlob(rec.blob, rec.name);
}

function openSavedPdf(id) {
    const rec = savedPdfs.find(p => p.id === id);
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- List of saved PDFs ----
function renderPdfList() {
    const list = document.getElementById("pdfList");
    document.getElementById("pdfCountBadge").innerText = `Total: ${savedPdfs.length}`;
    list.innerHTML = "";

    if (savedPdfs.length === 0) {
        list.innerHTML = `<div class="pdf-empty">No saved PDF files yet.</div>`;
        return;
    }

    savedPdfs.forEach(rec => {
        const item = document.createElement("div");
        item.className = "pdf-item" + (rec.id === activePdfId ? " active" : "");

        const info = document.createElement("div");
        info.className = "pdf-item-info";
        const nameEl = document.createElement("div");
        nameEl.className = "pdf-item-name";
        nameEl.textContent = rec.name;
        const metaEl = document.createElement("div");
        metaEl.className = "pdf-item-meta";
        metaEl.textContent = pdfMetaText(rec);
        info.appendChild(nameEl);
        info.appendChild(metaEl);

        const actions = document.createElement("div");
        actions.className = "db-action-buttons";
        const mk = (label, cls, handler) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn-action " + cls;
            b.textContent = label;
            b.onclick = handler;
            return b;
        };
        actions.appendChild(mk("View", "btn-edit", () => selectPdf(rec.id)));
        actions.appendChild(mk("Share", "btn-edit", () => openShareModal(rec.id)));
        actions.appendChild(mk("Delete", "btn-del", () => deleteSavedPdf(rec.id)));

        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
    });
}

function selectPdf(id) {
    activePdfId = id;
    renderPdfList();
    showActivePdf();
    const viewer = document.getElementById("pdfViewerName");
    if (viewer) viewer.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteSavedPdf(id) {
    const rec = savedPdfs.find(p => p.id === id);
    if (!rec) return;
    const ok = await showConfirm({
        title: "Delete PDF",
        message: rec.name,
        subMessage: `Saved on ${new Date(rec.createdAt).toLocaleString()}`,
        okText: "Delete",
        danger: true
    });
    if (!ok) return;

    await pdfStoreDelete(id);
    if (id === activePdfId) {
        activePdfId = null;
        renderedPdfId = null;
    }
    await loadSavedPdfs();
}

// ---- Viewer (draws each PDF page onto a canvas using PDF.js) ----
async function showActivePdf() {
    const pagesEl = document.getElementById("pdfPages");
    const rec = savedPdfs.find(p => p.id === activePdfId);

    const hasPdf = !!rec;
    ["pdfShareBtn", "pdfDownloadBtn", "pdfOpenBtn"].forEach(id => {
        document.getElementById(id).disabled = !hasPdf;
    });

    if (!rec) {
        document.getElementById("pdfViewerName").innerText = "No PDF selected";
        document.getElementById("pdfViewerMeta").innerText = "";
        pagesEl.innerHTML = `<div class="pdf-empty">No saved PDF yet.<br>Tap <strong>Save to PDF</strong> in the Planogram Maker tab.</div>`;
        renderedPdfId = null;
        return;
    }

    document.getElementById("pdfViewerName").innerText = rec.name;
    document.getElementById("pdfViewerMeta").innerText = pdfMetaText(rec);

    if (renderedPdfId === rec.id) return;       // already drawn
    if (!pagesEl.clientWidth) return;           // tab is hidden; draw when it opens

    const token = ++pdfRenderToken;
    renderedPdfId = null;
    pagesEl.innerHTML = `<div class="pdf-empty">Loading PDF...</div>`;

    try {
        if (typeof pdfjsLib === "undefined") throw new Error("PDF viewer library not loaded");

        const buffer = await rec.blob.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        if (token !== pdfRenderToken) return;

        pagesEl.innerHTML = "";
        const targetWidth = pagesEl.clientWidth;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            if (token !== pdfRenderToken) return;

            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: (targetWidth / base.width) * dpr });

            const canvas = document.createElement("canvas");
            canvas.className = "pdf-page-canvas";
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            pagesEl.appendChild(canvas);

            await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
        }

        if (token === pdfRenderToken) renderedPdfId = rec.id;
    } catch (err) {
        console.error("PDF view error:", err);
        if (token === pdfRenderToken) {
            pagesEl.innerHTML = `<div class="pdf-empty">Could not preview this PDF here.<br>Use <strong>Open</strong> or <strong>Download</strong> instead.</div>`;
        }
    }
}

// ---- Sharing ----
function openShareModal(id) {
    const rec = savedPdfs.find(p => p.id === id);
    if (!rec) return;
    // Prepare the file now so the share call can run straight from the tap
    shareFile = new File([rec.blob], rec.name, { type: "application/pdf" });
    document.getElementById("shareFileName").innerText = rec.name;
    document.getElementById("shareModal").style.display = "flex";
}

function closeShareModal() {
    document.getElementById("shareModal").style.display = "none";
}

function shareVia(target) {
    if (!shareFile) {
        showToast("No PDF selected to share.");
        return;
    }

    const data = {
        files: [shareFile],
        title: shareFile.name,
        text: /decals/i.test(shareFile.name) ? "Decals PDF" : "Shelf tags PDF"
    };

    if (navigator.canShare && navigator.canShare(data)) {
        navigator.share(data)
            .then(() => closeShareModal())
            .catch(err => {
                if (err && err.name === "AbortError") return; // user closed the share menu
                console.error("Share error:", err);
                shareFallback(target);
            });
    } else {
        shareFallback(target);
    }
}

// Used when the browser cannot share files directly (desktop, http://, older browsers)
function shareFallback(target) {
    const file = shareFile;
    downloadBlob(file, file.name);
    closeShareModal();

    if (target === "gmail") {
        const subject = encodeURIComponent(file.name);
        const body = encodeURIComponent(`Please attach the downloaded file: ${file.name}`);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    } else {
        const names = { messenger: "Messenger", shareit: "SHAREit", bluetooth: "Bluetooth" };
        showToast(`PDF downloaded. Send it from ${names[target] || "your app"}.`);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("pdfList")) return;   // Planogram page only
    savedPdfsReady = loadSavedPdfs();
});


/* =====================================================================
   DECALS MAKER (decals.html)
   Runs only on the Decals page. Theme, toast and beep above are shared.
   ===================================================================== */
(function () {
    if (!document.getElementById('decalForm')) return;

        let decals = [];
        let undoStack = [];
        let lastScheme = 'AUTO';

        window.onload = function() {
            loadSavedTheme();
            // Set default date to today for convenience
            const today = new Date().toISOString().split('T')[0];
            const startDateEl = document.getElementById('startDate');
            if (startDateEl && !startDateEl.value) startDateEl.value = today;
            renderDecals();
            loadProductDB(); // start fetching the product database right away
        };

        function saveStateForUndo() {
            undoStack.push(JSON.stringify(decals));
            if (undoStack.length > 25) undoStack.shift();
            updateUndoButtonState();
        }

        function updateUndoButtonState() {
            const undoBtn = document.getElementById('undoBtn');
            if (undoBtn) {
                undoBtn.disabled = undoStack.length === 0;
            }
        }

        function undoAction() {
            if (undoStack.length > 0) {
                const prevState = undoStack.pop();
                decals = JSON.parse(prevState);
                renderDecals();
                updateUndoButtonState();
                showToast('Action undone successfully!');
            }
        }

        function handleSchemeChange() {
            const schemeSelect = document.getElementById('promoScheme').value;
            const promoPriceContainer = document.getElementById('promoPriceContainer');
            const oldPriceContainer = document.getElementById('oldPriceContainer');
            const currentPriceInput = document.getElementById('currentPrice');
            const savingsInput = document.getElementById('savingsText');
            const oldPriceLabel = document.getElementById('oldPriceLabel');
            const savingsLabel = document.getElementById('savingsLabel');

            // Leaving Custom Promo: drop the typed message and lock the banner again
            if (lastScheme === 'CUSTOMPROMO' && schemeSelect !== 'CUSTOMPROMO') savingsInput.value = '';
            lastScheme = schemeSelect;
            const isCustomPromo = schemeSelect === 'CUSTOMPROMO';
            document.getElementById('itemName').required = !isCustomPromo;
            document.getElementById('oldPrice').required = !isCustomPromo;
            // Custom Promo: only the promo message and dates are used
            document.getElementById('productNameGroup').style.display = isCustomPromo ? 'none' : '';
            document.getElementById('priceInputsGrid').style.display = isCustomPromo ? 'none' : '';
            savingsInput.readOnly = !isCustomPromo;
            savingsInput.rows = isCustomPromo ? 3 : 2;
            savingsInput.style.cursor = isCustomPromo ? 'text' : 'not-allowed';
            savingsInput.style.opacity = isCustomPromo ? '1' : '0.85';
            savingsInput.placeholder = isCustomPromo
                ? "Type your promo, e.g. Buy 2 Snickers 46g + Buy 2 M&M Deluxe to get FREE ..."
                : "Will generate automatically";
            savingsLabel.textContent = isCustomPromo ? 'Promo Message (type your own banner)' : 'Header Badge Text (Auto-Generated)';

            if (schemeSelect === 'CUSTOM' || schemeSelect === 'AUTO') {
                promoPriceContainer.style.display = '';
                currentPriceInput.setAttribute('required', 'true');
                oldPriceContainer.className = "form-group";
                oldPriceLabel.textContent = "Original Price";
                calculateSavings();
            } else {
                promoPriceContainer.style.display = 'none';
                currentPriceInput.removeAttribute('required');
                currentPriceInput.value = '';
                oldPriceContainer.className = "form-group";
                
                if (isCustomPromo) {
                    oldPriceLabel.textContent = "Unit Price";
                    if (!savingsInput.value) savingsInput.focus();
                } else if (schemeSelect === 'B1T1') {
                    oldPriceLabel.textContent = "Unit Price";
                    savingsInput.value = "BUY 1 TAKE 1 !";
                } else if (schemeSelect === 'B2T2') {
                    oldPriceLabel.textContent = "Unit Price";
                    savingsInput.value = "BUY 2 TAKE 2 !";
                } else if (schemeSelect === 'SAVE50') {
                    oldPriceLabel.textContent = "Original Price";
                    savingsInput.value = "SAVE 50% !";
                } else if (schemeSelect === 'SAVE30') {
                    oldPriceLabel.textContent = "Original Price";
                    savingsInput.value = "SAVE 30% !";
                }
            }
        }

        function calculateSavings() {
            const schemeSelect = document.getElementById('promoScheme').value;
            if (schemeSelect !== 'CUSTOM' && schemeSelect !== 'AUTO') return;

            const curInput = document.getElementById('currentPrice');
            const oldInput = document.getElementById('oldPrice');
            const savingsInput = document.getElementById('savingsText');

            let cur = parseFloat(curInput.value);
            let old = parseFloat(oldInput.value);

            if (!isNaN(cur) && !isNaN(old) && old > cur) {
                const diff = Number(wholePrice(old)) - Number(wholePrice(cur)); // based on the whole-peso prices shown on the decal
                const discountPercent = Math.round(((old - cur) / old) * 100);

                if (schemeSelect === 'AUTO') {
                    if (discountPercent === 50) {
                        savingsInput.value = "SAVE 50% !!";
                    } else if (discountPercent === 30) {
                        savingsInput.value = "SAVE 30% !!";
                    } else if (discountPercent >= 48 && discountPercent <= 52) {
                        savingsInput.value = "BUY 1 TAKE 1 !!";
                    } else {
                        savingsInput.value = `SAVE P${diff} !!`;
                    }
                } else if (schemeSelect === 'CUSTOM') {
                    savingsInput.value = `SAVE P${diff} !!`;
                }
            }
        }

        function formatPromoDates(startStr, endStr) {
            if (!startStr) return '';
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            
            const start = new Date(startStr);
            const sMonth = months[start.getMonth()];
            const sDay = start.getDate();
            const sYear = start.getFullYear();

            if (!endStr || endStr === startStr) {
                return `${sMonth} ${sDay} ${sYear}`;
            }

            const end = new Date(endStr);
            const eMonth = months[end.getMonth()];
            const eDay = end.getDate();
            const eYear = end.getFullYear();

            if (sYear === eYear && sMonth === eMonth) {
                if (sDay === eDay) {
                    return `${sMonth} ${sDay} ${sYear}`;
                }
                return `${sMonth} ${sDay}-${eDay} ${sYear}`;
            } else if (sYear === eYear) {
                return `${sMonth} ${sDay} - ${eMonth} ${eDay} ${sYear}`;
            } else {
                return `${sMonth} ${sDay} ${sYear} - ${eMonth} ${eDay} ${eYear}`;
            }
        }

        // Prices are rounded UP to the next whole peso and shown with .00 (32.90 -> 33.00)
        function wholePrice(v) {
            const n = parseFloat(v);
            if (isNaN(n)) return '';
            return Math.ceil(Number(n.toFixed(2))).toFixed(2);
        }

        function addDecal(e) {
            e.preventDefault();
            saveStateForUndo();

            const schemeSelect = document.getElementById('promoScheme').value;
            let currentPriceVal = document.getElementById('currentPrice').value;
            const oldPriceVal = parseFloat(document.getElementById('oldPrice').value);

            if (schemeSelect === 'CUSTOMPROMO') {
                // custom promo shows only the message and dates
                currentPriceVal = '';
            } else if (schemeSelect === 'B1T1' || schemeSelect === 'B2T2') {
                currentPriceVal = oldPriceVal.toFixed(2);
            } else if (schemeSelect === 'SAVE50') {
                currentPriceVal = (oldPriceVal * 0.5).toFixed(2);
            } else if (schemeSelect === 'SAVE30') {
                currentPriceVal = (oldPriceVal * 0.7).toFixed(2);
            } else {
                currentPriceVal = parseFloat(currentPriceVal).toFixed(2);
            }

            const startDateVal = document.getElementById('startDate').value;
            const endDateVal = document.getElementById('endDate').value;
            const formattedDates = formatPromoDates(startDateVal, endDateVal);

            const newItem = {
                id: Date.now(),
                name: schemeSelect === 'CUSTOMPROMO' ? '' : document.getElementById('itemName').value.trim(),
                currentPrice: wholePrice(currentPriceVal),
                oldPrice: schemeSelect === 'CUSTOMPROMO' ? '' : wholePrice(oldPriceVal),
                savings: document.getElementById('savingsText').value,
                scheme: schemeSelect,
                symbol: 'P',
                dates: formattedDates
            };

            decals.push(newItem);
            renderDecals();
            showToast('Decal added to page!');
            
            document.getElementById('itemName').value = '';
            hideSuggestions();
            document.getElementById('promoScheme').value = 'AUTO';
            handleSchemeChange();
            document.getElementById('itemName').focus();
        }

        function deleteDecal(id) {
            saveStateForUndo();
            decals = decals.filter(d => d.id !== id);
            renderDecals();
            showToast('Decal deleted!');
        }

        function clearAllDecals() {
            if (decals.length === 0) return;
            saveStateForUndo();
            decals = [];
            renderDecals();
            showToast('All decals cleared!');
        }

        let isSavingDecalPdf = false;
        let lastDecalPdf = null;   // most recent saved decals PDF (used by Share PDF)

        // Same share flow as the Planogram Maker: prepare the File, open the share modal,
        // then shareVia() / shareFallback() (shared functions above) do the sharing.
        async function shareLastDecalPdf() {
            try { await decalPdfReady; } catch (e) {}
            if (!lastDecalPdf) {
                showAlert({
                    title: "No PDF to share yet",
                    message: "Tap Save to PDF first, then tap Share PDF.",
                    type: "warning"
                });
                return;
            }
            shareFile = new File([lastDecalPdf.blob], lastDecalPdf.name, { type: 'application/pdf' });
            document.getElementById('shareFileName').innerText = lastDecalPdf.name;
            document.getElementById('shareModal').style.display = 'flex';
        }

        // After a reload, pick up the newest saved decals PDF so it can still be shared
        const decalPdfReady = (async function restoreLastDecalPdf() {
            try {
                const all = await pdfStoreAll();
                lastDecalPdf = all.filter(isDecalPdf)
                                  .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
            } catch (e) { console.warn('Could not load saved decals PDF:', e); }
        })();

        // ---- html2canvas draws Oswald text a little lower than the browser does when the
        // line-height is tight (like the decals). Measure that error once with a probe, then
        // nudge every text element up by the same amount in the PDF copy only. ----
        async function calibrateTextShift(stage) {
            const samples = [];
            try {
                for (const L of [1, 1.5]) {
                    stage.innerHTML = '';
                    // Wrapper with generous padding so a lower-drawn glyph is never cut off at the canvas edge
                    const probe = document.createElement('div');
                    probe.style.cssText = "display:inline-block;background:#fff;margin:0;padding:80px 20px;";
                    probe.innerHTML = '<div style="color:#000;white-space:nowrap;' +
                        "font-family:'Oswald','Arial Narrow',sans-serif;font-weight:700;font-size:100px;line-height:" + L + ';">' +
                        'H<span style="display:inline-block;width:1px;height:0;"></span></div>';
                    stage.appendChild(probe);
                    await nextFrame();
                    const browserBase = probe.querySelector('span').getBoundingClientRect().bottom - probe.getBoundingClientRect().top;
                    const cv = await html2canvas(probe, { scale: 1, logging: false, backgroundColor: '#ffffff' });
                    const w = cv.width, h = cv.height;
                    const data = cv.getContext('2d').getImageData(0, 0, w, h).data;
                    let last = -1;
                    for (let y = h - 1; y >= 0 && last < 0; y--) {
                        for (let x = 0; x < w; x++) {
                            if (data[(y * w + x) * 4] < 110) { last = y; break; }
                        }
                    }
                    cv.width = 0; cv.height = 0;
                    if (last < 0) throw new Error('probe not drawn');
                    samples.push({ L: L, k: (last + 1 - browserBase) / 100 });
                }
            } catch (e) {
                console.warn('Text shift calibration failed, using none:', e);
                return () => 0;
            } finally {
                stage.innerHTML = '';
            }
            const slope = (samples[1].k - samples[0].k) / (samples[1].L - samples[0].L);
            return (L) => {
                const k = samples[0].k + slope * (L - samples[0].L);
                return (isFinite(k) && Math.abs(k) < 1) ? k : 0;
            };
        }

        function applyTextShift(root, shiftOf) {
            root.querySelectorAll('*').forEach(el => {
                if (!Array.from(el.childNodes).some(n => n.nodeType === 3 && n.nodeValue.trim())) return;
                const cs = getComputedStyle(el);
                const fs = parseFloat(cs.fontSize);
                const lh = parseFloat(cs.lineHeight);
                if (!fs || isNaN(lh)) return;
                const k = shiftOf(lh / fs);
                if (!k) return;
                if (cs.position === 'static') el.style.position = 'relative';
                el.style.top = ((parseFloat(cs.top) || 0) - k * fs) + 'px';
            });
        }

        // Same method as the Planogram Maker: html2canvas + jsPDF, one A4 page at a time
        async function saveToPDF() {
            if (isSavingDecalPdf) return;               // ignore double taps
            if (decals.length === 0) {
                showAlert({
                    title: "No Decals to export",
                    message: "Please add at least one decal to the A4 sheet before saving to PDF.",
                    type: "warning",
                    okText: "Exit"
                });
                return;
            }
            if (typeof html2canvas === "undefined" || !window.jspdf || !window.jspdf.jsPDF) {
                showAlert({
                    title: "PDF library not loaded",
                    message: "html2canvas / jsPDF did not load. Check your internet connection, make sure both decals.html and script.js are updated, then reload the app.",
                    type: "error"
                });
                return;
            }

            isSavingDecalPdf = true;
            const pdfBtn = document.querySelector(".btn-pdf");
            if (pdfBtn) pdfBtn.disabled = true;

            // Hidden off-screen stage: each page is cloned here at real A4 size, so the
            // visible (scaled) preview is never touched.
            const stage = document.createElement("div");
            stage.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;background:#fff;pointer-events:none;";
            document.body.appendChild(stage);

            const filename = 'Temporary Decals by Mark Jake.pdf';
            const sourcePages = Array.from(document.querySelectorAll("#previewContainer .a4-sheet-preview"));
            const pageCount = sourcePages.length;
            const decalCount = decals.length;

            try {
                showToast("Creating PDF...");

                // Make sure the decal fonts are loaded before capturing
                try {
                    await Promise.all([
                        document.fonts.load("700 24px 'Oswald'"),
                        document.fonts.load("600 15px 'Oswald'"),
                        document.fonts.load("500 13px 'Oswald'")
                    ]);
                    await document.fonts.ready;
                } catch (e) {
                    console.warn("Font preload failed, continuing with fallback:", e);
                }

                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });

                const shiftOf = await calibrateTextShift(stage);

                // Capture ONE page at a time to keep memory low
                for (let i = 0; i < pageCount; i++) {
                    showToast(`Creating PDF... page ${i + 1} of ${pageCount}`);
                    await nextFrame();

                    const clone = sourcePages[i].cloneNode(true);
                    clone.style.transform = "none";
                    clone.style.margin = "0";
                    clone.style.border = "none";
                    clone.style.boxShadow = "none";
                    clone.style.breakAfter = "auto";
                    clone.style.pageBreakAfter = "auto";
                    clone.style.background = "#fff";
                    clone.querySelectorAll(".decal-delete-btn").forEach(b => b.parentElement.remove());
                    stage.innerHTML = "";
                    stage.appendChild(clone);
                    await nextFrame();
                    // Names are already auto-fitted; let them draw fully (no clipping) in the PDF copy
                    clone.querySelectorAll('.decal-name').forEach(n => { n.style.overflow = 'visible'; n.style.maxHeight = 'none'; });
                    applyTextShift(clone, shiftOf);
                    await nextFrame();

                    let canvas;
                    try {
                        canvas = await html2canvas(clone, { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff" });
                    } catch (e) {
                        console.warn("Capture at 2x failed, retrying at 1x:", e);
                        canvas = await html2canvas(clone, { scale: 1, useCORS: true, logging: false, backgroundColor: "#ffffff" });
                    }

                    if (i > 0) pdf.addPage("a4", "portrait");
                    pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297, undefined, "FAST");

                    canvas.width = 0;      // free memory right away
                    canvas.height = 0;
                    stage.innerHTML = "";
                    await nextFrame();
                }

                const blob = pdf.output("blob");

                // Keep a copy inside the app first (same IndexedDB as the Planogram Maker's
                // "Saved PDFs" page), so it is saved even if the browser blocks the download
                const rec = {
                    id: 'pdf_' + Date.now(),
                    name: filename,
                    createdAt: Date.now(),
                    size: blob.size,
                    pages: pageCount,
                    tags: decalCount,
                    kind: 'decals',
                    blob: blob
                };
                await pdfStorePut(rec);
                lastDecalPdf = rec;

                try { downloadBlob(blob, filename); } catch (e) { console.warn("Auto-download failed:", e); }

                // PDF is safely stored - clear the sheet so a new one can be started
                saveStateForUndo();
                decals = [];
                renderDecals();

                showToast("PDF saved");
            } catch (err) {
                console.error("PDF Export Error:", err);
                showAlert({
                    title: "Could not create the PDF",
                    message: "Something went wrong while exporting your decals.",
                    detail: "Reason: " + (err && err.message ? err.message : err),
                    type: "error"
                });
            } finally {
                stage.remove();
                isSavingDecalPdf = false;
                if (pdfBtn) pdfBtn.disabled = false;
            }
        }

        // Shrink long custom banners until they fit the space above the price
        function fitCustomBanners() {
            document.querySelectorAll('.decal-savings.custom-fit').forEach(el => {
                let size = el.dataset.fitMax && parseFloat(el.dataset.fitMax) > 100 ? 40 : 24;
                el.style.fontSize = size + 'px';
                const max = parseFloat(el.dataset.fitMax) || 58;
                while (el.scrollHeight > max && size > 8) {
                    size -= 0.5;
                    el.style.fontSize = size + 'px';
                }
            });
        }
        // Product name: shrink the text until the whole name fits in 2 lines (no more cropping)
        function fitDecalNames() {
            document.querySelectorAll('.decal-name').forEach(el => {
                if (el.style.display === 'none') return;
                let size = 15;
                el.style.fontSize = size + 'px';
                while (el.scrollHeight > el.clientHeight + 1 && size > 7) {
                    size -= 0.5;
                    el.style.fontSize = size + 'px';
                }
            });
        }
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fitCustomBanners(); fitDecalNames(); });

        function renderDecals() {
            const previewContainer = document.getElementById('previewContainer');
            const decalCountEl = document.getElementById('decalCount');

            previewContainer.innerHTML = '';
            if (decalCountEl) decalCountEl.textContent = decals.length;
            updateUndoButtonState();

            if (decals.length === 0) {
                previewContainer.innerHTML = `
                    <div class="empty-state decal-empty">
                        <div class="empty-icon">📄</div>
                        <div style="font-weight:700; font-size:14px;">A4 Sheet is Empty</div>
                        <div style="font-size:12px;">Fill out the form to generate 2"x2" decals.</div>
                    </div>`;
                return;
            }

            const pageSize = 15;
            const pages = [];
            for (let i = 0; i < decals.length; i += pageSize) {
                pages.push(decals.slice(i, i + pageSize));
            }

            pages.forEach((pageDecals, pageIndex) => {
                const scaler = document.createElement('div');
                scaler.className = "mobile-scaler";

                const wrapper = document.createElement('div');
                wrapper.className = "preview-wrapper";

                const a4Page = document.createElement('div');
                a4Page.className = "a4-sheet-preview a4-page-container";

                pageDecals.forEach((decal) => {
                    const isCustomPromo = decal.scheme === 'CUSTOMPROMO';
                    const hasPrice = decal.currentPrice !== '';
                    const hasName = decal.name !== '';
                    const bannerOnly = isCustomPromo && !hasPrice;
                    const fitMax = bannerOnly ? (hasName ? 105 : 135) : (hasName ? 58 : 85);
                    const isB1T1orB2T2 = isCustomPromo || decal.scheme === 'B1T1' || decal.scheme === 'B2T2' || 
                                         decal.savings.toUpperCase().includes('BUY 1 TAKE 1') || 
                                         decal.savings.toUpperCase().includes('BUY 2 TAKE 2');

                    const card = document.createElement('div');
                    card.className = "decal-card shadow-sm";
                    card.innerHTML = `
                        <!-- Header Section: Savings Header & Before Price -->
                        <div class="flex justify-between items-start leading-none" ${bannerOnly ? 'style="flex:1 1 auto; align-items:center;"' : ''}>
                            <div class="decal-savings signage-font text-[24px] font-black uppercase text-black tracking-tight pt-0.5${isCustomPromo ? ' custom-fit' : ''}" ${isCustomPromo ? `data-fit-max="${fitMax}" style="width:100%; line-height:1.05; word-break:break-word;${bannerOnly ? ' text-align:center;' : ''}"` : ''}>
                                ${escapeHtml(decal.savings).replace(/\n/g, '<br>')}
                            </div>
                            ${isB1T1orB2T2 ? '' : `
                            <div class="text-right flex flex-col items-end">
                                <span class="signage-font text-[10px] font-bold uppercase tracking-wider text-black">BEFORE</span>
                                <div class="decal-before-price signage-font text-[15px] font-black text-black relative inline-flex items-center gap-0.5">
                                    <span>${decal.symbol}</span>
                                    <span>${decal.oldPrice}</span>
                                    <span class="absolute inset-0 flex items-center justify-center pointer-events-none">
                                        <span class="w-[115%] h-[2px] bg-black rotate-[-22deg] transform"></span>
                                    </span>
                                </div>
                            </div>
                            `}
                        </div>

                        <!-- Center Section: Currency Symbol & Selling Price (peso sign sits right on the price) -->
                        <div class="decal-price-row" ${hasPrice ? '' : 'style="display:none;"'}>
                            <div class="decal-price-inner">
                                <div class="decal-peso signage-font"${isCustomPromo ? ' style="margin-top:6px;"' : ''}>${decal.symbol}</div>
                                <div class="decal-main-price signage-font text-[70px] font-black text-black tracking-tighter leading-none" ${isCustomPromo ? 'style="font-size:56px;"' : ''}>${decal.currentPrice}</div>
                            </div>
                        </div>

                        <!-- Bottom Section: Description & Dates -->
                        <div class="border-t-[1.5px] border-black pt-0.5 flex flex-col gap-0 relative">
                            <div class="decal-name signage-font text-[15px] font-bold text-black tracking-tight uppercase pr-5" ${hasName ? '' : 'style="display:none;"'}>
                                ${escapeHtml(decal.name)}
                            </div>
                            <div class="decal-dates signage-font text-[13px] font-black text-black tracking-tight leading-none mt-0.5">
                                ${escapeHtml(decal.dates)}
                            </div>

                            <!-- Bottom-Right Single-Decal Delete Button -->
                            <div class="absolute bottom-0 right-0 z-20">
                                <button onclick="deleteDecal(${decal.id})" title="Delete this decal" class="decal-delete-btn bg-red-600 hover:bg-red-700 text-white w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center shadow cursor-pointer transition">✕</button>
                            </div>
                        </div>
                    `;
                    a4Page.appendChild(card);
                });

                wrapper.appendChild(a4Page);
                scaler.appendChild(wrapper);
                previewContainer.appendChild(scaler);
            });
            fitCustomBanners();
            fitDecalNames();
        }

        // ================= BARCODE SCANNER + PRODUCT DATABASE LOOKUP =================
        // Same Google Apps Script database used by index.html (script.js).
        // It returns a JSON array: [{ barcode, name, price }, ...]
        const PRODUCT_DB_URL = 'https://script.google.com/macros/s/AKfycbxSAR18eeV9FfooXeTybQro1mdn3r6BnVVhA6WRYgG9RNUGPFmrVpQCIICZp6RT-l4WYw/exec';
        const DB_CACHE_KEY = 'decals_product_db_cache';
        let html5Scanner = null;

        function setScanStatus(msg, color) {
            const el = document.getElementById('scanStatus');
            el.textContent = msg;
            el.style.display = 'block';
            el.style.color = color || 'var(--text-muted)';
        }

        // ---- Same approach as index.html (script.js): fetch once at page load,
        // ---- index by barcode in a hash map, then every scan is an instant O(1) lookup.
        let productsByBarcode = {};   // exact barcode -> product
        let strippedIndex = {};       // barcode without leading zeros -> product
        let productList = [];         // every product, with a lowercase name for keyword search
        let dbLoadPromise = null;

        function buildIndex(list) {
            productsByBarcode = {};
            strippedIndex = {};
            productList = [];
            list.forEach(p => {
                const code = String(p.barcode || '').trim();
                if (!code) return;
                p.barcode = code;
                p.lowerName = String(p.name || '').toLowerCase();
                productList.push(p);
                productsByBarcode[code] = p;
                strippedIndex[code.replace(/^0+/, '')] = p;
            });
        }

        // Turn whatever the database returns into [{barcode, name, price}]
        function normalizeProducts(raw) {
            const list = Array.isArray(raw) ? raw : (raw.data || raw.products || raw.items || raw.result || []);
            return list.map(r => ({
                name: String(r.name ?? '').trim(),
                barcode: String(r.barcode ?? '').trim(),
                price: r.price
            })).filter(p => p.barcode && p.name);
        }

        function loadProductDB() {
            if (dbLoadPromise) return dbLoadPromise;

            // 1) Instant: use the last copy saved on this device while the fresh one downloads
            try {
                const cached = JSON.parse(localStorage.getItem(DB_CACHE_KEY));
                if (Array.isArray(cached) && cached.length) buildIndex(cached);
            } catch (_) {}

            // 2) Fetch fresh copy in the background (exactly like index.html)
            dbLoadPromise = fetch(PRODUCT_DB_URL)
                .then(res => res.json())
                .then(data => {
                    const list = normalizeProducts(data);
                    if (list.length) {
                        buildIndex(list);
                        try { localStorage.setItem(DB_CACHE_KEY, JSON.stringify(list)); } catch (_) {}
                    }
                })
                .catch(e => console.warn('Product DB fetch failed, using cache:', e));
            return dbLoadPromise;
        }

        function findProduct(code) {
            return productsByBarcode[code] || strippedIndex[code.replace(/^0+/, '')] || null;
        }

        async function lookupBarcode(code) {
            code = String(code).trim();
            let hit = findProduct(code);

            // Only wait if nothing is indexed yet (first load, no cache)
            if (!hit && !Object.keys(productsByBarcode).length) {
                setScanStatus('Loading product database...', 'var(--text-muted)');
                await loadProductDB();
                hit = findProduct(code);
            }

            if (hit) {
                document.getElementById('itemName').value = hit.name;
                const price = parseFloat(String(hit.price ?? '').replace(/[^0-9.]/g, ''));
                if (!isNaN(price)) {
                    document.getElementById('oldPrice').value = price.toFixed(2);
                    calculateSavings();
                }
                setScanStatus('Found: ' + hit.name + (!isNaN(price) ? ' - P' + price.toFixed(2) : ''), '#16A34A');
            } else {
                setScanStatus('Barcode ' + code + ' not found in database. Type the name manually.', '#DC2626');
            }
        }

        // ---- Keyword search while typing in the Product Name box (like index.html) ----
        let suggestMatches = [];

        function hideSuggestions() {
            const box = document.getElementById('nameSuggestions');
            box.classList.remove('show');
            box.innerHTML = '';
            suggestMatches = [];
        }

        function searchProducts(query) {
            const words = query.toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.length) return [];
            const out = [];
            for (const p of productList) {
                if (words.every(w => p.lowerName.includes(w) || p.barcode.includes(w))) {
                    out.push(p);
                    if (out.length >= 50) break;
                }
            }
            return out;
        }

        async function runNameSearch() {
            const q = document.getElementById('itemName').value.trim();
            // empty, too short, or a full barcode (handled by scan / Enter): no suggestions
            if (q.length < 2 || /^\d{8,14}$/.test(q)) { hideSuggestions(); return; }

            if (!productList.length) await loadProductDB();   // first load, nothing cached yet
            if (document.getElementById('itemName').value.trim() !== q) return; // user kept typing

            suggestMatches = searchProducts(q);
            const box = document.getElementById('nameSuggestions');
            box.innerHTML = '';
            if (!suggestMatches.length) {
                box.innerHTML = '<div class="suggest-empty">No saved product matches. You can still type the name manually.</div>';
            } else {
                suggestMatches.forEach((p, i) => {
                    const price = parseFloat(String(p.price ?? '').replace(/[^0-9.]/g, ''));
                    const row = document.createElement('div');
                    row.className = 'suggest-item';
                    row.innerHTML = '<span class="suggest-name">' + escapeHtml(p.name) + '</span>' +
                                    '<span class="suggest-price">' + (!isNaN(price) ? 'P' + price.toFixed(2) : '') + '</span>';
                    // 'click' only fires on a real tap, so scrolling the list never picks an item
                    row.addEventListener('mousedown', e => e.preventDefault());   // keep the keyboard open
                    row.addEventListener('click', () => pickProduct(suggestMatches[i]));
                    box.appendChild(row);
                });
            }
            box.classList.add('show');
        }

        function pickProduct(hit) {
            if (!hit) return;
            document.getElementById('itemName').value = hit.name;
            const price = parseFloat(String(hit.price ?? '').replace(/[^0-9.]/g, ''));
            if (!isNaN(price)) {
                document.getElementById('oldPrice').value = price.toFixed(2);
                calculateSavings();
            }
            setScanStatus('Found: ' + hit.name + (!isNaN(price) ? ' - P' + price.toFixed(2) : ''), '#16A34A');
            hideSuggestions();
        }

        (function () {
            let t = null;
            const input = document.getElementById('itemName');
            input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(runNameSearch, 200); });
            input.addEventListener('keydown', e => { if (e.key === 'Escape') hideSuggestions(); });
            document.addEventListener('click', e => {
                if (!e.target.closest('#nameSuggestions') && e.target.id !== 'itemName') hideSuggestions();
            });
        })();

        function openScanner() {
            document.getElementById('scannerModal').style.display = 'flex';
            html5Scanner = new Html5Qrcode('reader');
            html5Scanner.start(
                { facingMode: 'environment' },
                { fps: 15, qrbox: { width: 220, height: 110 }, aspectRatio: 1.0 },
                code => {
                    playScanBeep();
                    closeScanner();
                    lookupBarcode(String(code).trim());
                },
                () => {}
            ).then(() => {
                setTimeout(() => {
                    const videoEl = document.querySelector('#reader video');
                    if (videoEl && videoEl.srcObject) {
                        const track = videoEl.srcObject.getVideoTracks()[0];
                        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
                        if (caps.focusMode) {
                            track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
                        }
                    }
                }, 500);
            }).catch(err => {
                closeScanner();
                setScanStatus('Camera unavailable: allow camera permission and try again. ' + err, '#DC2626');
            });
        }

        function closeScanner() {
            const modal = document.getElementById('scannerModal');
            if (html5Scanner) {
                const sc = html5Scanner; html5Scanner = null;
                sc.stop().then(() => { sc.clear(); modal.style.display = 'none'; })
                         .catch(() => { modal.style.display = 'none'; });
            } else {
                modal.style.display = 'none';
            }
        }
        // Also works with USB/Bluetooth scanners: they type digits + Enter into the name box
        document.getElementById('itemName').addEventListener('keydown', e => {
            if (e.key === 'Enter' && /^\d{8,14}$/.test(e.target.value.trim())) {
                e.preventDefault();
                hideSuggestions();
                lookupBarcode(e.target.value.trim());
            } else if (e.key === 'Enter' && suggestMatches.length) {
                e.preventDefault();
                pickProduct(suggestMatches[0]);
            }
        });

        function escapeHtml(text) {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
            return text.replace(/[&<>"']/g, m => map[m]);
        }

        // Make the functions used by onclick="" / onsubmit="" in decals.html available globally
        window.addDecal = addDecal;
        window.handleSchemeChange = handleSchemeChange;
        window.calculateSavings = calculateSavings;
        window.undoAction = undoAction;
        window.clearAllDecals = clearAllDecals;
        window.saveToPDF = saveToPDF;
        window.shareLastDecalPdf = shareLastDecalPdf;
        window.deleteDecal = deleteDecal;
        window.openScanner = openScanner;
        window.closeScanner = closeScanner;
})();
