const shopStatus = document.getElementById('shop-status');
const shopGrid = document.getElementById('shop-grid');

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

function productCard(product) {
  const image = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.title || 'Product image')}" loading="lazy" />`
    : `<div class="product-card-storefront__placeholder">No image available</div>`;

  const productUrlValue = product.source_product_url || product.product_url || '';
  const productUrl = productUrlValue
    ? `<a class="text-link" href="${escapeHtml(productUrlValue)}" target="_blank" rel="noopener noreferrer">View source listing</a>`
    : '';

  return `
    <article class="panel product-card-storefront product-card-storefront--public">
      <div class="product-card-storefront__media">${image}</div>
      <div class="product-card-storefront__body">
        <div>
          <h3>${escapeHtml(product.title || 'Untitled product')}</h3>
          <p class="subtle-text">${escapeHtml(product.description || 'Available in the public shop.')}</p>
        </div>
        <div class="product-card-storefront__meta">
          <strong>${money(product.sale_price)}</strong>
          <span class="selection-chip">${Number(product.stock_on_hand || 0)} in stock</span>
        </div>
        <div class="product-card-storefront__actions">
          <button class="btn btn-primary" type="button" data-buy-product="${escapeHtml(product.id)}">Buy now</button>
          ${productUrl}
        </div>
      </div>
    </article>
  `;
}

async function loadShop() {
  try {
    const response = await fetch('/public/store/products', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Unable to load shop (${response.status})`);
    }

    const payload = await response.json();
    const products = Array.isArray(payload.products) ? payload.products : [];

    if (!products.length) {
      shopStatus.textContent = 'The public shop is live, but there are no active products listed right now.';
      shopGrid.innerHTML = '';
      return;
    }

    shopStatus.textContent = `${products.length} product${products.length === 1 ? '' : 's'} available in the public shop.`;
    shopGrid.innerHTML = products.map(productCard).join('');
    shopGrid.querySelectorAll('[data-buy-product]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.buyProduct;
        button.disabled = true;
        button.textContent = 'Starting checkout...';
        try {
          const response = await fetch('/public/store/checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ product_id: id, quantity: 1 })
          });
          const payload = await response.json();
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
  } catch (error) {
    console.error(error);
    shopStatus.textContent = 'The shop could not load products right now. Please try again later.';
    shopGrid.innerHTML = '';
  }
}

loadShop();
