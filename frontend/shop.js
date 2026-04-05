const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://profile-platform.onrender.com';

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadProducts() {
  const msg = document.getElementById('shopMessage');
  const grid = document.getElementById('shopGrid');
  const stats = document.getElementById('shopStats');
  try {
    const res = await fetch(`${API}/public/store/products`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const products = Array.isArray(data.products) ? data.products : [];
    msg.textContent = products.length ? 'Inventory is live. Taxes are calculated in Stripe Checkout from the shipping address you enter.' : 'No inventory is live yet.';
    stats.innerHTML = `
      <div class="stat-card"><span class="stat-label">Products</span><strong class="stat-value">${products.length}</strong></div>
      <div class="stat-card"><span class="stat-label">Units In Stock</span><strong class="stat-value">${products.reduce((sum, p) => sum + Number(p.stock_on_hand || 0), 0)}</strong></div>
    `;
    grid.innerHTML = products.map((product) => `
      <article class="panel product-card-storefront">
        <div class="product-card-storefront__media">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.title)}" />` : '<div class="product-card-storefront__placeholder">No image</div>'}</div>
        <div class="product-card-storefront__body">
          <div class="eyebrow">${escapeHtml(product.primary_site || 'store')}</div>
          <h3>${escapeHtml(product.title)}</h3>
          <p class="subtle-text">${escapeHtml(product.description || `${product.primary_site || ''} SKU ${product.primary_sku || ''}`)}</p>
          <div class="product-card-storefront__meta">
            <strong>${money(product.sale_price)}</strong>
            <span>${Number(product.stock_on_hand || 0)} in stock</span>
          </div>
          <div class="panel-actions">
            <label class="field" style="min-width:90px;">
              <span class="subtle-text">Qty</span>
              <input class="input" type="number" min="1" max="${Number(product.stock_on_hand || 1)}" value="1" id="qty-${product.id}" />
            </label>
            <button class="btn btn-primary" onclick="checkout('${product.id}')">Buy now</button>
          </div>
        </div>
      </article>
    `).join('');
  } catch (err) {
    msg.textContent = err.message || 'Could not load inventory.';
    grid.innerHTML = '';
  }
}

async function checkout(productId) {
  const qtyInput = document.getElementById(`qty-${productId}`);
  const quantity = Math.max(1, Number(qtyInput?.value || 1) || 1);
  const msg = document.getElementById('shopMessage');
  msg.textContent = 'Starting checkout...';
  try {
    const res = await fetch(`${API}/public/store/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, quantity })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    window.location.href = data.url;
  } catch (err) {
    msg.textContent = err.message || 'Checkout could not be started.';
  }
}

loadProducts();
window.checkout = checkout;
