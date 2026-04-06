const SHOP_API =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://profile-platform.onrender.com';

const shopStatus = document.getElementById('shop-status');
const shopGrid = document.getElementById('shop-grid');
const shopTabs = document.getElementById('shop-category-tabs');
const shopSearch = document.getElementById('shop-search');
const cartItemsEl = document.getElementById('shop-cart-items');
const cartCountEl = document.getElementById('shop-cart-count');
const cartSubtotalEl = document.getElementById('shop-cart-subtotal');
const cartCheckoutButton = document.getElementById('shop-cart-checkout');
const cartClearButton = document.getElementById('shop-cart-clear');

const CART_KEY = 'shore-shack-public-cart-v1';

const state = {
  products: [],
  activeCategory: 'all',
  search: '',
  cart: loadCart()
};

function loadCart() {
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    window.localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  } catch {}
}

function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

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

function cartItemForProduct(productId) {
  return state.cart.find((item) => String(item.product_id) === String(productId));
}

function productById(productId) {
  return state.products.find((item) => String(item.id) === String(productId));
}

function quantityOptions(maxStock) {
  const max = Math.max(1, Math.min(25, Number(maxStock || 1)));
  return Array.from({ length: max }, (_, index) => {
    const quantity = index + 1;
    return `<option value="${quantity}">${quantity}</option>`;
  }).join('');
}

function productCard(product) {
  const image = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.title || 'Product image')}" loading="lazy" />`
    : `<div class="product-card-storefront__placeholder">No image available</div>`;

  const productUrlValue = product.source_product_url || product.product_url || '';
  const productUrl = productUrlValue
    ? `<a class="text-link" href="${escapeHtml(productUrlValue)}" target="_blank" rel="noopener noreferrer">View source listing</a>`
    : '';

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
        <div class="product-card-storefront__meta">
          <strong>${money(product.sale_price)}</strong>
          <span class="subtle-text">SKU: ${escapeHtml(product.primary_sku || '—')}</span>
        </div>
        <div class="product-card-storefront__actions product-card-storefront__actions--stacked">
          <div class="shop-buy-row">
            <select class="input input--sm shop-qty-select" data-qty-select="${escapeHtml(product.id)}" aria-label="Quantity">
              ${quantityOptions(product.stock_on_hand).replace(`value="${selectedQty}"`, `value="${selectedQty}" selected`)}
            </select>
            <button class="btn btn-primary" type="button" data-add-cart="${escapeHtml(product.id)}">${cartItem ? 'Update cart' : 'Add to cart'}</button>
            <button class="btn" type="button" data-buy-product="${escapeHtml(product.id)}">Buy now</button>
          </div>
          <div class="shop-link-row">
            ${productUrl}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderTabs(products) {
  if (!shopTabs) return;
  const counts = new Map();
  products.forEach((product) => {
    const category = product.display_category || inferCategory(product);
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  const preferred = ['Pokémon', 'One Piece'];
  const remaining = Array.from(counts.keys()).filter((name) => !preferred.includes(name)).sort((a, b) => a.localeCompare(b));
  const categories = ['all', ...preferred.filter((name) => counts.has(name)), ...remaining];
  shopTabs.innerHTML = categories.map((category) => {
    const label = category === 'all' ? 'All' : category;
    const count = category === 'all' ? products.length : counts.get(category) || 0;
    const active = state.activeCategory === category ? ' is-active' : '';
    return `<button class="shop-tab${active}" type="button" data-shop-category="${escapeHtml(category)}">${escapeHtml(label)} <span>${count}</span></button>`;
  }).join('');
  shopTabs.querySelectorAll('[data-shop-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeCategory = button.dataset.shopCategory;
      renderShop();
    });
  });
}

function filteredProducts() {
  const search = state.search.trim().toLowerCase();
  return state.products.filter((product) => {
    const category = product.display_category || inferCategory(product);
    const categoryMatch = state.activeCategory === 'all' || category === state.activeCategory;
    const text = `${product.title || ''} ${product.primary_sku || ''} ${product.description || ''}`.toLowerCase();
    const searchMatch = !search || text.includes(search);
    return categoryMatch && searchMatch;
  });
}

function upsertCartItem(product, quantity) {
  const maxStock = Math.max(1, Number(product.stock_on_hand || 1));
  const safeQty = Math.max(1, Math.min(Number(quantity || 1), maxStock));
  const existing = cartItemForProduct(product.id);
  if (existing) {
    existing.quantity = safeQty;
    existing.title = product.title;
    existing.image_url = product.image_url || '';
    existing.sale_price = Number(product.sale_price || 0);
    existing.stock_on_hand = maxStock;
  } else {
    state.cart.push({
      product_id: product.id,
      quantity: safeQty,
      title: product.title,
      image_url: product.image_url || '',
      sale_price: Number(product.sale_price || 0),
      stock_on_hand: maxStock,
      primary_sku: product.primary_sku || ''
    });
  }
  saveCart();
  renderCart();
  renderShop();
}

function removeCartItem(productId) {
  state.cart = state.cart.filter((item) => String(item.product_id) !== String(productId));
  saveCart();
  renderCart();
  renderShop();
}

function renderCart() {
  if (!cartItemsEl) return;
  const enriched = state.cart.map((item) => {
    const product = productById(item.product_id);
    return {
      ...item,
      title: product?.title || item.title,
      image_url: product?.image_url || item.image_url,
      sale_price: Number(product?.sale_price ?? item.sale_price ?? 0),
      stock_on_hand: Number(product?.stock_on_hand ?? item.stock_on_hand ?? 0)
    };
  }).filter((item) => item.stock_on_hand > 0);

  state.cart = enriched.map((item) => ({ ...item, quantity: Math.min(item.quantity, item.stock_on_hand) }));
  saveCart();

  const itemCount = state.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const subtotal = state.cart.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.sale_price || 0)), 0);
  cartCountEl.textContent = String(itemCount);
  cartSubtotalEl.textContent = money(subtotal);
  cartCheckoutButton.disabled = itemCount === 0;
  cartClearButton.disabled = itemCount === 0;

  if (!state.cart.length) {
    cartItemsEl.innerHTML = '<div class="shop-empty-state">Your cart is empty.</div>';
    return;
  }

  cartItemsEl.innerHTML = state.cart.map((item) => `
    <div class="shop-cart-item">
      <div class="shop-cart-item__media">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title || 'Product image')}" loading="lazy" />` : '<div class="product-card-storefront__placeholder">No image</div>'}</div>
      <div class="shop-cart-item__body">
        <strong>${escapeHtml(item.title || 'Untitled product')}</strong>
        <div class="subtle-text">SKU: ${escapeHtml(item.primary_sku || '—')}</div>
        <div class="shop-cart-item__controls">
          <select class="input input--sm" data-cart-qty="${escapeHtml(item.product_id)}">${quantityOptions(item.stock_on_hand).replace(`value="${item.quantity}"`, `value="${item.quantity}" selected`)}</select>
          <span>${money(item.sale_price)}</span>
          <button class="btn btn-danger btn-danger--ghost" type="button" data-remove-cart="${escapeHtml(item.product_id)}">Remove</button>
        </div>
      </div>
    </div>
  `).join('');

  cartItemsEl.querySelectorAll('[data-cart-qty]').forEach((select) => {
    select.addEventListener('change', () => {
      const product = productById(select.dataset.cartQty);
      if (product) upsertCartItem(product, Number(select.value || 1));
    });
  });

  cartItemsEl.querySelectorAll('[data-remove-cart]').forEach((button) => {
    button.addEventListener('click', () => removeCartItem(button.dataset.removeCart));
  });
}

async function startCheckout(items) {
  const response = await fetch(SHOP_API + '/public/store/checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(items.length === 1
      ? { product_id: items[0].product_id, quantity: items[0].quantity }
      : { items: items.map((item) => ({ product_id: item.product_id, quantity: item.quantity })) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Checkout failed (${response.status})`);
  if (!payload.url) throw new Error('Stripe checkout link was not returned');
  window.location.href = payload.url;
}

function bindProductButtons() {
  shopGrid.querySelectorAll('[data-add-cart]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = productById(button.dataset.addCart);
      const select = shopGrid.querySelector(`[data-qty-select="${CSS.escape(button.dataset.addCart)}"]`);
      if (!product || !select) return;
      upsertCartItem(product, Number(select.value || 1));
      shopStatus.textContent = `${product.title || 'Item'} added to cart.`;
    });
  });

  shopGrid.querySelectorAll('[data-buy-product]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.buyProduct;
      const select = shopGrid.querySelector(`[data-qty-select="${CSS.escape(id)}"]`);
      const quantity = Math.max(1, Number(select?.value || 1) || 1);
      button.disabled = true;
      button.textContent = 'Starting checkout...';
      try {
        await startCheckout([{ product_id: id, quantity }]);
      } catch (error) {
        console.error(error);
        shopStatus.textContent = error.message || 'Could not start checkout.';
        button.disabled = false;
        button.textContent = 'Buy now';
      }
    });
  });
}

function renderShop() {
  renderTabs(state.products);
  const products = filteredProducts();
  if (!state.products.length) {
    shopStatus.textContent = 'The public shop is live, but there are no active products listed right now.';
    shopGrid.innerHTML = '';
    renderCart();
    return;
  }
  shopStatus.textContent = `${products.length} product${products.length === 1 ? '' : 's'} shown.`;
  if (!products.length) {
    shopGrid.innerHTML = '<div class="shop-empty-state">No products matched this category or search.</div>';
    renderCart();
    return;
  }
  shopGrid.innerHTML = products.map(productCard).join('');
  bindProductButtons();
  renderCart();
}

async function loadShop() {
  try {
    const response = await fetch(SHOP_API + '/public/store/products', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Unable to load shop (${response.status})`);
    const products = Array.isArray(payload.products) ? payload.products : [];
    state.products = products.map((product) => ({ ...product, display_category: inferCategory(product) }));
    renderShop();
  } catch (error) {
    console.error(error);
    shopStatus.textContent = error.message || 'The shop could not load products right now. Please try again later.';
    shopGrid.innerHTML = '';
  }
}

shopSearch?.addEventListener('input', (event) => {
  state.search = event.target.value || '';
  renderShop();
});

cartClearButton?.addEventListener('click', () => {
  state.cart = [];
  saveCart();
  renderCart();
  renderShop();
});

cartCheckoutButton?.addEventListener('click', async () => {
  if (!state.cart.length) return;
  cartCheckoutButton.disabled = true;
  cartCheckoutButton.textContent = 'Starting checkout...';
  try {
    await startCheckout(state.cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity })));
  } catch (error) {
    console.error(error);
    shopStatus.textContent = error.message || 'Could not start cart checkout.';
    cartCheckoutButton.disabled = false;
    cartCheckoutButton.textContent = 'Checkout cart';
  }
});

loadShop();
