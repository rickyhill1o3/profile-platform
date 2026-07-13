
function parseMultiSkuValue(rawValue) {
    if (!rawValue) return [];

    return rawValue
        .split(/[\n,]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function countEffectiveSkus(product) {
    if (!product) return 0;

    if (Array.isArray(product.multiSkus) && product.multiSkus.length) {
        return product.multiSkus.length;
    }

    if (typeof product.sku === 'string') {
        return parseMultiSkuValue(product.sku).length || 1;
    }

    return 1;
}


(function () {
  const panes = Array.from(document.querySelectorAll('[data-store-pane]'));
  const navButtons = Array.from(document.querySelectorAll('[data-store-nav]'));
  const state = { products: [], orders: [], receipts: [], overrides: [], discounts: [], accounting: null, editingProductId: '', activeOrder: null };
  function $(id) { return document.getElementById(id); }
  function setPane(name) { panes.forEach((pane) => pane.classList.toggle('is-active', pane.dataset.storePane === name)); navButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.storeNav === name)); }
  function escape(value) { return typeof escapeHTML === 'function' ? escapeHTML(value) : String(value || ''); }
  function money(value) { return typeof formatMoney === 'function' ? formatMoney(value) : `$${Number(value || 0).toFixed(2)}`; }
  function dateTime(value) { return typeof formatDateTime === 'function' ? formatDateTime(value) : String(value || '—'); }
  function showMessage(id, text, isError = false) { const el = $(id); if (!el) return; el.textContent = text; el.style.color = isError ? '#b91c1c' : ''; }
  function requireAdminAccess() {
    if (typeof requireAuthForPrivatePages === 'function' && !requireAuthForPrivatePages()) return false;
    const user = typeof currentUser === 'function' ? currentUser() : null;
    if (!user || user.role !== 'super_admin') { window.location.replace('dashboard.html'); return false; }
    return true;
  }
  function buildMergeOptions(currentId) {
    const options = state.products.filter((product) => String(product.id) !== String(currentId) && product.status !== 'merged')
      .slice(0, 200).map((product) => `<option value="${escape(product.id)}">${escape(product.title || product.primary_sku || product.id)}</option>`).join('');
    return `<option value="">Select product</option>${options}`;
  }
  function renderTopStats() {
    const stock = state.products.reduce((sum, item) => sum + Number(item.stock_on_hand || 0), 0);
    const grossProfit = (state.accounting?.products || []).reduce((sum, item) => sum + Number(item.gross_profit || 0), 0);
    $('storeStatProducts').textContent = String(state.products.filter((item) => item.status !== 'merged').length);
    $('storeStatStock').textContent = String(stock);
    $('storeStatReceipts').textContent = String(state.receipts.length);
    $('storeStatProfit').textContent = money(grossProfit);
  }
  function renderProducts() {
    const body = $('storeProductsBody'); if (!body) return;
    if (!state.products.length) { body.innerHTML = '<tr><td colspan="10">No storefront products found.</td></tr>'; return; }
    body.innerHTML = state.products.map((item) => {
      const hiddenReason = Number(item.stock_on_hand || 0) <= 0 ? 'Hidden from public shop until stock is above 0.' : (String(item.status || 'active') !== 'active' ? 'Hidden because status is not active.' : 'Visible in public shop.');
      return `<tr>
        <td><div class="store-product-cell"><div class="store-thumb">${item.image_url ? `<img src="${escape(item.image_url)}" alt="${escape(item.title || '')}" />` : ''}</div><div><strong>${escape(item.title || 'Untitled')}</strong><div class="subtle-text">${escape(hiddenReason)}</div></div></div></td>
        <td>${escape(item.primary_site || '—')}</td>
        <td>${escape(item.primary_sku || '—')}</td>
        <td><input class="input input--sm" type="number" min="0" step="1" value="${escape(item.stock_on_hand ?? 0)}" data-edit-stock="${escape(item.id)}" /></td>
        <td><input class="input input--sm" type="number" min="0" step="0.01" value="${escape(item.sale_price ?? 0)}" data-edit-price="${escape(item.id)}" /></td>
        <td>${escape(item.total_purchased_qty ?? 0)}</td>
        <td>${escape(item.total_sold_qty ?? 0)}</td>
        <td><select class="input input--sm store-status-select" data-edit-status="${escape(item.id)}"><option value="active" ${item.status === 'active' ? 'selected' : ''}>active</option><option value="draft" ${item.status === 'draft' ? 'selected' : ''}>draft</option><option value="deleted" ${item.status === 'deleted' ? 'selected' : ''}>deleted</option><option value="merged" ${item.status === 'merged' ? 'selected' : ''}>merged</option></select></td>
        <td><div class="table-actions table-actions--stack"><button class="btn" type="button" data-open-edit="${escape(item.id)}">Edit</button><button class="btn" type="button" data-refresh-product="${escape(item.id)}">Refresh</button><button class="btn btn-primary" type="button" data-save-product="${escape(item.id)}">Save</button><button class="btn btn-danger" type="button" data-delete-product="${escape(item.id)}">Delete</button></div></td>
        <td><div class="store-merge-cell"><select class="input input--sm store-merge-select" data-merge-target="${escape(item.id)}">${buildMergeOptions(item.id)}</select><button class="btn btn-danger" type="button" data-merge-button="${escape(item.id)}">Merge</button></div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-save-product]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.dataset.saveProduct; button.disabled = true; showMessage('storeAdminMessage', 'Saving product changes...');
      try {
        await authJSON(API + '/admin/store/products/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ stock_on_hand: body.querySelector(`[data-edit-stock="${CSS.escape(id)}"]`)?.value, sale_price: body.querySelector(`[data-edit-price="${CSS.escape(id)}"]`)?.value, status: body.querySelector(`[data-edit-status="${CSS.escape(id)}"]`)?.value }) });
        showMessage('storeAdminMessage', 'Product updated successfully.'); await refreshAll();
      } catch (error) { showMessage('storeAdminMessage', error.message || 'Could not update product.', true); } finally { button.disabled = false; }
    }));
    body.querySelectorAll('[data-open-edit]').forEach((button) => button.addEventListener('click', () => openEditPane(button.dataset.openEdit)));
    body.querySelectorAll('[data-refresh-product]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true; showMessage('storeAdminMessage', 'Refreshing product details from source site...');
      try { await authJSON(API + '/admin/store/products/' + encodeURIComponent(button.dataset.refreshProduct) + '/refresh-details', { method: 'POST' }); showMessage('storeAdminMessage', 'Product details refreshed.'); await refreshAll(); }
      catch (error) { showMessage('storeAdminMessage', error.message || 'Could not refresh product details.', true); } finally { button.disabled = false; }
    }));
    body.querySelectorAll('[data-delete-product]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Delete this product from the storefront?')) return; button.disabled = true; showMessage('storeAdminMessage', 'Deleting product...');
      try { await authJSON(API + '/admin/store/products/' + encodeURIComponent(button.dataset.deleteProduct), { method: 'DELETE' }); showMessage('storeAdminMessage', 'Product deleted.'); await refreshAll(); }
      catch (error) { showMessage('storeAdminMessage', error.message || 'Could not delete product.', true); } finally { button.disabled = false; }
    }));
    body.querySelectorAll('[data-merge-button]').forEach((button) => button.addEventListener('click', async () => {
      const targetId = button.dataset.mergeButton;
      const sourceId = body.querySelector(`[data-merge-target="${CSS.escape(targetId)}"]`)?.value || '';
      if (!sourceId) return showMessage('storeAdminMessage', 'Pick a source product to merge first.', true);
      button.disabled = true; showMessage('storeAdminMessage', 'Merging products...');
      try { await authJSON(API + '/admin/store/products/' + encodeURIComponent(targetId) + '/merge', { method: 'POST', body: JSON.stringify({ source_product_id: sourceId }) }); showMessage('storeAdminMessage', 'Products merged successfully.'); await refreshAll(); }
      catch (error) { showMessage('storeAdminMessage', error.message || 'Could not merge products.', true); } finally { button.disabled = false; }
    }));
  }
  function openEditPane(productId) {
    const product = state.products.find((item) => String(item.id) === String(productId));
    if (!product) return showMessage('storeAdminMessage', 'Product not found.', true);
    state.editingProductId = String(product.id);
    $('storeEditProductId').value = product.id || ''; $('storeEditTitle').value = product.title || ''; $('storeEditSite').value = product.primary_site || ''; $('storeEditSku').value = product.primary_sku || ''; $('storeEditSalePrice').value = product.sale_price ?? 0; $('storeEditStatus').value = product.status || 'active'; $('storeEditImageUrl').value = product.image_url || ''; $('storeEditProductUrl').value = product.source_product_url || ''; $('storeEditDescription').value = product.description || '';
    showMessage('storeEditMessage', `Editing ${product.title || product.primary_sku || 'product'}.`); setPane('edit');
  }
  function bindEditForm() {
    $('storeEditCancelButton')?.addEventListener('click', () => setPane('overview'));
    $('storeEditProductForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const productId = $('storeEditProductId')?.value || state.editingProductId;
      if (!productId) return showMessage('storeEditMessage', 'Pick a product from Overview first.', true);
      showMessage('storeEditMessage', 'Saving product changes...');
      try {
        await authJSON(API + '/admin/store/products/' + encodeURIComponent(productId), { method: 'PATCH', body: JSON.stringify({ title: $('storeEditTitle')?.value || '', description: $('storeEditDescription')?.value || '', image_url: $('storeEditImageUrl')?.value || '', source_product_url: $('storeEditProductUrl')?.value || '', sale_price: $('storeEditSalePrice')?.value || '', status: $('storeEditStatus')?.value || 'active' }) });
        showMessage('storeEditMessage', 'Product updated successfully.'); await refreshAll(); setPane('overview');
      } catch (error) { showMessage('storeEditMessage', error.message || 'Could not update product.', true); }
    });
  }
  function renderOverrides() {
    const body = $('storePricingBody'); if (!body) return;
    body.innerHTML = state.overrides.length ? state.overrides.map((row) => `<tr><td>${escape(row.site || '—')}</td><td>${escape(row.sku || '—')}</td><td>${money(row.sale_price)}</td><td>${escape(row.notes || '—')}</td><td>${escape(dateTime(row.updated_at || row.created_at || ''))}</td></tr>`).join('') : '<tr><td colspan="5">No manual pricing overrides found.</td></tr>';
  }
  function renderReceipts() {
    const body = $('storeReceiptsBody'); if (!body) return;
    body.innerHTML = state.receipts.length ? state.receipts.map((row) => `<tr><td>${escape(dateTime(row.purchased_at || row.created_at || ''))}</td><td>${escape(row.storefront_products?.title || row.sku || '—')}</td><td>${escape(row.site || '—')}</td><td>${escape(row.sku || '—')}</td><td>${escape(row.quantity || 0)}</td><td>${money(row.purchase_unit_price)}</td><td>${money(row.purchase_total_price)}</td><td>${escape(row.source_order_id || '—')}</td></tr>`).join('') : '<tr><td colspan="8">No receipts found.</td></tr>';
  }
  function renderAccounting() {
    const body = $('storeAccountingBody'); const cards = $('storeAccountingSummaryCards'); if (!body || !cards) return;
    const summary = state.accounting?.summary || {};
    cards.innerHTML = [['Sales revenue', money(summary.total_sales_revenue)], ['Purchase cost', money(summary.total_purchase_cost)], ['Tax collected', money(summary.total_tax_collected)], ['Shipping collected', money(summary.total_shipping_collected)], ['Stock units', String(summary.stock_units || 0)], ['Gross profit', money(summary.gross_profit)]].map(([label, value]) => `<div class="stat-card"><span class="stat-label">${label}</span><strong class="stat-value">${escape(value)}</strong></div>`).join('');
    body.innerHTML = (state.accounting?.products || []).length ? state.accounting.products.map((row) => `<tr><td>${escape(row.title || 'Untitled')}</td><td>${money(row.sale_price)}</td><td>${escape(row.total_purchased_qty || 0)}</td><td>${escape(row.total_sold_qty || 0)}</td><td>${escape(row.stock_on_hand || 0)}</td><td>${money(row.total_purchase_cost)}</td><td>${money(row.total_sales_revenue)}</td><td>${money(row.gross_profit)}</td></tr>`).join('') : '<tr><td colspan="8">No accounting data found.</td></tr>';
  }
  function closeStoreModal(id) { const modal = $(id); if (modal) modal.classList.remove('is-open'); }
  function openReceipt(order) {
    state.activeOrder = order;
    $('storeReceiptOrder').textContent = order.order_number || order.session_id || 'Order';
    $('storeReceiptCustomer').textContent = [order.shipping_name, order.customer_email].filter(Boolean).join(' — ') || '—';
    $('storeReceiptItems').innerHTML = (order.items || []).map((item) => `<tr><td>${escape(item.title)}</td><td>${escape(item.quantity)}</td><td>${money(item.unit_price)}</td><td>${money(item.subtotal)}</td><td>${money(item.tax)}</td><td>${money(item.total)}</td></tr>`).join('') || '<tr><td colspan="6">No items found.</td></tr>';
    $('storeReceiptSubtotal').textContent = money(order.subtotal);
    $('storeReceiptShipping').textContent = money(order.shipping);
    $('storeReceiptTax').textContent = money(order.tax);
    $('storeReceiptTotal').textContent = money(order.total);
    $('storeReceiptRefunded').textContent = money(order.refunded_total);
    $('storeReceiptRemaining').textContent = money(order.remaining_total);
    const taxInfo = order.tax_verification || {};
    const exempt = String(taxInfo.customer_tax_exempt || 'none');
    const reasonLabels = { tax_collected: 'Tax collected', customer_exempt: 'Customer marked tax-exempt in Stripe', not_collecting: 'Not registered or transaction treated as non-taxable', product_exempt: 'Product exempt', zero_rated: 'Zero-rated', automatic_tax_complete_zero_tax: 'Automatic Tax completed with $0 tax', automatic_tax_incomplete_or_unknown: 'Automatic Tax incomplete or reason unavailable', automatic_tax_not_enabled: 'Automatic Tax not enabled' };
    $('storeReceiptAutomaticTax').textContent = taxInfo.automatic_tax_enabled ? 'Enabled' : 'Not enabled';
    $('storeReceiptTaxStatus').textContent = taxInfo.automatic_tax_status || 'Unknown';
    $('storeReceiptTaxExempt').textContent = exempt === 'none' ? 'Not marked exempt' : exempt;
    $('storeReceiptTaxReason').textContent = reasonLabels[taxInfo.zero_tax_reason] || (taxInfo.taxability_reasons || []).join(', ') || 'Unknown';
    const taxIds = Array.isArray(taxInfo.customer_tax_ids) ? taxInfo.customer_tax_ids : [];
    $('storeReceiptTaxId').textContent = taxIds.length ? taxIds.map((x) => `${x.type || 'tax ID'}: ${x.value || ''}`).join(', ') : 'None supplied';
    $('storeReceiptTaxVerifiedAt').textContent = taxInfo.verified_at ? dateTime(taxInfo.verified_at) : 'Not yet verified';
    $('storeReceiptTaxWarning').textContent = exempt !== 'none' ? 'Stripe marks this customer as tax-exempt. Keep a valid resale or exemption certificate in your records; the Stripe setting alone is not proof of eligibility.' : 'This customer is not marked tax-exempt in Stripe. A $0 tax result may instead mean you are not registered to collect in that jurisdiction or the product/transaction was non-taxable.';
    $('storeReceiptTaxNote').textContent = Number(order.tax || 0) > 0 ? 'Stripe calculated and collected sales tax for this order.' : `No sales tax was collected. Reason: ${$('storeReceiptTaxReason').textContent}.`;
    $('storeReceiptModal').classList.add('is-open');
  }
  function openTracking(order) {
    state.activeOrder = order;
    $('storeTrackingCarrier').value = order.tracking_carrier || '';
    $('storeTrackingNumber').value = order.tracking_number || '';
    $('storeTrackingUrl').value = order.tracking_url || '';
    $('storeTrackingModal').classList.add('is-open');
  }
  function refundReasonText(code) {
    return ({ out_of_stock: 'We ran out of stock before we could fulfill the order', pricing_error: 'The item was listed at an incorrect price', damaged_inventory: 'The remaining inventory was damaged or unavailable', customer_request: 'Refund requested by the customer', duplicate_order: 'Duplicate order', cannot_fulfill: 'We are unable to fulfill this order', other: '' })[code] || '';
  }
  function updateRefundPreview() {
    const code = $('storeRefundReason').value;
    const custom = $('storeRefundCustomReason').value.trim();
    const reason = code === 'other' ? (custom || '[enter your reason]') : refundReasonText(code);
    const full = $('storeRefundFullOrder').checked;
    const order = state.activeOrder || {};
    const lines = [];
    document.querySelectorAll('[data-refund-qty]').forEach((input) => { const qty = Number(input.value || 0); if (qty > 0) lines.push(`${input.dataset.itemTitle} × ${qty}`); });
    $('storeRefundEmailPreview').textContent = [`We issued a ${full ? 'full' : 'partial'} refund for your Shore Shack order.`, '', `Order: ${order.order_number || order.session_id || ''}`, 'Refund amount: calculated when submitted', `Reason: ${reason}`, lines.length ? `Refunded items:\n${lines.join('\n')}` : '', '', 'The refund has been submitted to your original payment method. Your bank may take several business days to post it.'].filter(Boolean).join('\n');
  }
  function openRefund(order) {
    state.activeOrder = order;
    $('storeRefundOrderLabel').textContent = order.order_number || order.session_id || 'Order';
    $('storeRefundFullOrder').checked = false;
    $('storeRefundReason').value = 'out_of_stock';
    $('storeRefundCustomReason').value = '';
    $('storeRefundCustomReasonWrap').hidden = true;
    $('storeRefundItems').innerHTML = (order.items || []).map((item) => `<div class="refund-item-row"><div><strong>${escape(item.title)}</strong><div class="subtle-text">Purchased ${escape(item.quantity)} • already refunded ${escape(item.refunded_quantity || 0)} • refundable ${escape(item.refundable_quantity || 0)}</div></div><input class="input input--sm" type="number" min="0" max="${escape(item.refundable_quantity || 0)}" value="0" data-refund-qty="${escape(item.sale_id)}" data-item-title="${escape(item.title)}" ${Number(item.refundable_quantity || 0) <= 0 ? 'disabled' : ''}></div>`).join('') || '<p>No refundable items remain.</p>';
    $('storeRefundModal').classList.add('is-open');
    updateRefundPreview();
  }
  function renderOrders() {
    const body = $('storeOrdersBody'); if (!body) return;
    const statusBadge = (status, error, sentAt) => {
      const normalized = String(status || 'not_attempted');
      const label = normalized === 'sent' ? `Sent${sentAt ? ` ${dateTime(sentAt)}` : ''}` : normalized === 'failed' ? 'Failed' : 'Not attempted';
      const cls = normalized === 'sent' ? 'badge--success' : normalized === 'failed' ? 'badge--danger' : 'badge--muted';
      return `<span class="badge ${cls}" title="${escape(error || '')}">${escape(label)}</span>`;
    };
    body.innerHTML = state.orders.length ? state.orders.map((order) => {
      const itemSummary = (order.items || []).map((item) => `${escape(item.title || 'Item')} × ${escape(item.quantity || 0)}${Number(item.refunded_quantity || 0) ? ` <span class="subtle-text">(${escape(item.refunded_quantity)} refunded)</span>` : ''}`).join('<br>');
      const emailVerification = `<div><strong>Customer:</strong> ${statusBadge(order.customer_email_status, order.customer_email_error, order.customer_email_sent_at)}</div><div><strong>Admin:</strong> ${statusBadge(order.admin_email_status, order.admin_email_error, order.admin_email_sent_at)}</div>`;
      return `<tr><td>${escape(dateTime(order.placed_at))}</td><td><strong>${escape(order.order_number || order.session_id || 'Order')}</strong></td><td><div>${escape(order.customer_email || '—')}</div><div class="subtle-text">${escape(order.shipping_name || '')}</div></td><td>${itemSummary || '—'}</td><td><div>${money(order.total)}</div>${Number(order.refunded_total || 0) ? `<div class="subtle-text">Refunded ${money(order.refunded_total)}</div>` : ''}</td><td><span class="badge">${escape(order.status || 'paid')}</span></td><td>${emailVerification}</td><td><div>${escape(order.tracking_number || '—')}</div><div class="subtle-text">${escape(order.tracking_carrier || '')}</div></td><td><div class="store-order-actions"><button class="btn" type="button" data-view-receipt="${escape(order.session_id)}">Receipt</button><button class="btn" type="button" data-open-tracking="${escape(order.session_id)}">Tracking</button><button class="btn btn-danger" type="button" data-open-refund="${escape(order.session_id)}" ${Number(order.remaining_total || 0) <= 0 ? 'disabled' : ''}>Refund</button><button class="btn" type="button" data-resend-order-confirmation="${escape(order.session_id)}">Resend emails</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="9">No active orders found.</td></tr>';
    body.querySelectorAll('[data-view-receipt]').forEach((button) => button.addEventListener('click', () => { const order = state.orders.find((row) => String(row.session_id) === String(button.dataset.viewReceipt)); if (order) openReceipt(order); }));
    body.querySelectorAll('[data-open-tracking]').forEach((button) => button.addEventListener('click', () => { const order = state.orders.find((row) => String(row.session_id) === String(button.dataset.openTracking)); if (order) openTracking(order); }));
    body.querySelectorAll('[data-open-refund]').forEach((button) => button.addEventListener('click', () => { const order = state.orders.find((row) => String(row.session_id) === String(button.dataset.openRefund)); if (order) openRefund(order); }));
    body.querySelectorAll('[data-resend-order-confirmation]').forEach((button) => button.addEventListener('click', async () => {
      const sessionId = button.dataset.resendOrderConfirmation;
      button.disabled = true; showMessage('storeOrdersMessage', 'Sending customer and admin confirmation emails...');
      try { const result = await authJSON(API + '/admin/store/orders/' + encodeURIComponent(sessionId) + '/resend-confirmation', { method: 'POST' }); const customer = result.email?.customer?.success ? 'customer sent' : `customer failed: ${result.email?.customer?.error || 'unknown error'}`; const adminEmail = result.email?.admin?.success ? 'admin sent' : `admin failed: ${result.email?.admin?.error || 'unknown error'}`; showMessage('storeOrdersMessage', `Confirmation result — ${customer}; ${adminEmail}.`, !(result.email?.customer?.success && result.email?.admin?.success)); await loadOrders(); }
      catch (error) { showMessage('storeOrdersMessage', error.message || 'Could not resend confirmation emails.', true); }
      finally { button.disabled = false; }
    }));
  }
  function renderDiscounts() {
    const body = $('storeDiscountsBody'); if (!body) return;
    body.innerHTML = state.discounts.length ? state.discounts.map((row) => `<tr><td><strong>${escape(row.code)}</strong></td><td>${escape(row.type)}</td><td>${row.type === 'free_shipping' ? 'Free shipping' : money(row.value)}</td><td>${escape(row.usage_count || 0)}${Number(row.usage_limit || 0) > 0 ? ` / ${escape(row.usage_limit)}` : ''}</td><td><div>${row.one_time_per_user ? 'One time per email' : 'Reusable'}</div><div class="subtle-text">${row.expires_at ? `Expires ${escape(String(row.expires_at).slice(0, 10))}` : 'No expiration'}${Number(row.min_cart_value || 0) > 0 ? ` • Min ${money(row.min_cart_value)}` : ''}</div></td><td><span class="badge ${row.active ? 'badge--success' : 'badge--muted'}">${row.active ? 'active' : 'inactive'}</span></td><td><div class="table-actions table-actions--stack"><button class="btn" type="button" data-edit-discount="${escape(row.code)}">Load</button><button class="btn" type="button" data-toggle-discount="${escape(row.code)}">${row.active ? 'Disable' : 'Enable'}</button><button class="btn btn-danger" type="button" data-delete-discount="${escape(row.code)}">Delete</button></div></td></tr>`).join('') : '<tr><td colspan="7">No discount codes created yet.</td></tr>';
    body.querySelectorAll('[data-edit-discount]').forEach((button) => button.addEventListener('click', () => {
      const row = state.discounts.find((item) => item.code === button.dataset.editDiscount); if (!row) return;
      $('discountCode').value = row.code || ''; $('discountType').value = row.type || 'percent'; $('discountValue').value = row.type === 'free_shipping' ? '' : (row.value ?? ''); $('discountUsageLimit').value = row.usage_limit ?? ''; $('discountMinCart').value = row.min_cart_value ?? ''; $('discountExpiresAt').value = row.expires_at ? String(row.expires_at).slice(0, 10) : ''; $('discountActive').value = row.active ? 'true' : 'false'; $('discountOneTime').checked = row.one_time_per_user === true; setPane('discounts'); showMessage('discountMessage', `Loaded ${row.code}. Update the form and save to overwrite it.`);
    }));
    body.querySelectorAll('[data-toggle-discount]').forEach((button) => button.addEventListener('click', async () => {
      const row = state.discounts.find((item) => item.code === button.dataset.toggleDiscount); if (!row) return;
      button.disabled = true;
      try { await authJSON(API + '/api/discounts/' + encodeURIComponent(row.code), { method: 'PATCH', body: JSON.stringify({ active: !row.active }) }); showMessage('discountMessage', `${row.code} updated.`); await loadDiscounts(); }
      catch (error) { showMessage('discountMessage', error.message || 'Could not update discount.', true); } finally { button.disabled = false; }
    }));
    body.querySelectorAll('[data-delete-discount]').forEach((button) => button.addEventListener('click', async () => {
      const code = button.dataset.deleteDiscount; if (!confirm(`Delete discount code ${code}?`)) return;
      button.disabled = true;
      try { await authJSON(API + '/api/discounts/' + encodeURIComponent(code), { method: 'DELETE' }); showMessage('discountMessage', `${code} deleted.`); await loadDiscounts(); }
      catch (error) { showMessage('discountMessage', error.message || 'Could not delete discount.', true); } finally { button.disabled = false; }
    }));
  }
  async function loadProducts() { const data = await authJSON(API + '/admin/store/products'); state.products = Array.isArray(data.products) ? data.products : []; renderProducts(); renderTopStats(); }

  async function refreshActiveOrderTax() {
    const order = state.activeOrder;
    if (!order?.session_id) return;
    const button = $('storeReceiptRefreshTax');
    const oldText = button.textContent;
    button.disabled = true; button.textContent = 'Refreshing…';
    try {
      const result = await authJSON(`${API}/admin/store/orders/${encodeURIComponent(order.session_id)}/refresh-tax`, { method: 'POST' });
      order.tax_verification = result.tax_verification || {};
      openReceipt(order);
    } catch (err) { alert(err.message || String(err)); }
    finally { button.disabled = false; button.textContent = oldText; }
  }

  async function loadReceipts() { const data = await authJSON(API + '/admin/store/receipts'); state.receipts = Array.isArray(data.receipts) ? data.receipts : []; renderReceipts(); renderTopStats(); }
  async function loadOverrides() { const data = await authJSON(API + '/admin/store/pricing'); state.overrides = Array.isArray(data.overrides) ? data.overrides : []; renderOverrides(); }
  async function loadOrders() { showMessage('storeOrdersMessage', 'Loading active orders...'); try { const data = await authJSON(API + '/admin/store/orders'); state.orders = Array.isArray(data.orders) ? data.orders : []; renderOrders(); showMessage('storeOrdersMessage', state.orders.length ? `Loaded ${state.orders.length} active order${state.orders.length === 1 ? '' : 's'}.` : 'No active storefront orders right now.'); } catch (error) { state.orders = []; renderOrders(); showMessage('storeOrdersMessage', `Could not load orders: ${error.message || 'Unknown error'}`, true); throw error; } }
  async function loadAccounting() { const data = await authJSON(API + '/admin/store/accounting/summary'); state.accounting = data || {}; $('accountingExportLink').href = API + '/admin/store/accounting/export.csv'; renderAccounting(); renderTopStats(); }
  async function loadDiscounts() { const data = await authJSON(API + '/api/discounts'); state.discounts = Array.isArray(data.discounts) ? data.discounts : []; renderDiscounts(); }
  async function refreshAll() { await Promise.all([loadProducts(), loadReceipts(), loadOverrides(), loadOrders(), loadAccounting(), loadDiscounts()]); }
  function bindPaneNav() { navButtons.forEach((button) => button.addEventListener('click', () => setPane(button.dataset.storeNav))); }
  async function lookupProductDetails() {
    const site = $('storeManualSite')?.value || ''; const sku = $('storeManualSku')?.value || ''; if (!site || !sku) return;
    showMessage('manualInventoryMessage', 'Looking up product details...');
    try {
      const response = await authJSON(API + '/admin/store/lookup-product?site=' + encodeURIComponent(site) + '&sku=' + encodeURIComponent(sku));
      const product = response.product || {};
      if (product.title && !$('storeManualTitle').value) $('storeManualTitle').value = product.title;
      if (product.image_url && !$('storeManualImageUrl').value) $('storeManualImageUrl').value = product.image_url;
      if (product.product_url && !$('storeManualProductUrl').value) $('storeManualProductUrl').value = product.product_url;
      if (product.description && !$('storeManualDescription').value) $('storeManualDescription').value = product.description;
      if (product.price != null && !$('storeManualPurchaseUnitPrice').value) $('storeManualPurchaseUnitPrice').value = product.price;
      showMessage('manualInventoryMessage', 'Product details loaded.');
    } catch (error) { showMessage('manualInventoryMessage', error.message || 'Could not find product details for that SKU.', true); }
  }
  function bindInventoryForm() {
    $('storeLookupButton')?.addEventListener('click', lookupProductDetails);
    $('storeManualSite')?.addEventListener('change', lookupProductDetails);
    $('storeManualSku')?.addEventListener('blur', lookupProductDetails);
    $('manualInventoryForm')?.addEventListener('submit', async (event) => {
      event.preventDefault(); showMessage('manualInventoryMessage', 'Saving inventory entry...');
      try {
        await authJSON(API + '/admin/store/products/manual', { method: 'POST', body: JSON.stringify({ site: $('storeManualSite').value, sku: $('storeManualSku').value, title: $('storeManualTitle').value, quantity: $('storeManualQuantity').value, purchase_unit_price: $('storeManualPurchaseUnitPrice').value, sale_price: $('storeManualSalePrice').value, source_order_id: $('storeManualSourceOrderId').value, image_url: $('storeManualImageUrl').value, source_product_url: $('storeManualProductUrl').value, description: $('storeManualDescription').value }) });
        showMessage('manualInventoryMessage', 'Inventory entry saved.'); $('manualInventoryForm').reset(); $('storeManualQuantity').value = 1; await refreshAll();
      } catch (error) { showMessage('manualInventoryMessage', error.message || 'Could not save inventory.', true); }
    });
    $('importTargetListButton')?.addEventListener('click', async () => {
      showMessage('importTargetListMessage', 'Importing Target seed list...');
      try { const data = await authJSON(API + '/admin/store/import-target-seed', { method: 'POST' }); showMessage('importTargetListMessage', `Imported ${data.imported_count || 0} Target products.`); await refreshAll(); }
      catch (error) { showMessage('importTargetListMessage', error.message || 'Could not import seed list.', true); }
    });
  }
  function bindPricingForm() {
    $('pricingOverrideForm')?.addEventListener('submit', async (event) => {
      event.preventDefault(); showMessage('pricingOverrideMessage', 'Saving price override...');
      try { await authJSON(API + '/admin/store/pricing', { method: 'POST', body: JSON.stringify({ site: $('pricingSite').value, sku: $('pricingSku').value, sale_price: $('pricingSalePrice').value, notes: $('pricingNotes').value }) }); showMessage('pricingOverrideMessage', 'Price override saved.'); $('pricingOverrideForm').reset(); await refreshAll(); }
      catch (error) { showMessage('pricingOverrideMessage', error.message || 'Could not save pricing override.', true); }
    });
  }
  function bindDiscountForm() {
    $('discountType')?.addEventListener('change', () => { const freeShip = $('discountType').value === 'free_shipping'; $('discountValue').disabled = freeShip; if (freeShip) $('discountValue').value = ''; });
    $('discountFormReset')?.addEventListener('click', () => { $('discountForm').reset(); $('discountActive').value = 'true'; $('discountValue').disabled = false; showMessage('discountMessage', 'Form cleared.'); });
    $('discountForm')?.addEventListener('submit', async (event) => {
      event.preventDefault(); showMessage('discountMessage', 'Saving discount code...');
      try {
        await authJSON(API + '/api/discounts', { method: 'POST', body: JSON.stringify({ code: $('discountCode').value, type: $('discountType').value, value: $('discountType').value === 'free_shipping' ? 0 : $('discountValue').value, usage_limit: $('discountUsageLimit').value, min_cart_value: $('discountMinCart').value, expires_at: $('discountExpiresAt').value || null, active: $('discountActive').value === 'true', one_time_per_user: $('discountOneTime').checked }) });
        showMessage('discountMessage', 'Discount code saved.'); $('discountForm').reset(); $('discountActive').value = 'true'; await loadDiscounts();
      } catch (error) { showMessage('discountMessage', error.message || 'Could not save discount.', true); }
    });
  }
  async function init() {
    if (!requireAdminAccess()) return;
    bindPaneNav(); bindInventoryForm(); bindPricingForm(); bindEditForm(); bindDiscountForm();
    $('refreshStoreDataButton')?.addEventListener('click', refreshAll);
    $('refreshStoreOrdersButton')?.addEventListener('click', () => loadOrders().catch(() => {}));
    $('storeReceiptRefreshTax')?.addEventListener('click', refreshActiveOrderTax);
    $('discountActive').value = 'true';
    document.querySelectorAll('[data-close-store-modal]').forEach((button) => button.addEventListener('click', () => closeStoreModal(button.dataset.closeStoreModal)));
    $('storeTrackingSave')?.addEventListener('click', async () => {
      const order = state.activeOrder; if (!order) return;
      const number = $('storeTrackingNumber').value.trim(); if (!number) return showMessage('storeOrdersMessage', 'Tracking number is required.', true);
      const button = $('storeTrackingSave'); button.disabled = true;
      try { const result = await authJSON(API + '/admin/store/orders/' + encodeURIComponent(order.session_id) + '/tracking', { method: 'POST', body: JSON.stringify({ tracking_carrier: $('storeTrackingCarrier').value, tracking_number: number, tracking_url: $('storeTrackingUrl').value }) }); closeStoreModal('storeTrackingModal'); showMessage('storeOrdersMessage', result.email?.success ? 'Tracking saved and customer email sent.' : `Tracking saved, but email failed: ${result.email?.error || 'unknown error'}`, !result.email?.success); await loadOrders(); }
      catch (error) { showMessage('storeOrdersMessage', error.message || 'Could not save tracking.', true); } finally { button.disabled = false; }
    });
    $('storeRefundReason')?.addEventListener('change', () => { $('storeRefundCustomReasonWrap').hidden = $('storeRefundReason').value !== 'other'; updateRefundPreview(); });
    $('storeRefundCustomReason')?.addEventListener('input', updateRefundPreview);
    $('storeRefundFullOrder')?.addEventListener('change', () => { document.querySelectorAll('[data-refund-qty]').forEach((input) => { input.disabled = $('storeRefundFullOrder').checked || Number(input.max || 0) <= 0; input.value = $('storeRefundFullOrder').checked ? input.max : 0; }); updateRefundPreview(); });
    $('storeRefundItems')?.addEventListener('input', updateRefundPreview);
    $('storeRefundSubmit')?.addEventListener('click', async () => {
      const order = state.activeOrder; if (!order) return;
      const fullOrder = $('storeRefundFullOrder').checked;
      const items = Array.from(document.querySelectorAll('[data-refund-qty]')).map((input) => ({ sale_id: input.dataset.refundQty, quantity: Number(input.value || 0) })).filter((item) => item.quantity > 0);
      if (!fullOrder && !items.length) return alert('Select at least one item quantity to refund.');
      const reasonCode = $('storeRefundReason').value; const customReason = $('storeRefundCustomReason').value.trim();
      if (reasonCode === 'other' && !customReason) return alert('Enter the custom refund reason.');
      if (!confirm(`Submit this ${fullOrder ? 'full' : 'partial'} refund through Stripe? This cannot be undone.`)) return;
      const button = $('storeRefundSubmit'); button.disabled = true;
      try { const result = await authJSON(API + '/admin/store/orders/' + encodeURIComponent(order.session_id) + '/refund', { method: 'POST', body: JSON.stringify({ full_order: fullOrder, items, reason_code: reasonCode, custom_reason: customReason }) }); closeStoreModal('storeRefundModal'); showMessage('storeOrdersMessage', `Refunded ${money(result.refund?.amount)}. ${result.email?.success ? 'Customer refund email sent.' : `Refund completed, but email failed: ${result.email?.error || 'unknown error'}`}`, !result.email?.success); await refreshAll(); }
      catch (error) { showMessage('storeOrdersMessage', error.message || 'Could not process refund.', true); } finally { button.disabled = false; }
    });
    await refreshAll();
    showMessage('storeAdminMessage', 'Storefront data loaded.');
    showMessage('storeOrdersMessage', state.orders.length ? 'Active storefront orders loaded.' : 'No active storefront orders right now.');
  }
  init().catch((error) => { console.error(error); showMessage('storeAdminMessage', error.message || 'Could not load storefront admin.', true); });
})();
