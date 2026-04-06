const SHOP_API =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://profile-platform.onrender.com";

const shopStatus = document.getElementById('shop-status');
const shopGrid = document.getElementById('shop-grid');
const shopTabs = document.getElementById('shop-category-tabs');
const shopSearch = document.getElementById('shop-search');

const state = {
  products: [],
  activeCategory: 'all',
  search: ''
};

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

function productCard(product) {
  const image = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.title || 'Product image')}" loading="lazy" />`
    : `<div class="product-card-storefront__placeholder">No image available</div>`;

  const productUrlValue = product.source_product_url || product.product_url || '';
  const productUrl = productUrlValue
    ? `<a class="text-link" href="${escapeHtml(productUrlValue)}" target="_blank" rel="noopener noreferrer">View source listing</a>`
    : '';

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
        <div class="product-card-storefront__actions">
          <button class="btn btn-primary" type="button" data-buy-product="${escapeHtml(product.id)}">Buy now</button>
          ${productUrl}
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
  const categories = ['all', ...Array.from(counts.keys()).sort((a, b) => a.localeCompare(b))];
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

function bindBuyButtons() {
  shopGrid.querySelectorAll('[data-buy-product]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.buyProduct;
      button.disabled = true;
      button.textContent = 'Starting checkout...';
      try {
        const response = await fetch(SHOP_API + '/public/store/checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ product_id: id, quantity: 1 })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Checkout failed (${response.status})`);
        if (payload.url) window.location.href = payload.url;
        else throw new Error('Stripe checkout link was not returned');
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
    return;
  }
  shopStatus.textContent = `${products.length} product${products.length === 1 ? '' : 's'} shown.`;
  if (!products.length) {
    shopGrid.innerHTML = '<div class="shop-empty-state">No products matched this category or search.</div>';
    return;
  }
  shopGrid.innerHTML = products.map(productCard).join('');
  bindBuyButtons();
}

async function loadShop() {
  try {
    const response = await fetch(SHOP_API + '/public/store/products', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Unable to load shop (${response.status})`);
    }
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

loadShop();
