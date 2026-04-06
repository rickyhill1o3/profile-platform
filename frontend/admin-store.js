(function () {
  const panes = Array.from(document.querySelectorAll('[data-store-pane]'));
  const navButtons = Array.from(document.querySelectorAll('[data-store-nav]'));
  const state = {
    products: [],
    receipts: [],
    overrides: [],
    accounting: null
  };

  function setPane(name) {
    panes.forEach((pane) => pane.classList.toggle('is-active', pane.dataset.storePane === name));
    navButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.storeNav === name));
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function showMessage(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#b91c1c' : '';
  }

  function escape(value) {
    return typeof escapeHTML === 'function' ? escapeHTML(value) : String(value || '');
  }

  function money(value) {
    return typeof formatMoney === 'function' ? formatMoney(value) : `$${Number(value || 0).toFixed(2)}`;
  }

  function dateTime(value) {
    return typeof formatDateTime === 'function' ? formatDateTime(value) : String(value || '—');
  }

  function requireAdminAccess() {
    if (typeof requireAuthForPrivatePages === 'function' && !requireAuthForPrivatePages()) return false;
    const user = typeof currentUser === 'function' ? currentUser() : null;
    if (!user || !(user.role === 'admin' || user.role === 'super_admin')) {
      window.location.replace('login.html');
      return false;
    }
    return true;
  }

  function buildMergeOptions(currentId) {
    const options = state.products
      .filter((product) => product.id !== currentId && product.status !== 'merged')
      .slice(0, 200)
      .map((product) => `<option value="${escape(product.id)}">${escape(product.title || product.primary_sku || product.id)}</option>`)
      .join('');
    return `<option value="">Select product</option>${options}`;
  }

  function renderTopStats() {
    const products = state.products || [];
    const receipts = state.receipts || [];
    const accountingProducts = Array.isArray(state.accounting?.products) ? state.accounting.products : [];
    const stock = products.reduce((sum, item) => sum + Number(item.stock_on_hand || 0), 0);
    const grossProfit = accountingProducts.reduce((sum, item) => sum + Number(item.gross_profit || 0), 0);
    setText('storeStatProducts', String(products.filter((item) => item.status !== 'merged').length));
    setText('storeStatStock', String(stock));
    setText('storeStatReceipts', String(receipts.length));
    setText('storeStatProfit', money(grossProfit));
  }

  function renderProducts() {
    const body = document.getElementById('storeProductsBody');
    if (!body) return;
    const products = state.products || [];
    if (!products.length) {
      body.innerHTML = '<tr><td colspan="10">No storefront products found.</td></tr>';
      return;
    }
    body.innerHTML = products.map((item) => {
      const hiddenReason = Number(item.stock_on_hand || 0) <= 0 ? 'Hidden from public shop until stock is above 0.' : '';
      return `
      <tr>
        <td>
          <strong>${escape(item.title || 'Untitled')}</strong>
          <div class="subtle-text">${hiddenReason ? escape(hiddenReason) : 'Visible in public shop when active and in stock.'}</div>
        </td>
        <td>${escape(item.primary_site || '—')}</td>
        <td>${escape(item.primary_sku || '—')}</td>
        <td><input class="input input--sm" type="number" min="0" step="1" value="${escape(item.stock_on_hand ?? 0)}" aria-label="Stock on hand" data-edit-stock="${escape(item.id)}" /></td>
        <td><input class="input input--sm" type="number" min="0" step="0.01" value="${escape(item.sale_price ?? 0)}" aria-label="Sale price" data-edit-price="${escape(item.id)}" /></td>
        <td>${escape(item.total_purchased_qty ?? 0)}</td>
        <td>${escape(item.total_sold_qty ?? 0)}</td>
        <td>
          <select class="input input--sm store-status-select" aria-label="Status" data-edit-status="${escape(item.id)}">
            <option value="active" ${item.status === 'active' ? 'selected' : ''}>active</option>
            <option value="draft" ${item.status === 'draft' ? 'selected' : ''}>draft</option>
            <option value="deleted" ${item.status === 'deleted' ? 'selected' : ''}>deleted</option>
            <option value="merged" ${item.status === 'merged' ? 'selected' : ''}>merged</option>
          </select>
        </td>
        <td>
          <div class="store-merge-cell">
            <button class="btn" type="button" data-refresh-product="${escape(item.id)}">Refresh Details</button>
            <button class="btn" type="button" data-save-product="${escape(item.id)}">Save</button>
            <button class="btn btn-danger" type="button" data-delete-product="${escape(item.id)}">Delete</button>
          </div>
        </td>
        <td>
          <div class="store-merge-cell">
            <select class="input input--sm store-merge-select" aria-label="Merge source product" data-merge-target="${escape(item.id)}">${buildMergeOptions(item.id)}</select>
            <button class="btn btn-danger" type="button" data-merge-button="${escape(item.id)}">Merge Into This</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-save-product]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.saveProduct;
        const stock = body.querySelector(`[data-edit-stock="${CSS.escape(id)}"]`)?.value;
        const salePrice = body.querySelector(`[data-edit-price="${CSS.escape(id)}"]`)?.value;
        const status = body.querySelector(`[data-edit-status="${CSS.escape(id)}"]`)?.value;
        button.disabled = true;
        showMessage('storeAdminMessage', 'Saving product changes...');
        try {
          await authJSON(API + '/admin/store/products/' + encodeURIComponent(id), {
            method: 'PATCH',
            body: JSON.stringify({ stock_on_hand: stock, sale_price: salePrice, status })
          });
          showMessage('storeAdminMessage', 'Product updated successfully.');
          await refreshAll();
        } catch (err) {
          showMessage('storeAdminMessage', err.message || 'Could not update product.', true);
        } finally {
          button.disabled = false;
        }
      });
    });

    body.querySelectorAll('[data-refresh-product]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.refreshProduct;
        button.disabled = true;
        showMessage('storeAdminMessage', 'Refreshing product details from source site...');
        try {
          await authJSON(API + '/admin/store/products/' + encodeURIComponent(id) + '/refresh-details', { method: 'POST' });
          showMessage('storeAdminMessage', 'Product details refreshed.');
          await refreshAll();
        } catch (err) {
          showMessage('storeAdminMessage', err.message || 'Could not refresh product details.', true);
        } finally {
          button.disabled = false;
        }
      });
    });

    body.querySelectorAll('[data-delete-product]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.deleteProduct;
        if (!confirm('Delete this product from the storefront?')) return;
        button.disabled = true;
        showMessage('storeAdminMessage', 'Deleting product...');
        try {
          await authJSON(API + '/admin/store/products/' + encodeURIComponent(id), { method: 'DELETE' });
          showMessage('storeAdminMessage', 'Product deleted.');
          await refreshAll();
        } catch (err) {
          showMessage('storeAdminMessage', err.message || 'Could not delete product.', true);
        } finally {
          button.disabled = false;
        }
      });
    });

    body.querySelectorAll('[data-merge-button]').forEach((button) => {
      button.addEventListener('click', async () => {
        const targetId = button.dataset.mergeButton;
        const select = body.querySelector(`[data-merge-target="${CSS.escape(targetId)}"]`);
        const sourceId = select?.value || '';
        if (!sourceId) {
          showMessage('storeAdminMessage', 'Pick a source product to merge first.', true);
          return;
        }
        button.disabled = true;
        showMessage('storeAdminMessage', 'Merging products...');
        try {
          await authJSON(API + '/admin/store/products/' + encodeURIComponent(targetId) + '/merge', {
            method: 'POST',
            body: JSON.stringify({ source_product_id: sourceId })
          });
          showMessage('storeAdminMessage', 'Products merged successfully.');
          await refreshAll();
        } catch (err) {
          showMessage('storeAdminMessage', err.message || 'Could not merge products.', true);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function renderReceipts() {
    const body = document.getElementById('storeReceiptsBody');
    if (!body) return;
    const receipts = state.receipts || [];
    if (!receipts.length) {
      body.innerHTML = '<tr><td colspan="8">No receipts found.</td></tr>';
      return;
    }
    body.innerHTML = receipts.map((row) => `
      <tr>
        <td>${escape(dateTime(row.purchased_at || row.created_at))}</td>
        <td>${escape(row.storefront_products?.title || '—')}</td>
        <td>${escape(row.site || '—')}</td>
        <td>${escape(row.sku || '—')}</td>
        <td>${escape(row.quantity ?? 0)}</td>
        <td>${money(row.purchase_unit_price)}</td>
        <td>${money(row.purchase_total_price)}</td>
        <td>${escape(row.source_order_id || '—')}</td>
      </tr>
    `).join('');
  }

  function renderOverrides() {
    const body = document.getElementById('storePricingBody');
    if (!body) return;
    const overrides = state.overrides || [];
    if (!overrides.length) {
      body.innerHTML = '<tr><td colspan="5">No price overrides found.</td></tr>';
      return;
    }
    body.innerHTML = overrides.map((row) => `
      <tr>
        <td>${escape(row.site || '—')}</td>
        <td>${escape(row.sku || '—')}</td>
        <td>${money(row.sale_price)}</td>
        <td>${escape(row.notes || '—')}</td>
        <td>${escape(dateTime(row.updated_at))}</td>
      </tr>
    `).join('');
  }

  function renderAccounting() {
    const summaryWrap = document.getElementById('storeAccountingSummaryCards');
    const body = document.getElementById('storeAccountingBody');
    if (!summaryWrap || !body) return;
    const summary = state.accounting?.summary || {};
    const products = Array.isArray(state.accounting?.products) ? state.accounting.products : [];

    const summaryItems = [
      ['Purchase Cost', summary.total_purchase_cost],
      ['Sales Revenue', summary.total_sales_revenue],
      ['Tax Collected', summary.total_tax_collected],
      ['Shipping Collected', summary.total_shipping_collected],
      ['Gross Collected', summary.total_gross_collected],
      ['Allocated Cost', summary.total_allocated_cost],
      ['Units In Stock', summary.stock_units ?? 0, true],
      ['Gross Profit', summary.gross_profit]
    ];

    summaryWrap.innerHTML = summaryItems.map(([label, value, raw]) => `
      <div class="stat-card">
        <span class="stat-label">${escape(label)}</span>
        <strong class="stat-value">${raw ? escape(value) : money(value)}</strong>
      </div>
    `).join('');

    if (!products.length) {
      body.innerHTML = '<tr><td colspan="8">No accounting rows yet.</td></tr>';
      return;
    }

    body.innerHTML = products.map((item) => `
      <tr>
        <td>${escape(item.title || 'Untitled')}</td>
        <td>${money(item.sale_price)}</td>
        <td>${escape(item.total_purchased_qty ?? 0)}</td>
        <td>${escape(item.total_sold_qty ?? 0)}</td>
        <td>${escape(item.stock_on_hand ?? 0)}</td>
        <td>${money(item.total_purchase_cost)}</td>
        <td>${money(item.total_sales_revenue)}</td>
        <td>${money(item.gross_profit)}</td>
      </tr>
    `).join('');

    const exportLink = document.getElementById('accountingExportLink');
    if (exportLink) exportLink.href = API + '/admin/store/accounting/export.csv';
  }

  async function loadProducts() {
    const data = await authJSON(API + '/admin/store/products');
    state.products = Array.isArray(data.products) ? data.products : [];
    renderProducts();
  }

  async function loadReceipts() {
    const data = await authJSON(API + '/admin/store/receipts');
    state.receipts = Array.isArray(data.receipts) ? data.receipts : [];
    renderReceipts();
  }

  async function loadOverrides() {
    const data = await authJSON(API + '/admin/store/pricing');
    state.overrides = Array.isArray(data.overrides) ? data.overrides : [];
    renderOverrides();
  }

  async function loadAccounting() {
    const data = await authJSON(API + '/admin/store/accounting/summary');
    state.accounting = data || { summary: {}, products: [] };
    renderAccounting();
  }

  async function refreshAll() {
    showMessage('storeAdminMessage', 'Refreshing storefront data...');
    try {
      await Promise.all([loadProducts(), loadReceipts(), loadOverrides(), loadAccounting()]);
      renderTopStats();
      showMessage('storeAdminMessage', 'Storefront data is up to date.');
    } catch (err) {
      showMessage('storeAdminMessage', err.message || 'Could not load storefront data.', true);
    }
  }

  function bindNav() {
    navButtons.forEach((button) => {
      button.addEventListener('click', () => setPane(button.dataset.storeNav));
    });
  }


  let lookupTimer = null;

  function selectedManualSite() {
    return document.getElementById('storeManualSite')?.value || '';
  }

  function selectedManualSku() {
    return (document.getElementById('storeManualSku')?.value || '').trim();
  }

  function applyLookupResult(product) {
    if (!product) return;
    const titleEl = document.getElementById('storeManualTitle');
    const imageEl = document.getElementById('storeManualImageUrl');
    const urlEl = document.getElementById('storeManualProductUrl');
    const descEl = document.getElementById('storeManualDescription');
    const purchaseEl = document.getElementById('storeManualPurchaseUnitPrice');
    if (titleEl && !titleEl.value.trim() && product.title) titleEl.value = product.title;
    if (imageEl && product.image_url) imageEl.value = product.image_url;
    if (urlEl && product.product_url) urlEl.value = product.product_url;
    if (descEl && !descEl.value.trim() && product.description) descEl.value = product.description;
    const site = String(selectedManualSite() || '').toLowerCase();
    if (purchaseEl && !purchaseEl.value.trim() && product.price != null && site !== 'walmart') purchaseEl.value = String(product.price);
  }

  async function lookupManualProductDetails(forceMessage = true) {
    const site = selectedManualSite();
    const sku = selectedManualSku();
    if (!site || !sku) {
      if (forceMessage) showMessage('manualInventoryMessage', 'Choose a site and enter a SKU first.', true);
      return null;
    }
    if (forceMessage) showMessage('manualInventoryMessage', 'Looking up source product details...');
    try {
      const payload = await authJSON(API + '/admin/store/lookup-product?' + new URLSearchParams({ site, sku }).toString());
      applyLookupResult(payload.product || null);
      const product = payload.product || {};

      if (String(site).toLowerCase() === 'walmart') {
        if (product.title || product.image_url) {
          showMessage('manualInventoryMessage', 'Loaded Walmart details from your saved catalog/webhook cache. Walmart live scraping is disabled to avoid CAPTCHA blocks.');
        } else {
          showMessage('manualInventoryMessage', 'Walmart live lookup is disabled to avoid CAPTCHA blocks. The product URL was filled in for you. If a past webhook for this SKU included title or image data, future lookups will auto-fill from your saved cache.');
        }
        return payload.product || null;
      }

      const details = [product.title, product.image_url ? 'image found' : '', product.price != null ? 'price found' : ''].filter(Boolean).join(' • ');
      showMessage('manualInventoryMessage', details ? `Loaded product details: ${details}` : 'Lookup completed, but only partial details were found.');
      return payload.product || null;
    } catch (err) {
      if (forceMessage) showMessage('manualInventoryMessage', err.message || 'Could not load source product details.', true);
      return null;
    }
  }

  function bindActions() {
    document.getElementById('refreshStoreDataButton')?.addEventListener('click', refreshAll);
    document.getElementById('storeLookupButton')?.addEventListener('click', () => lookupManualProductDetails(true));
    document.getElementById('storeManualSite')?.addEventListener('change', () => { if (selectedManualSku()) lookupManualProductDetails(false); });
    document.getElementById('storeManualSku')?.addEventListener('input', () => {
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(() => { if (selectedManualSku().length >= 6) lookupManualProductDetails(false); }, 700);
    });

    document.getElementById('manualInventoryForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      showMessage('manualInventoryMessage', 'Saving inventory entry...');
      try {
        const payload = {
          site: document.getElementById('storeManualSite')?.value,
          sku: document.getElementById('storeManualSku')?.value,
          title: document.getElementById('storeManualTitle')?.value,
          quantity: Number(document.getElementById('storeManualQuantity')?.value || 1),
          purchase_unit_price: document.getElementById('storeManualPurchaseUnitPrice')?.value,
          sale_price: document.getElementById('storeManualSalePrice')?.value,
          source_order_id: document.getElementById('storeManualSourceOrderId')?.value,
          image_url: document.getElementById('storeManualImageUrl')?.value,
          source_product_url: document.getElementById('storeManualProductUrl')?.value,
          description: document.getElementById('storeManualDescription')?.value,
          notes: document.getElementById('storeManualDescription')?.value
        };
        await authJSON(API + '/admin/store/products/manual', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        event.target.reset();
        document.getElementById('storeManualQuantity').value = '1';
        showMessage('manualInventoryMessage', 'Inventory entry saved successfully.');
        await refreshAll();
      } catch (err) {
        showMessage('manualInventoryMessage', err.message || 'Could not save inventory entry.', true);
      }
    });

    document.getElementById('importTargetListButton')?.addEventListener('click', async () => {
      showMessage('importTargetListMessage', 'Importing Target seed list...');
      try {
        const data = await authJSON(API + '/admin/store/import-target-list', { method: 'POST' });
        showMessage('importTargetListMessage', `Imported ${Number(data.imported_count || 0)} Target products.`);
        await refreshAll();
      } catch (err) {
        showMessage('importTargetListMessage', err.message || 'Could not import Target list.', true);
      }
    });

    document.getElementById('pricingOverrideForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      showMessage('pricingOverrideMessage', 'Saving price override...');
      try {
        const payload = {
          site: document.getElementById('pricingSite')?.value,
          sku: document.getElementById('pricingSku')?.value,
          sale_price: document.getElementById('pricingSalePrice')?.value,
          notes: document.getElementById('pricingNotes')?.value
        };
        await authJSON(API + '/admin/store/pricing', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        event.target.reset();
        showMessage('pricingOverrideMessage', 'Price override saved.');
        await refreshAll();
      } catch (err) {
        showMessage('pricingOverrideMessage', err.message || 'Could not save price override.', true);
      }
    });
  }

  async function init() {
    if (!requireAdminAccess()) return;
    bindNav();
    bindActions();
    await refreshAll();
  }

  init();
})();
