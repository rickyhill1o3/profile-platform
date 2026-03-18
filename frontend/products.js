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

    function token() {
        return localStorage.getItem("token");
    }

    function authHeaders() {
        return {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token()
        };
    }

    function formatPrice(value) {
        if (value === null || value === undefined || value === "") return "—";
        const number = Number(value);
        if (!Number.isFinite(number)) return "—";
        return "$" + number.toFixed(2);
    }

    function isAdminRole(role) {
        return role === "admin" || role === "super_admin";
    }

    function currentUser() {
        try {
            return JSON.parse(localStorage.getItem("user") || "null");
        } catch {
            return null;
        }
    }

    async function fetchJSON(url, options) {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!res.ok || data.error) {
            throw new Error(data.error || "Request failed");
        }
        return data;
    }

    function escapeHTML(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getEffectiveProduct(row) {
        return PRODUCT_STATE.dirtyMap.get(row.id) || row;
    }

    function normalizeText(value) {
        return String(value || "").toLowerCase();
    }

    function categoryFromProduct(row) {
        const name = normalizeText(row.product_name);
        const brand = normalizeText(row.brand);
        const combined = `${name} ${brand}`;

        if (
            combined.includes("pokemon") ||
            combined.includes("pokémon") ||
            combined.includes("scarlet") ||
            combined.includes("violet") ||
            combined.includes("elite trainer box") ||
            combined.includes("booster bundle")
        ) {
            return "Pokémon Cards";
        }

        if (
            combined.includes("one piece") ||
            combined.includes("romance dawn") ||
            combined.includes("paramount war") ||
            combined.includes("op-0") ||
            combined.includes("op-1") ||
            combined.includes("op-2") ||
            combined.includes("op-3") ||
            combined.includes("op-4") ||
            combined.includes("op-5") ||
            combined.includes("op-6") ||
            combined.includes("op-7") ||
            combined.includes("op-8") ||
            combined.includes("op-9")
        ) {
            return "One Piece Cards";
        }

        if (
            combined.includes("magic") ||
            combined.includes("mtg") ||
            combined.includes("commander") ||
            combined.includes("collector booster") ||
            combined.includes("play booster") ||
            combined.includes("wizard of the coast")
        ) {
            return "Magic Cards";
        }

        if (
            combined.includes("yu-gi-oh") ||
            combined.includes("yugioh") ||
            combined.includes("konami")
        ) {
            return "Yu-Gi-Oh Cards";
        }

        if (
            combined.includes("lorcana") ||
            combined.includes("ravensburger")
        ) {
            return "Lorcana";
        }

        if (
            combined.includes("sports card") ||
            combined.includes("panini") ||
            combined.includes("topps") ||
            combined.includes("prizm") ||
            combined.includes("optic") ||
            combined.includes("select football") ||
            combined.includes("basketball blaster")
        ) {
            return "Sports Cards";
        }

        if (
            combined.includes("ps5") ||
            combined.includes("playstation") ||
            combined.includes("xbox") ||
            combined.includes("nintendo") ||
            combined.includes("switch") ||
            combined.includes("controller") ||
            combined.includes("headset") ||
            combined.includes("gpu") ||
            combined.includes("ssd") ||
            combined.includes("monitor") ||
            combined.includes("laptop") ||
            combined.includes("ipad") ||
            combined.includes("tablet") ||
            combined.includes("iphone") ||
            combined.includes("airpods") ||
            combined.includes("tv")
        ) {
            return "Electronics";
        }

        if (
            combined.includes("lego") ||
            combined.includes("funko") ||
            combined.includes("collectible") ||
            combined.includes("figure") ||
            combined.includes("action figure")
        ) {
            return "Collectibles";
        }

        if (
            combined.includes("binder") ||
            combined.includes("sleeve") ||
            combined.includes("top loader") ||
            combined.includes("deck box") ||
            combined.includes("storage box")
        ) {
            return "Accessories";
        }

        if (
            combined.includes("game") ||
            combined.includes("video game")
        ) {
            return "Gaming";
        }

        return "Other";
    }

    function groupProducts(rows) {
        const groups = new Map();

        rows.forEach((row) => {
            const category = categoryFromProduct(row);
            if (!groups.has(category)) {
                groups.set(category, []);
            }
            groups.get(category).push(row);
        });

        return [...groups.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([category, items]) => ({
                category,
                items: items.sort((x, y) => {
                    const ax = (x.product_name || x.sku || "").toLowerCase();
                    const by = (y.product_name || y.sku || "").toLowerCase();
                    return ax.localeCompare(by);
                })
            }));
    }

    function filteredProducts() {
        const rows = PRODUCT_STATE.products.map((product) => getEffectiveProduct(product));
        const search = normalizeText(PRODUCT_STATE.search);

        return rows.filter((row) => {
            if (PRODUCT_STATE.selectedOnly && !row.selected) return false;

            const category = categoryFromProduct(row);
            if (PRODUCT_STATE.activeCategory !== "all" && category !== PRODUCT_STATE.activeCategory) {
                return false;
            }

            if (!search) return true;

            const haystack = `${row.product_name || ""} ${row.brand || ""} ${row.sku || ""}`.toLowerCase();
            return haystack.includes(search);
        });
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
        const allCount = rows.length;

        chipWrap.innerHTML = `
      <button type="button" class="product-category-chip ${PRODUCT_STATE.activeCategory === "all" ? "is-active" : ""}" data-category="all">
        All (${allCount})
      </button>
      ${categories
                .map(
                    ([category, count]) => `
            <button type="button" class="product-category-chip ${PRODUCT_STATE.activeCategory === category ? "is-active" : ""}" data-category="${escapeHTML(category)}">
              ${escapeHTML(category)} (${count})
            </button>
          `
                )
                .join("")}
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
      <article class="product-select-card ${row.selected ? "is-selected" : ""}" data-product-id="${escapeHTML(row.id)}">
        ${row.image_url
                ? `<img class="product-thumb" src="${escapeHTML(row.image_url)}" alt="${escapeHTML(row.product_name || row.sku)}" />`
                : `<div class="product-thumb product-thumb--empty">No image</div>`
            }

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

            <button type="button" class="product-action-button product-toggle-button ${row.selected ? "is-selected" : ""}">
              ${row.selected ? "Selected" : "Select"}
            </button>
          </div>

          <div class="product-card-controls">
            <div class="product-control">
              <label>Default max</label>
              <input type="text" value="${escapeHTML(formatPrice(row.default_max_price))}" disabled />
            </div>

            <div class="product-control">
              <label>Your max</label>
              <input type="number" step="0.01" min="0" class="product-max-price-input" value="${row.max_price ?? ""}" />
            </div>

            <div class="product-control">
              <label>Run mode</label>
              <select class="product-run-mode-select">
                <option value="current" ${row.run_mode === "current" ? "selected" : ""}>Current</option>
                <option value="next" ${row.run_mode === "next" ? "selected" : ""}>Next</option>
              </select>
            </div>
          </div>
        </div>
      </article>
    `;
    }

    function attachProductCardEvents() {
        document.querySelectorAll(".product-select-card").forEach((card) => {
            const productId = card.dataset.productId;
            const original = PRODUCT_STATE.products.find((item) => item.id === productId);
            if (!original) return;

            const toggleButton = card.querySelector(".product-toggle-button");
            const modeSelect = card.querySelector(".product-run-mode-select");
            const priceInput = card.querySelector(".product-max-price-input");

            const write = (patch = {}) => {
                PRODUCT_STATE.dirtyMap.set(productId, {
                    ...getEffectiveProduct(original),
                    selected: !!(patch.selected ?? getEffectiveProduct(original).selected),
                    run_mode: patch.run_mode ?? modeSelect.value,
                    max_price:
                        patch.max_price !== undefined
                            ? patch.max_price
                            : priceInput.value === ""
                                ? null
                                : Number(priceInput.value)
                });
                renderProducts();
            };

            toggleButton.addEventListener("click", () => {
                const current = getEffectiveProduct(original);
                write({ selected: !current.selected });
            });

            modeSelect.addEventListener("change", () => {
                const current = getEffectiveProduct(original);
                write({
                    selected: current.selected,
                    run_mode: modeSelect.value,
                    max_price: priceInput.value === "" ? null : Number(priceInput.value)
                });
            });

            priceInput.addEventListener("input", () => {
                const current = getEffectiveProduct(original);
                write({
                    selected: current.selected,
                    run_mode: modeSelect.value,
                    max_price: priceInput.value === "" ? null : Number(priceInput.value)
                });
            });
        });
    }

    function renderProducts() {
        const list = document.getElementById("productSelectionTableBody");
        const summary = document.getElementById("productSelectionSummary");
        if (!list) return;

        renderCategoryChips(PRODUCT_STATE.products.map((product) => getEffectiveProduct(product)));

        const rows = filteredProducts();
        const selectedCount = PRODUCT_STATE.products
            .map((product) => getEffectiveProduct(product))
            .filter((row) => row.selected).length;

        if (summary) {
            summary.textContent = `${PRODUCT_STATE.site.toUpperCase()} • ${rows.length} shown • ${selectedCount} selected`;
        }

        if (!rows.length) {
            list.innerHTML = `
        <div class="product-empty-state">
          <h3>No products found</h3>
          <p>Try a different category, change your search, or turn off “Selected only.”</p>
        </div>
      `;
            return;
        }

        const grouped = groupProducts(rows);

        list.innerHTML = grouped
            .map(
                (group) => `
          <section class="product-category-block">
            <div class="product-category-header">
              <div>
                <h3 class="product-category-title">${escapeHTML(group.category)}</h3>
                <div class="product-category-count">${group.items.length} products</div>
              </div>
            </div>
            <div class="product-card-grid">
              ${group.items.map((row) => productCardMarkup(row)).join("")}
            </div>
          </section>
        `
            )
            .join("");

        attachProductCardEvents();
        updateActiveTabState();
    }

    function updateActiveTabState() {
        document.querySelectorAll("[data-product-site]").forEach((button) => {
            button.classList.toggle("is-active", button.dataset.productSite === PRODUCT_STATE.site);
        });
    }

    function bindDashboardEvents() {
        const siteTabs = document.querySelectorAll("[data-product-site]");
        siteTabs.forEach((button) => {
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
        if (searchInput) {
            searchInput.addEventListener("input", (event) => {
                PRODUCT_STATE.search = event.target.value.trim();
                renderProducts();
            });
        }

        const selectedOnlyInput = document.getElementById("productSelectedOnly");
        if (selectedOnlyInput) {
            selectedOnlyInput.addEventListener("change", (event) => {
                PRODUCT_STATE.selectedOnly = !!event.target.checked;
                renderProducts();
            });
        }

        const saveButton = document.getElementById("saveProductPreferencesButton");
        if (saveButton) {
            saveButton.addEventListener("click", saveProductPreferences);
        }
    }

    async function loadProducts() {
        const params = new URLSearchParams({ site: PRODUCT_STATE.site });

        const data = await fetchJSON(API + "/product-catalog?" + params.toString(), {
            headers: authHeaders()
        });

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
            body: JSON.stringify({
                site: PRODUCT_STATE.site,
                preferences: payload
            })
        });

        const message = document.getElementById("productSaveMessage");
        if (message) {
            message.textContent = `Saved ${saveResult.updated} preferences.`;
        }

        PRODUCT_STATE.dirtyMap.clear();
        await loadProducts();
    }

    async function loadAdminSelections() {
        const section = document.getElementById("adminProductSelectionsSection");
        const tableBody = document.getElementById("adminProductSelectionsTableBody");
        const detailBody = document.getElementById("adminUserProductDetailBody");
        if (!section || !tableBody) return;

        const user = currentUser();
        if (!isAdminRole(user?.role)) {
            section.style.display = "none";
            return;
        }

        section.style.display = "block";

        const data = await fetchJSON(API + "/admin/product-preferences", {
            headers: authHeaders()
        });

        tableBody.innerHTML = (data.items || [])
            .map((row) => {
                return `
          <tr data-user-id="${escapeHTML(row.user_id)}">
            <td>${escapeHTML(row.user_email)}</td>
            <td>${escapeHTML(row.site)}</td>
            <td>${escapeHTML(row.product_name)}</td>
            <td>${escapeHTML(row.sku)}</td>
            <td>${escapeHTML(row.run_mode)}</td>
            <td>${formatPrice(row.max_price)}</td>
            <td><button class="open-admin-user-products-button">Open user</button></td>
          </tr>
        `;
            })
            .join("");

        tableBody.querySelectorAll(".open-admin-user-products-button").forEach((button) => {
            button.addEventListener("click", async (event) => {
                const tr = event.target.closest("tr");
                const userId = tr?.dataset.userId;
                if (!userId || !detailBody) return;

                const detail = await fetchJSON(API + `/admin/users/${userId}/product-preferences`, {
                    headers: authHeaders()
                });

                detailBody.innerHTML = (detail.items || [])
                    .map((row) => {
                        return `
              <tr>
                <td>${escapeHTML(row.product.site)}</td>
                <td>${escapeHTML(row.product.product_name || row.product.sku)}</td>
                <td>${escapeHTML(row.product.sku)}</td>
                <td>${escapeHTML(row.run_mode)}</td>
                <td>${formatPrice(row.max_price)}</td>
              </tr>
            `;
                    })
                    .join("");
            });
        });
    }

    document.addEventListener("DOMContentLoaded", async () => {
        try {
            if (document.getElementById("productSelectionTableBody")) {
                bindDashboardEvents();
                await loadProducts();
            }

            if (document.getElementById("adminProductSelectionsTableBody")) {
                await loadAdminSelections();
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