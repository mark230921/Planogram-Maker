// Shared first-time disclaimer modal. Included by index.html, planogram.html and decals.html.
// Shown once per device; the choice is remembered in localStorage.
(function () {
    const KEY = "disclaimerAccepted";

    function accepted() {
        try { return localStorage.getItem(KEY) === "yes"; } catch (_) { return false; }
    }

    window.closeDisclaimer = function () {
        try { localStorage.setItem(KEY, "yes"); } catch (_) {}
        const m = document.getElementById("disclaimerModal");
        if (m) m.style.display = "none";
    };

    // Pages with data-disclaimer="always" (index.html) show the modal on every visit / reopen.
    function always() {
        return document.body && document.body.getAttribute("data-disclaimer") === "always";
    }

    function build() {
        if (document.getElementById("disclaimerModal")) return;
        if (accepted() && !always()) return;
        const m = document.createElement("div");
        m.id = "disclaimerModal";
        m.className = "theme-modal";
        m.innerHTML =
            '<div class="modal-content disclaimer-card" role="alertdialog" aria-modal="true" aria-labelledby="disclaimerTitle">' +
            '<h3 id="disclaimerTitle">Disclaimer</h3>' +
            '<p>Philippine Seven Corporation has no involvement or Responsibility for this app. ' +
            'The app was developed to help store personnel in terms of correction / update the price of shelf tags and decals within store premises.</p>' +
            '<p class="disclaimer-note">&bull; Please don\u2019t alter, remove or change the price in the Product Database inside the app.</p>' +
            '<p class="disclaimer-contact">For more inquiries, you may contact the app developer.<br><strong>\u2013 Mark Jake</strong></p>' +
            '<button type="button" class="btn btn-primary" onclick="closeDisclaimer()">Continue</button>' +
            '</div>';
        document.body.appendChild(m);
        m.style.display = "flex";
    }

    // Also show again when the page is restored from the back/forward cache (e.g. returning from another page)
    window.addEventListener("pageshow", function (e) {
        if (e.persisted && always()) {
            const m = document.getElementById("disclaimerModal");
            if (m) m.style.display = "flex"; else build();
        }
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
    else build();
})();
