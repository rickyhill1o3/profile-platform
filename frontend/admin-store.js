
document.getElementById('downloadAccountingCsv').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(`${API}/admin/store/accounting/export.csv`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) throw new Error('Could not download CSV');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'storefront-accounting.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) { setMessage(err.message); }
});

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://profile-platform.onrender.com';

function token() { return localStorage.getItem('token'); }
function logoutStoreAdmin() { localStorage.clear(); location.href = 'login.html'; }
function money(value) { const n = Number(value); return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'; }
function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}
function setMessage(text) { document.getElementById('storeAdminMessage').textContent = text; }
function formToObject(form) { return Object.fromEntries(new FormData(form).entries()); }

async function loadAll() {
  if (!token()) return location.href = 'login.html';
  try {
    const [summary, productsRes, receiptsRes, pricingRes] = await Promise.all([
      api('/admin/store/accounting/summary'),
      api('/admin/store/products'),
      api('/admin/store/receipts'),
      api('/admin/store/pricing')
    ]);


    document.getElementById('storeSummary').innerHTML = `
      <div class="stat-card"><span class="stat-label">Stock Units</span><strong class="stat-value">${summary.summary.stock_units}</strong></div>
      <div class="stat-card"><span class="stat-label">Revenue</span><strong class="stat-value">${money(summary.summary.total_sales_revenue)}</strong></div>
      <div class="stat-card"><span class="stat-label">Purchase Cost</span><strong class="stat-value">${money(summary.summary.total_purchase_cost)}</strong></div>
      <div class="stat-card"><span class="stat-label">Gross Profit</span><strong class="stat-value">${money(summary.summary.gross_profit)}</strong></div>
    `;

    document.getElementById('productsTable').innerHTML = productsRes.products.map((row) => `
      <tr>
        <td><div><strong>${escapeHtml(row.title)}</strong><div class="subtle-text">${escapeHtml(row.id)}</div></div></td>
        <td>${escapeHtml(row.primary_site || '')}</td>
        <td>${escapeHtml(row.primary_sku || '')}</td>
        <td>${Number(row.stock_on_hand || 0)}</td>
        <td>${money(row.sale_price)}</td>
        <td>${money(row.total_sales_revenue)}</td>
        <td>${money(row.total_purchase_cost)}</td>
        <td>${money(row.gross_profit)}</td>
      </tr>
    `).join('');

    document.getElementById('receiptsTable').innerHTML = receiptsRes.receipts.map((row) => `
      <tr>
        <td>${escapeHtml(row.storefront_products?.title || '')}</td>
        <td>${escapeHtml(row.site || '')}</td>
        <td>${escapeHtml(row.sku || '')}</td>
        <td>${Number(row.quantity_purchased || 0)}</td>
        <td>${Number(row.quantity_remaining || 0)}</td>
        <td>${money(row.purchase_unit_price)}</td>
        <td>${money(row.purchase_total_price)}</td>
        <td>${escapeHtml(row.source_order_id || '')}</td>
      </tr>
    `).join('');

    document.getElementById('pricingTable').innerHTML = pricingRes.overrides.map((row) => `
      <tr>
        <td>${escapeHtml(row.site || '')}</td>
        <td>${escapeHtml(row.sku || '')}</td>
        <td>${money(row.sale_price)}</td>
        <td>${escapeHtml(row.notes || '')}</td>
        <td>${escapeHtml(new Date(row.updated_at).toLocaleString())}</td>
      </tr>
    `).join('');

    setMessage('Storefront admin loaded.');
  } catch (err) {
    setMessage(err.message || 'Could not load store admin.');
  }
}

document.querySelectorAll('[data-store-pane-button]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const pane = btn.getAttribute('data-store-pane-button');
    document.querySelectorAll('[data-store-pane-button]').forEach((el) => el.classList.remove('is-active'));
    document.querySelectorAll('[data-store-pane]').forEach((el) => el.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.querySelector(`[data-store-pane="${pane}"]`)?.classList.add('is-active');
  });
});

document.getElementById('manualProductForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/store/products/manual', { method: 'POST', body: JSON.stringify(formToObject(e.target)) });
    setMessage('Manual product saved.');
    e.target.reset();
    loadAll();
  } catch (err) { setMessage(err.message); }
});

document.getElementById('pricingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/store/pricing', { method: 'POST', body: JSON.stringify(formToObject(e.target)) });
    setMessage('Price override saved.');
    e.target.reset();
    loadAll();
  } catch (err) { setMessage(err.message); }
});

document.getElementById('mergeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = formToObject(e.target);
    await api(`/admin/store/products/${body.target_id}/merge`, { method: 'POST', body: JSON.stringify({ source_product_id: body.source_id }) });
    setMessage('Products merged.');
    e.target.reset();
    loadAll();
  } catch (err) { setMessage(err.message); }
});

document.getElementById('importTargetSeedButton').addEventListener('click', async () => {
  try {
    const result = await api('/admin/store/import-target-list', { method: 'POST', body: JSON.stringify({}) });
    setMessage(`Imported ${result.imported_count} target seed rows.`);
    loadAll();
  } catch (err) { setMessage(err.message); }
});

loadAll();
window.logoutStoreAdmin = logoutStoreAdmin;
