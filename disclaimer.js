// Shared first-time disclaimer modal. Included by index.html, planogram.html and decals.html.
// planogram.html / decals.html: shown once per device (remembered in localStorage).
// index.html (data-disclaimer="always"): shown once each time the app is opened (remembered in
// sessionStorage), so going back to the home page from another page does not show it again.
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

    // Pages with data-disclaimer="always" (index.html) show the modal once per app opening (session).
    const SKEY = "disclaimerShownThisSession";
    function always() {
        return document.body && document.body.getAttribute("data-disclaimer") === "always";
    }
    function shownThisSession() {
        try { return sessionStorage.getItem(SKEY) === "yes"; } catch (_) { return false; }
    }
    function markShownThisSession() {
        try { sessionStorage.setItem(SKEY, "yes"); } catch (_) {}
    }

    function build() {
        if (document.getElementById("disclaimerModal")) return;
        if (always()) {
            if (shownThisSession()) return;
            markShownThisSession();
        } else if (accepted()) return;
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

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
    else build();
})();
