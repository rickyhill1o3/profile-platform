
const SHOP_API =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://profile-platform.onrender.com';

const CART_KEY = 'shore-shack-public-cart-v2';
const CUSTOMER_EMAIL_KEY = 'shore-shack-shop-email-v1';
const elements = {
  status: document.getElementById('shop-status'),
  grid: document.getElementById('shop-grid'),
  tabs: document.getElementById('shop-category-tabs'),
  search: document.getElementById('shop-search'),
  cartItems: document.getElementById('shop-cart-items'),
  cartCount: document.getElementById('shop-cart-count'),
  cartSubtotal: document.getElementById('shop-cart-subtotal'),
  cartShipping: document.getElementById('shop-cart-shipping'),
  cartDiscount: document.getElementById('shop-cart-discount'),
  cartTotal: document.getElementById('shop-cart-total'),
  cartCheckout: document.getElementById('shop-cart-checkout'),
  cartClear: document.getElementById('shop-cart-clear'),
  discountCode: document.getElementById('shop-discount-code'),
  discountApply: document.getElementById('shop-apply-discount'),
  discountMessage: document.getElementById('shop-discount-message'),
  customerEmail: document.getElementById('shop-customer-email')
};
const state = { products: [], activeCategory: 'all', search: '', cart: loadCart(), appliedDiscount: null };

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}
function loadCart() {
  try { const parsed = JSON.parse(window.localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function saveCart() { window.localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); }
function loadEmail() { return window.localStorage.getItem(CUSTOMER_EMAIL_KEY) || ''; }
function saveEmail() { const email = String(elements.customerEmail?.value || '').trim(); window.localStorage.setItem(CUSTOMER_EMAIL_KEY, email); return email; }
function inferCategory(product) {
  const haystack = `${product.category || ''} ${product.title || ''} ${product.description || ''}`.toLowerCase();
  if (haystack.includes('one piece')) return 'One Piece';
  if (haystack.includes('pokemon') || haystack.includes('pokémon')) return 'Pokémon';
  if (haystack.includes('lorcana')) return 'Lorcana';
  if (haystack.includes('dragon ball')) return 'Dragon Ball';
  if (haystack.includes('yugioh') || haystack.includes('yu-gi-oh')) return 'Yu-Gi-Oh!';
  if (haystack.includes('magic') || haystack.includes('mtg')) return 'Magic';
  if (haystack.includes('supreme')) return 'Supreme';
  return 'Other';
}
function productById(productId) { return state.products.find((item) => String(item.id) === String(productId)); }
function cartItemForProduct(productId) { return state.cart.find((item) => String(item.product_id) === String(productId)); }
function quantityOptions(maxStock, selectedQty) {
  const max = Math.max(1, Math.min(25, Number(maxStock || 1)));
  return Array.from({ length: max }, (_, index) => {
    const quantity = index + 1;
    return `<option value="${quantity}" ${quantity === selectedQty ? 'selected' : ''}>${quantity}</option>`;
  }).join('');
}
function shippingEstimateForQuantity(totalQuantity) {
  const qty = Math.max(0, Number(totalQuantity || 0));
  if (!qty) return { label: 'No items', amount: 0 };
  if (qty <= 2) return { label: '1-2 items', amount: 6.99 };
  if (qty <= 4) return { label: '3-4 items', amount: 9.99 };
  if (qty <= 10) return { label: '5-10 items', amount: 14.99 };
  return { label: '11+ items', amount: 19.99 };
}
function cartQuantity() { return state.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0); }
function cartSubtotal() { return state.cart.reduce((sum, item) => sum + Number(item.sale_price || 0) * Number(item.quantity || 0), 0); }
function cartShipping() {
  const estimate = shippingEstimateForQuantity(cartQuantity());
  const shippingDiscount = Number(state.appliedDiscount?.shippingDiscount || 0);
  return Math.max(0, Number((estimate.amount - shippingDiscount).toFixed(2)));
}
function cartDiscountAmount() { return Number(state.appliedDiscount?.discountAmount || 0) + Number(state.appliedDiscount?.shippingDiscount || 0); }
function cartTotal() { return Math.max(0, Number((cartSubtotal() + cartShipping() - Number(state.appliedDiscount?.discountAmount || 0)).toFixed(2))); }

function upsertCartItem(product, quantity) {
  if (!product) return;
  const max = Math.max(1, Number(product.stock_on_hand || 1));
  const safeQty = Math.max(1, Math.min(max, Number(quantity || 1)));
  const current = cartItemForProduct(product.id);
  if (current) {
    current.quantity = safeQty; current.sale_price = Number(product.sale_price || 0); current.title = product.title || 'Product'; current.image_url = product.image_url || '';
  } else {
    state.cart.push({ product_id: String(product.id), quantity: safeQty, sale_price: Number(product.sale_price || 0), title: product.title || 'Product', image_url: product.image_url || '', sku: product.primary_sku || '' });
  }
  saveCart(); renderShop();
}
function removeCartItem(productId) { state.cart = state.cart.filter((item) => String(item.product_id) !== String(productId)); saveCart(); renderShop(); }

function productCard(product) {
  const image = product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.title || 'Product image')}" loading="lazy" />` : `<div class="product-card-storefront__placeholder">No image available</div>`;
  const productUrlValue = product.source_product_url || product.product_url || '';
  const productUrl = productUrlValue ? `<a class="text-link" href="${escapeHtml(productUrlValue)}" target="_blank" rel="noopener noreferrer">View source listing</a>` : '';
  const cartItem = cartItemForProduct(product.id);
  const selectedQty = Math.max(1, Math.min(Number(cartItem?.quantity || 1), Number(product.stock_on_hand || 1)));
  return `
    <article class="panel product-card-storefront product-card-storefront--public product-card-storefront--compact">
      <div class="product-card-storefront__media product-card-storefront__media--shop">${image}</div>
      <div class="product-card-storefront__body">
        <div class="product-card-storefront__header">
          <span class="selection-chip">${escapeHtml(product.display_category || 'Other')}</span>
          <span class="selection-chip selection-chip--empty">${Number(product.stock_on_hand || 0)} in stock</span>
        </div>
        <div>
          <h3>${escapeHtml(product.title || 'Untitled product')}</h3>
          <p class="subtle-text product-card-storefront__description">${escapeHtml(product.description || 'Available in the public shop.')}</p>
        </div>
        <div class="product-card-storefront__meta"><strong>${money(product.sale_price)}</strong><span class="subtle-text">SKU: ${escapeHtml(product.primary_sku || '—')}</span></div>
        <div class="product-card-storefront__actions product-card-storefront__actions--stacked">
          <div class="shop-buy-row">
            <select class="input input--sm shop-qty-select" data-qty-select="${escapeHtml(product.id)}">${quantityOptions(product.stock_on_hand, selectedQty)}</select>
            <button class="btn btn-primary" type="button" data-add-cart="${escapeHtml(product.id)}">${cartItem ? 'Update cart' : 'Add to cart'}</button>
            <button class="btn" type="button" data-buy-product="${escapeHtml(product.id)}">Buy now</button>
          </div>
          <div class="shop-link-row">${productUrl}</div>
        </div>
      </div>
    </article>`;
}
function renderTabs(products) {
  const counts = new Map();
  products.forEach((product) => { const category = product.display_category || inferCategory(product); counts.set(category, (counts.get(category) || 0) + 1); });
  const preferred = ['Pokémon', 'One Piece'];
  const remaining = Array.from(counts.keys()).filter((name) => !preferred.includes(name)).sort((a, b) => a.localeCompare(b));
  const categories = ['all', ...preferred.filter((name) => counts.has(name)), ...remaining];
  elements.tabs.innerHTML = categories.map((category) => {
    const label = category === 'all' ? 'All' : category;
    const count = category === 'all' ? products.length : counts.get(category) || 0;
    const active = state.activeCategory === category ? ' is-active' : '';
    return `<button class="shop-tab${active}" type="button" data-shop-category="${escapeHtml(category)}">${escapeHtml(label)} <span>${count}</span></button>`;
  }).join('');
  elements.tabs.querySelectorAll('[data-shop-category]').forEach((button) => button.addEventListener('click', () => { state.activeCategory = button.dataset.shopCategory; renderShop(); }));
}
function filteredProducts() {
  const search = state.search.trim().toLowerCase();
  return state.products.filter((product) => {
    const category = product.display_category || inferCategory(product);
    const matchCategory = state.activeCategory === 'all' || category === state.activeCategory;
    const haystack = `${product.title || ''} ${product.description || ''} ${product.primary_sku || ''}`.toLowerCase();
    const matchSearch = !search || haystack.includes(search);
    return matchCategory && matchSearch;
  });
}
function renderCart() {
  elements.cartItems.innerHTML = !state.cart.length ? '<div class="shop-empty-state">Your cart is empty.</div>' : state.cart.map((item) => `
      <article class="shop-cart-item">
        <div class="shop-cart-item__media">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" />` : ''}</div>
        <div class="shop-cart-item__body">
          <div><strong>${escapeHtml(item.title || 'Item')}</strong><div class="subtle-text">SKU: ${escapeHtml(item.sku || '—')}</div></div>
          <div class="shop-cart-item__controls">
            <label class="subtle-text">Qty</label>
            <input class="input input--sm" type="number" min="1" step="1" value="${Number(item.quantity || 1)}" data-cart-qty="${escapeHtml(item.product_id)}" />
            <span class="subtle-text">${money(item.sale_price)} each</span>
            <button class="btn btn-danger" type="button" data-remove-cart="${escapeHtml(item.product_id)}">Remove</button>
          </div>
        </div>
      </article>`).join('');
  elements.cartCount.textContent = String(cartQuantity());
  elements.cartSubtotal.textContent = money(cartSubtotal());
  elements.cartShipping.textContent = money(cartShipping());
  elements.cartDiscount.textContent = `-${money(cartDiscountAmount())}`;
  elements.cartTotal.textContent = money(cartTotal());
  elements.cartItems.querySelectorAll('[data-cart-qty]').forEach((input) => input.addEventListener('change', () => { const product = productById(input.dataset.cartQty); if (product) upsertCartItem(product, Number(input.value || 1)); }));
  elements.cartItems.querySelectorAll('[data-remove-cart]').forEach((button) => button.addEventListener('click', () => removeCartItem(button.dataset.removeCart)));
}
async function applyDiscount() {
  const code = String(elements.discountCode?.value || '').trim();
  if (!code) { state.appliedDiscount = null; elements.discountMessage.textContent = 'Enter a code to apply a discount.'; renderCart(); return; }
  const response = await fetch(SHOP_API + '/api/discounts/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, cartTotal: cartSubtotal(), shippingTotal: shippingEstimateForQuantity(cartQuantity()).amount, email: saveEmail() })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { state.appliedDiscount = null; elements.discountMessage.textContent = payload.error || 'Could not apply that code.'; renderCart(); return; }
  state.appliedDiscount = payload;
  elements.discountCode.value = payload.code || code.toUpperCase();
  const parts = []; if (Number(payload.discountAmount || 0) > 0) parts.push(`${money(payload.discountAmount)} off`); if (Number(payload.shippingDiscount || 0) > 0) parts.push('free shipping');
  elements.discountMessage.textContent = `${payload.code} applied • ${parts.join(' + ') || 'discount active'}`;
  renderCart();
}
async function startCheckout(items) {
  const body = items.length === 1 ? { product_id: items[0].product_id, quantity: items[0].quantity } : { items: items.map((item) => ({ product_id: item.product_id, quantity: item.quantity })) };
  if (state.appliedDiscount?.code) body.discount_code = state.appliedDiscount.code;
  const customerEmail = saveEmail(); if (customerEmail) body.customer_email = customerEmail;
  const response = await fetch(SHOP_API + '/public/store/checkout-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Checkout failed (${response.status})`);
  if (!payload.url) throw new Error('Stripe checkout link was not returned');
  window.location.href = payload.url;
}
function bindProductButtons() {
  elements.grid.querySelectorAll('[data-add-cart]').forEach((button) => button.addEventListener('click', () => {
    const product = productById(button.dataset.addCart);
    const select = elements.grid.querySelector(`[data-qty-select="${CSS.escape(button.dataset.addCart)}"]`);
    if (product && select) { upsertCartItem(product, Number(select.value || 1)); elements.status.textContent = `${product.title || 'Item'} added to cart.`; }
  }));
  elements.grid.querySelectorAll('[data-buy-product]').forEach((button) => button.addEventListener('click', async () => {
    const select = elements.grid.querySelector(`[data-qty-select="${CSS.escape(button.dataset.buyProduct)}"]`);
    const quantity = Math.max(1, Number(select?.value || 1) || 1);
    button.disabled = true; button.textContent = 'Starting checkout...';
    try { await startCheckout([{ product_id: button.dataset.buyProduct, quantity }]); }
    catch (error) { console.error(error); elements.status.textContent = error.message || 'Could not start checkout.'; }
    finally { button.disabled = false; button.textContent = 'Buy now'; }
  }));
}
function renderShop() {
  renderTabs(state.products);
  const products = filteredProducts();
  if (!state.products.length) { elements.status.textContent = 'The public shop is live, but there are no active products listed right now.'; elements.grid.innerHTML = ''; renderCart(); return; }
  elements.status.textContent = `${products.length} product${products.length === 1 ? '' : 's'} shown.`;
  if (!products.length) { elements.grid.innerHTML = '<div class="shop-empty-state">No products matched this category or search.</div>'; renderCart(); return; }
  elements.grid.innerHTML = products.map(productCard).join(''); bindProductButtons(); renderCart();
}
async function loadShop() {
  try {
    const response = await fetch(SHOP_API + '/public/store/products', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Unable to load shop (${response.status})`);
    state.products = (Array.isArray(payload.products) ? payload.products : []).map((product) => ({ ...product, display_category: inferCategory(product) }));
    renderShop();
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') { state.cart = []; state.appliedDiscount = null; saveCart(); elements.status.textContent = 'Order placed successfully. Check your email for the receipt.'; renderCart(); }
    if (params.get('checkout') === 'cancel') { elements.status.textContent = 'Checkout was canceled. Your cart is still here.'; }
  } catch (error) { console.error(error); elements.status.textContent = error.message || 'The shop could not load products right now. Please try again later.'; elements.grid.innerHTML = ''; }
}
elements.search?.addEventListener('input', (event) => { state.search = event.target.value || ''; renderShop(); });
elements.customerEmail.value = loadEmail();
elements.customerEmail?.addEventListener('input', saveEmail);
elements.discountApply?.addEventListener('click', () => applyDiscount().catch((error) => { console.error(error); elements.discountMessage.textContent = error.message || 'Could not apply that code.'; }));
elements.cartClear?.addEventListener('click', () => { state.cart = []; state.appliedDiscount = null; saveCart(); renderShop(); });
elements.cartCheckout?.addEventListener('click', async () => {
  if (!state.cart.length) return;
  elements.cartCheckout.disabled = true; elements.cartCheckout.textContent = 'Starting checkout...';
  try { await startCheckout(state.cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity }))); }
  catch (error) { console.error(error); elements.status.textContent = error.message || 'Could not start cart checkout.'; }
  finally { elements.cartCheckout.disabled = false; elements.cartCheckout.textContent = 'Checkout cart'; }
});
loadShop();
