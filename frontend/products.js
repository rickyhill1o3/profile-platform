
(function () {
    const API =
        window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
            ? "http://localhost:3000"
            : "https://profile-platform.onrender.com";

    const PRODUCT_STATE = {
        site: "amazon",
        search: "",
        selectedOnly: false,
        activeCategory: "all",
        products: [],
        dirtyMap: new Map()
    };

    function token() { return localStorage.getItem("token"); }
    function authHeaders() { return { "Content-Type": "application/json", Authorization: "Bearer " + token() }; }
    function currentUser() { try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; } }
    function isAdminRole(role) { return role === "admin" || role === "super_admin"; }

    async function fetchJSON(url, options) {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || "Request failed");
        return data;
    }

    function escapeHTML(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function formatPrice(value) {
        if (value === null || value === undefined || value === "") return "—";
        const number = Number(value);
        if (!Number.isFinite(number)) return "—";
        return "$" + number.toFixed(2);
    }

    function getEffectiveProduct(row) {
        return PRODUCT_STATE.dirtyMap.get(row.id) || row;
    }

    function normalizeText(value) {
        return String(value || "").toLowerCase();
    }

    function categoryFromProduct(row) {
        if (row && row.metadata && row.metadata.virtual) return 'Next Release';
        const text = `${normalizeText(row.product_name)} ${normalizeText(row.brand)} ${normalizeText(row.sku)}`;

        if (text.includes("pokemon") || text.includes("pokémon") || text.includes("scarlet") || text.includes("violet") || text.includes("elite trainer") || text.includes("booster bundle")) return "Pokemon";
        if (text.includes("one piece") || /\bop[- ]?\d+/i.test(text) || text.includes("romance dawn") || text.includes("paramount war")) return "One Piece";
        if (text.includes("magic") || text.includes("mtg") || text.includes("commander") || text.includes("collector booster") || text.includes("play booster") || text.includes("wizards of the coast")) return "Magic";
        if (text.includes("camera") || text.includes("canon") || text.includes("nikon") || text.includes("sony alpha") || text.includes("gopro")) return "Cameras";
        if (text.includes("electronics") || text.includes("iphone") || text.includes("ipad") || text.includes("airpods") || text.includes("ssd") || text.includes("gpu") || text.includes("monitor") || text.includes("tv") || text.includes("playstation") || text.includes("ps5") || text.includes("xbox") || text.includes("switch")) return "Electronics";
        if (text.includes("lorcana")) return "Lorcana";
        if (text.includes("yugioh") || text.includes("yu-gi-oh") || text.includes("konami")) return "Yu-Gi-Oh";
        if (text.includes("panini") || text.includes("topps") || text.includes("prizm") || text.includes("optic")) return "Sports Cards";
        if (text.includes("sleeve") || text.includes("binder") || text.includes("top loader") || text.includes("deck box")) return "Accessories";
        return "Other";
    }

    function filteredProducts() {
        const rows = PRODUCT_STATE.products.map((p) => getEffectiveProduct(p));
        const search = normalizeText(PRODUCT_STATE.search);

        return rows.filter((row) => {
            const category = categoryFromProduct(row);
            if (PRODUCT_STATE.selectedOnly && !row.selected) return false;
            if (PRODUCT_STATE.activeCategory !== "all" && PRODUCT_STATE.activeCategory !== category) return false;
            if (!search) return true;
            const haystack = `${row.product_name || ""} ${row.brand || ""} ${row.sku || ""}`.toLowerCase();
            return haystack.includes(search);
        });
    }

    function groupProducts(rows) {
        const groups = new Map();
        rows.forEach((row) => {
            const category = categoryFromProduct(row);
            if (!groups.has(category)) groups.set(category, []);
            groups.get(category).push(row);
        });
        return [...groups.entries()]
            .sort((a, b) => { if (a[0] === 'Next Release') return -1; if (b[0] === 'Next Release') return 1; return a[0].localeCompare(b[0]); })
            .map(([category, items]) => ({
                category,
                items: items.sort((x, y) => (x.product_name || x.sku || "").localeCompare(y.product_name || y.sku || ""))
            }));
    }

    function renderCategoryChips(rows) {
        const chipWrap = document.getElementById("productCategoryChips");
        if (!chipWrap) return;
        const counts = new Map();
        rows.forEach((row) => {
            const category = categoryFromProduct(row);
            counts.set(category, (counts.get(category) || 0) + 1);
        });
        const categories = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        chipWrap.innerHTML = `
      <button type="button" class="chip ${PRODUCT_STATE.activeCategory === "all" ? "is-active" : ""}" data-category="all">All (${rows.length})</button>
      ${categories.map(([category, count]) => `
        <button type="button" class="chip ${PRODUCT_STATE.activeCategory === category ? "is-active" : ""}" data-category="${escapeHTML(category)}">${escapeHTML(category)} (${count})</button>
      `).join("")}
    `;
        chipWrap.querySelectorAll("[data-category]").forEach((button) => {
            button.addEventListener("click", () => {
                PRODUCT_STATE.activeCategory = button.dataset.category || "all";
                renderProducts();
            });
        });
    }

    function productCardMarkup(row) {
        return `
      <article class="product-select-card ${row.selected ? "is-selected" : ""}" data-product-id="${escapeHTML(row.id)}" data-category="${escapeHTML(categoryFromProduct(row))}">
        ${row.image_url ? `<img class="product-thumb" src="${escapeHTML(row.image_url)}" alt="${escapeHTML(row.product_name || row.sku)}" />` : `<div class="product-thumb product-thumb--empty">No image</div>`}
        <div class="product-card-content">
          <div class="product-card-header">
            <div>
              <h3 class="product-card-title">${escapeHTML(row.product_name || row.sku)}</h3>
              <div class="product-card-meta">
                ${row.brand ? `<span class="product-pill">${escapeHTML(row.brand)}</span>` : ""}
                <span class="product-pill">${escapeHTML(categoryFromProduct(row))}</span>
                <span class="product-pill">${escapeHTML(PRODUCT_STATE.site.toUpperCase())}</span>
              </div>
              <div class="product-sku">SKU: ${escapeHTML(row.sku)}</div>
            </div>
            <button type="button" class="btn product-toggle-button ${row.selected ? "is-selected" : ""}">
              ${row.selected ? "Selected" : "Select"}
            </button>
          </div>

          <div class="product-card-controls">
            <div class="product-control">
              <label>Default max</label>
              <input type="text" class="input" value="${escapeHTML(formatPrice(row.default_max_price))}" disabled />
            </div>
            <div class="product-control">
              <label>Your max</label>
              <input type="number" class="input product-max-price-input" step="0.01" min="0" value="${row.max_price ?? ""}" />
            </div>
            <div class="product-control">
              <label>Run mode</label>
              <select class="input product-run-mode-select">
                <option value="current" ${row.run_mode === "current" ? "selected" : ""}>Current</option>
                <option value="next" ${row.run_mode === "next" ? "selected" : ""}>Next</option>
              </select>
            </div>
          </div>
        </div>
      </article>
    `;
    }

    function writeProductState(original, productId, patch) {
        PRODUCT_STATE.dirtyMap.set(productId, {
            ...getEffectiveProduct(original),
            ...patch
        });
    }

    function applyCategorySelection(category, selected) {
        PRODUCT_STATE.products.forEach((product) => {
            const row = getEffectiveProduct(product);
            if (categoryFromProduct(row) === category) {
                writeProductState(product, product.id, { selected });
            }
        });
        renderProducts();
    }

    function attachProductCardEvents() {
        document.querySelectorAll(".product-category-action").forEach((button) => {
            button.addEventListener("click", () => {
                applyCategorySelection(button.dataset.category, button.dataset.action === "select");
            });
        });

        document.querySelectorAll(".product-select-card").forEach((card) => {
            const productId = card.dataset.productId;
            const original = PRODUCT_STATE.products.find((item) => item.id === productId);
            if (!original) return;
            const toggleButton = card.querySelector(".product-toggle-button");
            const modeSelect = card.querySelector(".product-run-mode-select");
            const priceInput = card.querySelector(".product-max-price-input");

            const write = (patch = {}) => {
                writeProductState(original, productId, {
                    selected: patch.selected ?? getEffectiveProduct(original).selected,
                    run_mode: patch.run_mode ?? modeSelect.value,
                    max_price: patch.max_price !== undefined ? patch.max_price : (priceInput.value === "" ? null : Number(priceInput.value))
                });
                renderProducts();
            };

            toggleButton.addEventListener("click", () => write({ selected: !getEffectiveProduct(original).selected }));
            modeSelect.addEventListener("change", () => write({ selected: getEffectiveProduct(original).selected, run_mode: modeSelect.value }));
            priceInput.addEventListener("input", () => write({ selected: getEffectiveProduct(original).selected, max_price: priceInput.value === "" ? null : Number(priceInput.value) }));
        });
    }

    function renderProducts() {
        const list = document.getElementById("productSelectionTableBody");
        const summary = document.getElementById("productSelectionSummary");
        if (!list) return;

        renderCategoryChips(PRODUCT_STATE.products.map((p) => getEffectiveProduct(p)));
        const rows = filteredProducts();
        const selectedCount = PRODUCT_STATE.products.map((p) => getEffectiveProduct(p)).filter((row) => row.selected).length;

        if (summary) summary.textContent = `${PRODUCT_STATE.site.toUpperCase()} • ${rows.length} shown • ${selectedCount} selected`;

        if (!rows.length) {
            list.innerHTML = `<div class="product-empty-state"><h3>No products found</h3><p>Try another category or search.</p></div>`;
            return;
        }

        const grouped = groupProducts(rows);
        list.innerHTML = grouped.map((group) => `
      <section class="product-category-block">
        <div class="product-category-header">
          <div>
            <h3 class="product-category-title">${escapeHTML(group.category)}</h3>
            <div class="product-category-count">${group.items.length} products</div>
          </div>
          <div class="category-actions">
            <button type="button" class="btn product-category-action" data-category="${escapeHTML(group.category)}" data-action="select">Select All</button>
            <button type="button" class="btn product-category-action" data-category="${escapeHTML(group.category)}" data-action="clear">Clear</button>
          </div>
        </div>
        <div class="product-card-grid">${group.items.map((row) => productCardMarkup(row)).join("")}</div>
      </section>
    `).join("");

        attachProductCardEvents();
        document.querySelectorAll("[data-product-site]").forEach((button) => {
            button.classList.toggle("is-active", button.dataset.productSite === PRODUCT_STATE.site);
        });
    }

    function bindDashboardEvents() {
        document.querySelectorAll("[data-product-site]").forEach((button) => {
            button.addEventListener("click", async () => {
                PRODUCT_STATE.site = button.dataset.productSite;
                PRODUCT_STATE.search = "";
                PRODUCT_STATE.selectedOnly = false;
                PRODUCT_STATE.activeCategory = "all";
                PRODUCT_STATE.dirtyMap.clear();
                const searchInput = document.getElementById("productSearch");
                const selectedOnlyInput = document.getElementById("productSelectedOnly");
                if (searchInput) searchInput.value = "";
                if (selectedOnlyInput) selectedOnlyInput.checked = false;
                await loadProducts();
            });
        });

        const searchInput = document.getElementById("productSearch");
        if (searchInput) searchInput.addEventListener("input", (event) => { PRODUCT_STATE.search = event.target.value.trim(); renderProducts(); });

        const selectedOnlyInput = document.getElementById("productSelectedOnly");
        if (selectedOnlyInput) selectedOnlyInput.addEventListener("change", (event) => { PRODUCT_STATE.selectedOnly = !!event.target.checked; renderProducts(); });

        const saveButton = document.getElementById("saveProductPreferencesButton");
        if (saveButton) saveButton.addEventListener("click", saveProductPreferences);
    }

    async function loadProducts() {
        const data = await fetchJSON(API + "/product-catalog?site=" + PRODUCT_STATE.site, { headers: authHeaders() });
        PRODUCT_STATE.products = data.products || [];
        renderProducts();
    }

    async function saveProductPreferences() {
        const payload = PRODUCT_STATE.products
            .map((row) => getEffectiveProduct(row))
            .map((row) => ({
                catalog_product_id: row.id,
                selected: !!row.selected,
                run_mode: row.run_mode,
                max_price: row.max_price
            }));

        const saveResult = await fetchJSON(API + "/product-preferences", {
            method: "PUT",
            headers: authHeaders(),
            body: JSON.stringify({ site: PRODUCT_STATE.site, preferences: payload })
        });

        const message = document.getElementById("productSaveMessage");
        if (message) message.textContent = `Saved ${saveResult.updated} preferences.`;
        PRODUCT_STATE.dirtyMap.clear();
        await loadProducts();
    }

    async function loadAdminSelections() {
        const section = document.getElementById("adminProductSelectionsSection");
        const userSelect = document.getElementById("adminProductUserSelect");
        const loadButton = document.getElementById("adminLoadUserProductsButton");
        const detailBody = document.getElementById("adminUserProductDetailBody");
        const message = document.getElementById("adminProductSelectionsMessage");
        const summary = document.getElementById("adminSelectedUserSummary");
        const countdownWrap = document.getElementById("adminSelectedUserCountdowns");
        const countdownList = document.getElementById("adminCountdownSelectionList");
        const countdownUsersTitle = document.getElementById("adminCountdownUsersTitle");
        const countdownUsersList = document.getElementById("adminCountdownUsersList");

        if (!section || !userSelect || !detailBody) return;
        const user = currentUser();
        if (!isAdminRole(user?.role)) { section.style.display = "none"; return; }
        section.style.display = "block";

        const data = await fetchJSON(API + "/admin/product-preferences", { headers: authHeaders() });
        const items = Array.isArray(data.items) ? data.items : [];
        const users = (Array.isArray(data.items) ? data.items : []).sort(
            (a, b) => (a.user_email || "").localeCompare(b.user_email || "")
        );

        userSelect.innerHTML =
            `<option value="">Select a user</option>` +
            users.map((entry) =>
                `<option value="${escapeHTML(entry.user_id)}">${escapeHTML(entry.user_email)} (${Number(entry.selection_count || 0)})</option>`
            ).join("");

        if (!users.length) {
            if (message) message.textContent = "No users have selected products or countdown releases yet.";
            detailBody.innerHTML = `<tr><td colspan="5">No saved product or countdown selections yet.</td></tr>`;
            if (countdownList) countdownList.innerHTML = `<div class="subtle-text">No countdown releases found.</div>`;
            if (countdownUsersTitle) countdownUsersTitle.textContent = "Select a countdown to see the users.";
            if (countdownUsersList) countdownUsersList.innerHTML = `<div class="subtle-text">No countdown selected.</div>`;
            return;
        }

        async function loadSelectedUserProducts() {
            const userId = userSelect.value;
            if (!userId) {
                if (message) message.textContent = "Choose a user first.";
                if (summary) summary.textContent = "";
                if (countdownWrap) countdownWrap.innerHTML = '';
                detailBody.innerHTML = `<tr><td colspan="5">Choose a user to view product selections.</td></tr>`;
                return;
            }

            const selectedUser = users.find((entry) => entry.user_id === userId);
            if (summary && selectedUser) summary.textContent = selectedUser.selection_count > 0 ? `${selectedUser.user_email} • ${selectedUser.selection_count} selected products` : `${selectedUser.user_email} • countdown selections only`;

            const detail = await fetchJSON(API + `/admin/users/${userId}/product-preferences`, { headers: authHeaders() });
            const rows = Array.isArray(detail.items) ? detail.items : [];
            const countdowns = Array.isArray(detail.countdown_selections) ? detail.countdown_selections : [];

            if (countdownWrap) {
                if (countdowns.length) {
                    countdownWrap.innerHTML = countdowns.map((item) => `<span class="selection-chip">${escapeHTML(item.label || item.site || 'Release')} • ${escapeHTML(item.when_label || '')}</span>`).join('');
                } else {
                    countdownWrap.innerHTML = `<span class="selection-chip selection-chip--empty">No countdown releases selected.</span>`;
                }
            }

            if (!rows.length) {
                detailBody.innerHTML = `<tr><td colspan="5">This user has no saved product selections.</td></tr>`;
                if (message) message.textContent = countdowns.length ? "This user selected countdown releases but no products." : "";
                return;
            }

            detailBody.innerHTML = rows.map((row) => `
        <tr>
          <td>${escapeHTML(row.product.site)}</td>
          <td>${escapeHTML(row.product.product_name || row.product.sku)}</td>
          <td>${escapeHTML(row.product.sku)}</td>
          <td>${escapeHTML(row.run_mode)}</td>
          <td>${formatPrice(row.max_price)}</td>
        </tr>
      `).join("");
            if (message) message.textContent = "";
        }

        if (loadButton) loadButton.onclick = loadSelectedUserProducts;
        userSelect.onchange = () => { if (message) message.textContent = ""; loadSelectedUserProducts().catch((err) => { if (message) message.textContent = err.message; }); };
        detailBody.innerHTML = `<tr><td colspan="5">Choose a user to view product selections.</td></tr>`;
    }


    async function loadCountdownUserList() {
        const countdownList = document.getElementById("adminCountdownSelectionList");
        const countdownUsersTitle = document.getElementById("adminCountdownUsersTitle");
        const countdownUsersList = document.getElementById("adminCountdownUsersList");
        if (!countdownList || !countdownUsersTitle || !countdownUsersList) return;

        try {
            const data = await fetchJSON(API + "/admin/countdowns/selection-summary", { headers: authHeaders() });
            const items = Array.isArray(data.items) ? data.items : [];
            if (!items.length) {
                countdownList.innerHTML = `<div class="subtle-text">No countdown releases found.</div>`;
                countdownUsersTitle.textContent = "Select a countdown to see the users.";
                countdownUsersList.innerHTML = `<div class="subtle-text">No countdown selected.</div>`;
                return;
            }

            countdownList.innerHTML = items.map((item) => `
                <button type="button" class="countdown-list-item" data-countdown-id="${escapeHTML(item.id)}">
                    <span><strong>${escapeHTML(item.label || item.site || 'Release')}</strong><small>${escapeHTML(item.when_label || '')}</small></span>
                    <span class="badge">${Number(item.selected_users || 0)}</span>
                </button>
            `).join('');

            const buttons = countdownList.querySelectorAll('[data-countdown-id]');
            buttons.forEach((btn) => {
                btn.addEventListener('click', async () => {
                    buttons.forEach((b) => b.classList.remove('is-active'));
                    btn.classList.add('is-active');
                    const countdownId = btn.getAttribute('data-countdown-id');
                    countdownUsersTitle.textContent = 'Loading users...';
                    countdownUsersList.innerHTML = `<div class="subtle-text">Loading users...</div>`;
                    try {
                        const detail = await fetchJSON(API + `/admin/countdowns/${countdownId}/users`, { headers: authHeaders() });
                        const users = Array.isArray(detail.users) ? detail.users : [];
                        countdownUsersTitle.textContent = `${detail.countdown?.label || detail.countdown?.name || detail.countdown?.site || 'Release'} • ${detail.countdown?.when_label || ''}`;
                        if (!users.length) {
                            countdownUsersList.innerHTML = `<div class="subtle-text">No users have selected this countdown.</div>`;
                            return;
                        }
                        countdownUsersList.innerHTML = users.map((row) => `
                            <div class="countdown-user-row">
                                <strong>${escapeHTML(row.email || row.id)}</strong>
                                <span class="subtle-text">${escapeHTML(row.selected_at_label || '')}</span>
                            </div>
                        `).join('');
                    } catch (err) {
                        countdownUsersTitle.textContent = 'Select a countdown to see the users.';
                        countdownUsersList.innerHTML = `<div class="error-text">${escapeHTML(err.message)}</div>`;
                    }
                });
            });

            countdownUsersTitle.textContent = 'Select a countdown to see the users.';
            countdownUsersList.innerHTML = `<div class="subtle-text">No countdown selected.</div>`;
        } catch (err) {
            countdownList.innerHTML = `<div class="error-text">${escapeHTML(err.message)}</div>`;
        }
    }

    document.addEventListener("DOMContentLoaded", async () => {
        try {
            if (document.getElementById("productSelectionTableBody")) {
                bindDashboardEvents();
                await loadProducts();
            }
            if (document.getElementById("adminProductSelectionsSection")) {
                await loadAdminSelections();
                await loadCountdownUserList();
            }
        } catch (err) {
            const dashboardMessage = document.getElementById("productSaveMessage");
            const adminMessage = document.getElementById("adminProductSelectionsMessage");
            if (dashboardMessage) dashboardMessage.textContent = err.message;
            if (adminMessage) adminMessage.textContent = err.message;
            console.error(err);
        }
    });
})();
