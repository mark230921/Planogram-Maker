const GOOGLE_SHEET_API_URL = "https://script.google.com/macros/s/AKfycbxSAR18eeV9FfooXeTybQro1mdn3r6BnVVhA6WRYgG9RNUGPFmrVpQCIICZp6RT-l4WYw/exec";
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
    loadSavedTheme();
    fetchProductsFromGoogleSheet();

    const searchInput = document.getElementById("searchInput");
    const debouncedSearch = debounce((val) => handleSearch(val), 250);
    
    searchInput.addEventListener("input", (e) => {
        debouncedSearch(e.target.value);
    });

    searchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSearch(searchInput.value, true);
        }
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

function fetchProductsFromGoogleSheet() {
    if (!GOOGLE_SHEET_API_URL || GOOGLE_SHEET_API_URL.includes("YOUR_GOOGLE_APPS_SCRIPT")) {
        console.warn("Please specify your Google Apps Script Web App URL.");
        return;
    }

    fetch(GOOGLE_SHEET_API_URL)
        .then(res => res.json())
        .then(data => {
            productsDatabase = {};
            normalizedBarcodeIndex = {};

            if (!Array.isArray(data) || data.length === 0) {
                filteredDbProducts = [];
                renderDatabaseTable();
                return;
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

            // Reverse the array so the last added items appear first in the table
            filteredDbProducts = Object.values(productsDatabase).reverse();
            currentDbPage = 1;
            renderDatabaseTable();
        })
        .catch(err => {
            console.error("Fetch Error:", err);
            document.getElementById("dbTableBody").innerHTML = `<tr><td colspan="4" style="color:red; text-align:center;">Error connecting to Google Sheet API.</td></tr>`;
        });
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
        const itemName = item.name || '';

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

function submitNewPrice() {
    if (!editingBarcode) return;
    const product = productsDatabase[editingBarcode];
    if (!product) {
        closePriceModal();
        return;
    }

    const newPriceInput = document.getElementById("modalNewPriceInput").value;
    const newPrice = formatPriceNumber(newPriceInput);

    productsDatabase[editingBarcode].price = newPrice;
    productsDatabase[editingBarcode].formattedPrice = newPrice;
    
    const currentSearchQuery = document.getElementById("dbSearchInput").value;
    filterDatabaseTable(currentSearchQuery);
    closePriceModal();

    const payload = {
        action: "updatePrice",
        barcode: editingBarcode,
        price: newPrice,
        name: product.name
    };

    fetch(GOOGLE_SHEET_API_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(err => {
        console.error("Background sync error:", err);
    });
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

    delete productsDatabase[barcode];
    const stripped = barcode.replace(/^0+/, '');
    delete normalizedBarcodeIndex[stripped];

    const currentSearchQuery = document.getElementById("dbSearchInput").value;
    filterDatabaseTable(currentSearchQuery);

    const payload = {
        action: "delete",
        barcode: barcode
    };

    fetch(GOOGLE_SHEET_API_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(err => {
        console.error("Background delete error:", err);
    });
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

function saveProductToGoogleSheet(e) {
    e.preventDefault();
    const statusMsg = document.getElementById("statusMsg");
    const saveBtn = document.getElementById("saveDbBtn");

    const barcodeInput = String(document.getElementById("dbBarcode").value).trim();

    if (productsDatabase[barcodeInput]) {
        statusMsg.style.color = "red";
        statusMsg.innerText = `Error: Barcode "${barcodeInput}" already exists in the database!`;
        return;
    }

    saveBtn.disabled = true;
    statusMsg.style.color = "#555";
    statusMsg.innerText = "Saving row to Google Sheet...";

    const storeCode = document.getElementById("dbStoreNo") ? document.getElementById("dbStoreNo").value.trim() : '';
    const categoryCode = document.getElementById("dbCategoryNo") ? document.getElementById("dbCategoryNo").value.trim() : '';
    const locationCode = document.getElementById("dbLocation") ? document.getElementById("dbLocation").value.trim() : '';

    const payload = {
        name: document.getElementById("dbName").value.trim().toUpperCase(),
        price: formatPriceNumber(document.getElementById("dbPrice").value),
        barcode: barcodeInput,
        storeNo: storeCode,
        categoryNo: categoryCode,
        location: locationCode
    };

    fetch(GOOGLE_SHEET_API_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    })
    .then(() => {
        statusMsg.style.color = "green";
        statusMsg.innerText = "Product added successfully to Google Sheet!";
        document.getElementById("dbProductForm").reset();
        saveBtn.disabled = false;

        setTimeout(fetchProductsFromGoogleSheet, 1500);
    })
    .catch(err => {
        console.error(err);
        statusMsg.style.color = "red";
        statusMsg.innerText = "Error saving to Google Sheet.";
        saveBtn.disabled = false;
    });
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

async function loadSavedPdfs(selectId) {
    savedPdfs = (await pdfStoreAll()).sort((a, b) => b.createdAt - a.createdAt);

    if (selectId) {
        activePdfId = selectId;
    } else if (!savedPdfs.some(p => p.id === activePdfId)) {
        activePdfId = savedPdfs.length ? savedPdfs[0].id : null;
    }

    renderPdfList();
    showActivePdf();
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
    if (!shareFile) return;

    const data = {
        files: [shareFile],
        title: shareFile.name,
        text: "Shelf tags PDF"
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
    loadSavedPdfs();
});
