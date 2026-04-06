const SHOP_API = (() => {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocal) return 'http://localhost:3000';
  return 'https://theshoreshacktcg.com';
})();

function fmt(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

async function loadOrderConfirmation() {
  const state = document.getElementById('confirmState');
  const content = document.getElementById('confirmContent');
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session_id');

  if (!sessionId) {
    state.textContent = 'We could not find your order confirmation.';
    return;
  }

  try {
    const response = await fetch(`${SHOP_API}/public/store/order-confirmation?session_id=${encodeURIComponent(sessionId)}`);
    const data = await response.json();
    if (!response.ok || !data?.success) throw new Error(data?.error || 'Could not load order');

    const order = data.order || {};
    const items = Array.isArray(data.items) ? data.items : [];
    document.getElementById('confirmItems').innerHTML = items.map((item) => `
      <div class="confirm-item">
        ${item.product?.image_url ? `<img src="${item.product.image_url}" alt="">` : ''}
        <div>
          <div style="font-weight:700; font-size:18px">${item.product?.title || 'Item'}</div>
          <div style="color:#64748b; margin-top:4px">${(item.product?.primary_site || '').toUpperCase()} ${item.product?.primary_sku ? `SKU ${item.product.primary_sku}` : ''}</div>
          <div style="margin-top:8px">Qty ${item.quantity} · ${fmt(item.unit_price)} each</div>
          <div style="margin-top:4px; font-weight:600">Line total ${fmt(item.total)}</div>
        </div>
      </div>
    `).join('');

    document.getElementById('confirmOrderMeta').innerHTML = `Order <strong>${order.order_number || ''}</strong><br>${order.customer_email || ''}`;
    document.getElementById('sumSubtotal').textContent = fmt(order.subtotal);
    document.getElementById('sumShipping').textContent = fmt(order.shipping);
    document.getElementById('sumTax').textContent = fmt(order.tax);
    document.getElementById('sumTotal').textContent = fmt(order.total);

    const ship = order.shipping_address || {};
    const shipParts = [order.shipping_name, ship.line1, ship.line2, [ship.city, ship.state, ship.postal_code].filter(Boolean).join(', '), ship.country].filter(Boolean);
    document.getElementById('confirmShipTo').innerHTML = shipParts.length ? `<strong>Shipping to</strong><br>${shipParts.join('<br>')}` : '';

    state.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    state.textContent = err.message || 'Could not load order confirmation.';
  }
}

loadOrderConfirmation();