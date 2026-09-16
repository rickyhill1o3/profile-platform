const RAFFLE_API =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://profile-platform.onrender.com';

const raffleState = { raffles: [], tick: null, poll: null, refreshTimeout: null };
const raffleCheckoutState = new URLSearchParams(window.location.search).get('checkout');
const raffleElements = {
  list: document.getElementById('raffle-list'),
  message: document.getElementById('raffle-page-message')
};

function raffleEscape(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function raffleMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function raffleDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function raffleToken() {
  return String(window.localStorage.getItem('token') || '').trim();
}

function countdownParts(target) {
  const remaining = Math.max(0, new Date(target || 0).getTime() - Date.now());
  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { remaining, label: `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s` };
}

function statusLabel(status) {
  return ({
    scheduled: 'Starts soon', live: 'Drawing open', closed: 'Drawing now', drawing: 'Selecting winner',
    draw_error: 'Draw needs attention', no_eligible: 'No member entries', winner_selected: 'Winner selected',
    claim_expired: 'Claim expired', paid: 'Winner purchased', fulfilled: 'Prize fulfilled', canceled: 'Canceled'
  })[status] || status;
}

function actionMarkup(raffle) {
  if (raffle.viewer_is_winner && raffle.free_prize && raffle.status === 'winner_selected') {
    return '<div class="raffle-winner-box"><strong>You won this free prize!</strong><span>No payment is required. The Shore Shack has your account email and will use the normal fulfillment process.</span></div>';
  }
  if (raffle.viewer_is_winner && raffle.can_checkout) {
    return `<div class="raffle-winner-box"><strong>You were selected!</strong><span>Complete checkout by ${raffleEscape(raffleDate(raffle.claim_expires_at))}. The same secure checkout link was sent to your account email.</span><button class="btn btn-primary" type="button" data-raffle-checkout="${raffleEscape(raffle.id)}">Buy for ${raffleEscape(raffleMoney(raffle.retail_price))} + shipping</button></div>`;
  }
  if (raffle.viewer_is_winner && raffle.winner_purchase_status === 'paid') {
    return '<div class="raffle-entered-box raffle-entered-box--paid"><strong>Purchase complete</strong><span>Your order is now in the regular storefront fulfillment flow.</span></div>';
  }
  if (raffle.viewer_is_winner && raffle.winner_purchase_status === 'fulfilled') {
    return '<div class="raffle-entered-box raffle-entered-box--paid"><strong>Free prize fulfilled</strong><span>Your prize is now in the regular storefront order flow.</span></div>';
  }
  if (raffle.entered) {
    const resultText = ['winner_selected', 'paid', 'fulfilled', 'claim_expired'].includes(raffle.status)
      ? 'The drawing is complete. The selected winner was notified privately.'
      : 'Your entry is locked in. The winner will be drawn automatically when the timer ends.';
    return `<div class="raffle-entered-box"><strong>✓ You entered this raffle</strong><span>${raffleEscape(resultText)}</span></div>`;
  }
  if (raffle.can_enter) return `<button class="btn btn-primary" type="button" data-raffle-enter="${raffleEscape(raffle.id)}">Enter raffle</button>`;
  if (!raffle.viewer_is_eligible) return '<div class="raffle-entered-box"><strong>This raffle is not assigned to your member group.</strong></div>';
  if (raffle.status === 'scheduled') return `<div class="raffle-entered-box"><strong>Entry opens ${raffleEscape(raffleDate(raffle.starts_at))}</strong><span>Come back and click Enter raffle after it opens.</span></div>`;
  if (['winner_selected', 'paid', 'fulfilled', 'claim_expired', 'closed', 'drawing', 'draw_error', 'no_eligible'].includes(raffle.status)) return '<div class="raffle-entered-box"><strong>Entry is closed</strong><span>You had to manually enter before the countdown ended.</span></div>';
  return `<div class="raffle-entered-box"><strong>${raffleEscape(statusLabel(raffle.status))}</strong></div>`;
}

function raffleCard(raffle) {
  const target = raffle.status === 'scheduled' ? raffle.starts_at : (raffle.status === 'live' ? raffle.ends_at : raffle.claim_expires_at);
  const countdownTitle = raffle.status === 'scheduled' ? 'Drawing starts in' : (raffle.status === 'live' ? 'Winner selected in' : (raffle.viewer_is_winner && raffle.can_checkout ? 'Checkout time remaining' : 'Status'));
  const countdown = target ? countdownParts(target).label : statusLabel(raffle.status);
  const image = raffle.image_url ? `<img src="${raffleEscape(raffle.image_url)}" alt="${raffleEscape(raffle.title)}" />` : '<div class="raffle-card__placeholder">Reserved prize</div>';
  const market = Number(raffle.market_value_high || raffle.market_value_low || 0) > 0
    ? `<span><small>Approx. market</small><strong>${raffleMoney(raffle.market_value_low)}${Number(raffle.market_value_high || 0) > Number(raffle.market_value_low || 0) ? `–${raffleMoney(raffle.market_value_high)}` : ''}</strong></span>` : '';
  const price = raffle.free_prize
    ? '<span><small>Winner price</small><strong>FREE</strong></span><span><small>Shipping</small><strong>Included</strong></span>'
    : `<span><small>Winner price</small><strong>${raffleMoney(raffle.retail_price)}</strong></span><span><small>Shipping</small><strong>${raffleMoney(raffle.shipping_price)}</strong></span>`;
  return `<article class="panel raffle-card" data-raffle-card="${raffleEscape(raffle.id)}">
    <div class="raffle-card__media">${image}<span class="raffle-status raffle-status--${raffleEscape(raffle.status)}">${raffleEscape(statusLabel(raffle.status))}</span></div>
    <div class="raffle-card__body">
      <div><p class="eyebrow">Members-only · ${raffleEscape(raffle.audience_label)}</p><h2>${raffleEscape(raffle.title)}</h2><p class="subtle-text">${raffleEscape(raffle.description || 'One reserved prize will be assigned by an automatic random drawing at the end of the timer.')}</p></div>
      <div class="raffle-price-grid">${price}${market}<span><small>Manual entries</small><strong>${Number(raffle.entry_count || 0)}</strong></span></div>
      <div class="raffle-countdown"><span>${raffleEscape(countdownTitle)}</span><strong data-raffle-countdown="${raffleEscape(target || '')}" data-raffle-status="${raffleEscape(raffle.status)}">${raffleEscape(countdown)}</strong><small>${raffle.status === 'live' ? `Ends ${raffleEscape(raffleDate(raffle.ends_at))}` : raffleEscape(statusLabel(raffle.status))}</small></div>
      ${actionMarkup(raffle)}
      ${raffle.terms ? `<details class="raffle-terms"><summary>Raffle terms</summary><p>${raffleEscape(raffle.terms)}</p></details>` : ''}
    </div>
  </article>`;
}

function renderRaffles() {
  if (!raffleState.raffles.length) {
    raffleElements.list.innerHTML = '<div class="panel raffle-empty"><h2>No raffle is available for your account right now.</h2><p class="subtle-text">All-member raffles and raffles for your admin group will appear here automatically.</p><a class="btn" href="dashboard.html">Back to dashboard</a></div>';
    return;
  }
  raffleElements.list.innerHTML = raffleState.raffles.map(raffleCard).join('');
  raffleElements.list.querySelectorAll('[data-raffle-enter]').forEach((button) => button.addEventListener('click', () => enterRaffle(button)));
  raffleElements.list.querySelectorAll('[data-raffle-checkout]').forEach((button) => button.addEventListener('click', () => checkoutRaffle(button)));
  updateCountdowns();
}

function updateCountdowns() {
  document.querySelectorAll('[data-raffle-countdown]').forEach((element) => {
    const target = element.dataset.raffleCountdown;
    if (!target) return;
    const result = countdownParts(target);
    element.textContent = result.label;
    if (!result.remaining && ['live', 'scheduled', 'closed', 'drawing'].includes(element.dataset.raffleStatus)) {
      window.clearTimeout(raffleState.refreshTimeout);
      raffleState.refreshTimeout = window.setTimeout(loadRaffles, 1200);
    }
  });
}

async function raffleRequest(path, options = {}) {
  const response = await fetch(RAFFLE_API + path, {
    ...options,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${raffleToken()}`, ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.localStorage.removeItem('token');
    window.location.href = 'login.html';
    throw new Error('Please sign in again.');
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function loadRaffles() {
  if (!raffleToken()) { window.location.replace('login.html'); return; }
  try {
    const payload = await raffleRequest('/raffles');
    raffleState.raffles = Array.isArray(payload.raffles) ? payload.raffles : [];
    raffleElements.message.textContent = 'Raffles are members-only. You must manually enter each raffle before its countdown ends; having an account alone does not enter you.';
    raffleElements.message.classList.remove('banner--error', 'banner--success');
    if (raffleCheckoutState === 'success') {
      raffleElements.message.textContent = 'Payment received. Your raffle purchase is now in the regular storefront order and fulfillment flow.';
      raffleElements.message.classList.add('banner--success');
    } else if (raffleCheckoutState === 'cancel') {
      raffleElements.message.textContent = 'Checkout was canceled. You can reopen it here before your claim deadline.';
    }
    renderRaffles();
  } catch (error) {
    console.error(error);
    raffleElements.message.textContent = error.message || 'Raffles could not be loaded.';
    raffleElements.message.classList.add('banner--error');
    raffleElements.list.innerHTML = '';
  }
}

async function enterRaffle(button) {
  const id = button.dataset.raffleEnter;
  button.disabled = true;
  button.textContent = 'Entering…';
  try {
    await raffleRequest(`/raffles/${encodeURIComponent(id)}/enter`, { method: 'POST' });
    await loadRaffles();
    raffleElements.message.textContent = 'Your raffle entry is confirmed.';
    raffleElements.message.classList.remove('banner--error');
    raffleElements.message.classList.add('banner--success');
  } catch (error) {
    raffleElements.message.textContent = error.message || 'The raffle entry could not be saved.';
    raffleElements.message.classList.add('banner--error');
    button.disabled = false;
    button.textContent = 'Enter raffle';
  }
}

async function checkoutRaffle(button) {
  const id = button.dataset.raffleCheckout;
  button.disabled = true;
  button.textContent = 'Opening secure checkout…';
  try {
    const payload = await raffleRequest(`/raffles/${encodeURIComponent(id)}/checkout-session`, { method: 'POST' });
    if (!payload.url) throw new Error('Stripe checkout link was not returned.');
    window.location.href = payload.url;
  } catch (error) {
    raffleElements.message.textContent = error.message || 'Winner checkout could not be opened.';
    raffleElements.message.classList.add('banner--error');
    button.disabled = false;
    button.textContent = 'Open winner checkout';
  }
}

raffleState.tick = window.setInterval(updateCountdowns, 1000);
raffleState.poll = window.setInterval(loadRaffles, 5000);
loadRaffles();
