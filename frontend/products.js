(function () {
  const API =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "http://localhost:3000"
      : "https://profile-platform.onrender.com";

  const PRODUCT_STATE = {
    site: "amazon",
    search: "",
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

  function bindDashboardEvents() {
    const siteTabs = document.querySelectorAll("[data-product-site]");
    siteTabs.forEach((button) => {
      button.addEventListener("click", async () => {
        PRODUCT_STATE.site = button.dataset.productSite;
        PRODUCT_STATE.dirtyMap.clear();
        await loadProducts();
      });
    });

    const searchInput = document.getElementById("productSearch");
    if (searchInput) {
      searchInput.addEventListener("input", async (event) => {
        PRODUCT_STATE.search = event.target.value.trim();
        await loadProducts();
      });
    }

    const saveButton = document.getElementById("saveProductPreferencesButton");
    if (saveButton) {
      saveButton.addEventListener("click", saveProductPreferences);
    }
  }

  function renderProducts() {
    const table = document.getElementById("productSelectionTableBody");
    const summary = document.getElementById("productSelectionSummary");
    if (!table) return;

    const rows = PRODUCT_STATE.products.map((product) => getEffectiveProduct(product));
    const selectedCount = rows.filter((row) => row.selected).length;

    if (summary) {
      summary.textContent = `${rows.length} products • ${selectedCount} selected • ${PRODUCT_STATE.site.toUpperCase()}`;
    }

    table.innerHTML = rows
      .map((row) => {
        return `
          <tr data-product-id="${escapeHTML(row.id)}">
            <td>
              <input type="checkbox" class="product-selected-toggle" ${row.selected ? "checked" : ""} />
            </td>
            <td class="product-thumb-cell">
              ${row.image_url ? `<img class="product-thumb" src="${escapeHTML(row.image_url)}" alt="${escapeHTML(row.product_name)}" />` : `<div class="product-thumb product-thumb--empty">No image</div>`}
            </td>
            <td>
              <div class="product-name">${escapeHTML(row.product_name || row.sku)}</div>
              <div class="product-subline">${escapeHTML(row.brand || "")}</div>
            </td>
            <td>${escapeHTML(row.sku)}</td>
            <td>${formatPrice(row.default_max_price)}</td>
            <td>
              <input type="number" step="0.01" min="0" class="product-max-price-input" value="${row.max_price ?? ""}" />
            </td>
            <td>
              <select class="product-run-mode-select">
                <option value="current" ${row.run_mode === "current" ? "selected" : ""}>Current</option>
                <option value="next" ${row.run_mode === "next" ? "selected" : ""}>Next</option>
              </select>
            </td>
          </tr>
        `;
      })
      .join("");

    table.querySelectorAll("tr").forEach((tr) => {
      const productId = tr.dataset.productId;
      const original = PRODUCT_STATE.products.find((item) => item.id === productId);
      if (!original) return;

      const checkbox = tr.querySelector(".product-selected-toggle");
      const modeSelect = tr.querySelector(".product-run-mode-select");
      const priceInput = tr.querySelector(".product-max-price-input");

      const write = () => {
        PRODUCT_STATE.dirtyMap.set(productId, {
          ...getEffectiveProduct(original),
          selected: !!checkbox.checked,
          run_mode: modeSelect.value,
          max_price: priceInput.value === "" ? null : Number(priceInput.value)
        });
      };

      checkbox.addEventListener("change", write);
      modeSelect.addEventListener("change", write);
      priceInput.addEventListener("input", write);
    });
  }

  async function loadProducts() {
    const params = new URLSearchParams({ site: PRODUCT_STATE.site });
    if (PRODUCT_STATE.search) {
      params.set("search", PRODUCT_STATE.search);
    }

    const data = await fetchJSON(API + "/product-catalog?" + params.toString(), {
      headers: authHeaders()
    });

    PRODUCT_STATE.products = data.products || [];
    renderProducts();
  }

  async function saveProductPreferences() {
    const payload = PRODUCT_STATE.products.map((row) => getEffectiveProduct(row)).map((row) => ({
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
