const crypto = require('crypto');

const RAFFLE_SETUP_FILE = 'backend/sql/STOREFRONT_RAFFLES.sql';
const AUTOMATIC_DRAW_INTERVAL_MS = 5000;

function dollarsToCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : null;
}

function centsToDollars(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number((number / 100).toFixed(2)) : 0;
}

function raffleSchemaMissing(error) {
  const text = `${error?.code || ''} ${error?.message || error || ''}`.toLowerCase();
  return text.includes('storefront_raffle') && (
    text.includes('does not exist') || text.includes('schema cache') ||
    text.includes('could not find') || text.includes('42p01')
  );
}

function deriveRaffleStatus(raffle, nowValue = Date.now()) {
  const stored = String(raffle?.status || '').trim().toLowerCase();
  if (['paid', 'fulfilled', 'canceled', 'drawing', 'draw_error', 'no_eligible'].includes(stored)) return stored;

  const now = Number(nowValue instanceof Date ? nowValue.getTime() : nowValue);
  if (raffle?.winner_user_id || raffle?.winner_entry_id) {
    if (String(raffle?.fulfillment_mode || 'purchase') === 'free') return 'winner_selected';
    const claimExpiry = new Date(raffle?.claim_expires_at || 0).getTime();
    return claimExpiry && claimExpiry <= now ? 'claim_expired' : 'winner_selected';
  }

  const startsAt = new Date(raffle?.starts_at || 0).getTime();
  const endsAt = new Date(raffle?.ends_at || 0).getTime();
  if (Number.isFinite(startsAt) && startsAt > now) return 'scheduled';
  if (Number.isFinite(endsAt) && endsAt <= now) return 'closed';
  return 'live';
}

function chooseRaffleWinner(entries, randomInt = crypto.randomInt) {
  const candidates = (entries || []).filter((entry) => String(entry?.winner_status || '') !== 'expired');
  if (!candidates.length) return null;
  return candidates[randomInt(candidates.length)];
}

function isActiveMember(user) {
  const role = String(user?.role || '').toLowerCase();
  return ['user', 'admin', 'super_admin'].includes(role) && !user?.revoked && Boolean(String(user?.email || '').trim());
}

function isUserEligibleForRaffle(user, raffle, groupOwnerIds = []) {
  if (!isActiveMember(user)) return false;
  if (String(raffle?.audience_type || 'all_members') === 'all_members') return true;
  return groupOwnerIds.map(String).includes(String(user?.owner_admin_id || ''));
}

function publicRaffleView(raffle, viewerUserId = '', viewerEligible = false) {
  const entries = Array.isArray(raffle.entries) ? raffle.entries : [];
  const viewerEntry = entries.find((entry) => String(entry.user_id) === String(viewerUserId)) || null;
  const status = deriveRaffleStatus(raffle);
  const viewerIsWinner = Boolean(viewerUserId && String(raffle.winner_user_id || '') === String(viewerUserId));
  const fulfillmentMode = String(raffle.fulfillment_mode || 'purchase');
  return {
    id: raffle.id,
    title: raffle.title,
    description: raffle.description || '',
    image_url: raffle.image_url || '',
    retail_price: centsToDollars(raffle.retail_price_cents),
    shipping_price: centsToDollars(raffle.shipping_price_cents),
    market_value_low: centsToDollars(raffle.market_value_low_cents),
    market_value_high: centsToDollars(raffle.market_value_high_cents),
    fulfillment_mode: fulfillmentMode,
    audience_type: raffle.audience_type || 'all_members',
    audience_label: raffle.audience_label || (raffle.audience_type === 'admin_group' ? 'Selected admin group' : 'All members'),
    starts_at: raffle.starts_at,
    ends_at: raffle.ends_at,
    status,
    entry_count: entries.length,
    eligible_member_count: Number(raffle.eligible_count || 0),
    terms: raffle.terms || '',
    winner_claim_hours: Number(raffle.winner_claim_hours || 24),
    winner_selected: Boolean(raffle.winner_user_id),
    claim_expires_at: viewerIsWinner ? raffle.claim_expires_at : null,
    viewer_is_eligible: Boolean(viewerEligible || viewerIsWinner),
    entered: Boolean(viewerEntry),
    entered_at: viewerEntry?.entered_at || null,
    can_enter: Boolean(viewerEligible && !viewerEntry && status === 'live'),
    viewer_is_winner: viewerIsWinner,
    winner_purchase_status: viewerIsWinner ? (viewerEntry?.winner_status || status) : null,
    can_checkout: viewerIsWinner && fulfillmentMode === 'purchase' && status === 'winner_selected' && String(viewerEntry?.winner_status || '') !== 'paid',
    free_prize: fulfillmentMode === 'free'
  };
}

function adminRaffleView(raffle) {
  const entries = Array.isArray(raffle.entries) ? raffle.entries : [];
  const winner = entries.find((entry) => String(entry.id) === String(raffle.winner_entry_id || '')) || null;
  return {
    ...publicRaffleView(raffle),
    linked_storefront_product_id: raffle.linked_storefront_product_id || null,
    hide_linked_product: raffle.hide_linked_product !== false,
    audience_admin_id: raffle.audience_admin_id || null,
    winner_entry_id: raffle.winner_entry_id || null,
    winner_user_id: raffle.winner_user_id || null,
    winner_email: winner?.user_email || raffle.winner_email || '',
    drawn_at: raffle.drawn_at || null,
    draw_started_at: raffle.draw_started_at || null,
    draw_error: raffle.draw_error || '',
    entries_locked_at: raffle.entries_locked_at || null,
    paid_at: raffle.paid_at || null,
    fulfilled_at: raffle.fulfilled_at || null,
    stripe_checkout_session_id: raffle.stripe_checkout_session_id || null,
    created_at: raffle.created_at,
    updated_at: raffle.updated_at
  };
}

async function loadRafflesWithEntries(supabase) {
  const raffleResult = await supabase.from('storefront_raffles').select('*').order('starts_at', { ascending: false });
  if (raffleResult.error) throw raffleResult.error;
  const rows = raffleResult.data || [];
  const ids = rows.map((row) => row.id).filter(Boolean);
  let entries = [];
  if (ids.length) {
    const entryResult = await supabase
      .from('storefront_raffle_entries')
      .select('id, raffle_id, user_id, user_email, entered_at, is_winner, winner_status')
      .in('raffle_id', ids)
      .order('entered_at', { ascending: true });
    if (entryResult.error) throw entryResult.error;
    entries = entryResult.data || [];
  }
  const byRaffle = new Map();
  entries.forEach((entry) => {
    const current = byRaffle.get(String(entry.raffle_id)) || [];
    current.push(entry);
    byRaffle.set(String(entry.raffle_id), current);
  });
  return rows.map((row) => ({ ...row, entries: byRaffle.get(String(row.id)) || [] }));
}

function normalizeRafflePayload(body = {}, existing = null) {
  const productId = body.linked_storefront_product_id !== undefined
    ? String(body.linked_storefront_product_id || '').trim()
    : String(existing?.linked_storefront_product_id || '').trim();
  const title = body.title !== undefined ? String(body.title || '').trim() : String(existing?.title || '').trim();
  const fulfillmentMode = String(body.fulfillment_mode !== undefined ? body.fulfillment_mode : existing?.fulfillment_mode || 'purchase').trim().toLowerCase();
  const audienceType = String(body.audience_type !== undefined ? body.audience_type : existing?.audience_type || 'all_members').trim().toLowerCase();
  const audienceAdminId = body.audience_admin_id !== undefined
    ? String(body.audience_admin_id || '').trim()
    : String(existing?.audience_admin_id || '').trim();
  let retailPriceCents = body.retail_price !== undefined ? dollarsToCents(body.retail_price) : Number(existing?.retail_price_cents || 0);
  let shippingPriceCents = body.shipping_price !== undefined ? dollarsToCents(body.shipping_price) : Number(existing?.shipping_price_cents || 0);
  const marketLowCents = body.market_value_low !== undefined ? dollarsToCents(body.market_value_low) : Number(existing?.market_value_low_cents || 0);
  const marketHighCents = body.market_value_high !== undefined ? dollarsToCents(body.market_value_high) : Number(existing?.market_value_high_cents || 0);
  const startsAt = new Date(body.starts_at !== undefined ? body.starts_at : existing?.starts_at);
  const endsAt = new Date(body.ends_at !== undefined ? body.ends_at : existing?.ends_at);
  const claimHoursRaw = body.winner_claim_hours !== undefined ? body.winner_claim_hours : existing?.winner_claim_hours;
  const winnerClaimHours = Math.max(1, Math.min(168, Number(claimHoursRaw || 24) || 24));

  if (!productId) throw new Error('Choose the storefront product being reserved for this raffle.');
  if (!title) throw new Error('Raffle title is required.');
  if (!['purchase', 'free'].includes(fulfillmentMode)) throw new Error('Choose retail purchase or free prize.');
  if (!['all_members', 'admin_group'].includes(audienceType)) throw new Error('Choose all members or one admin group.');
  if (audienceType === 'admin_group' && !audienceAdminId) throw new Error('Choose the admin group eligible for this raffle.');
  if (fulfillmentMode === 'free') {
    retailPriceCents = 0;
    shippingPriceCents = 0;
  }
  if (fulfillmentMode === 'purchase' && (!Number.isFinite(retailPriceCents) || retailPriceCents <= 0)) throw new Error('Retail purchase price must be greater than $0.');
  if (!Number.isFinite(shippingPriceCents) || shippingPriceCents < 0) throw new Error('Shipping price must be $0 or more.');
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error('The raffle end time must be after its start time.');
  if (marketLowCents && marketHighCents && marketHighCents < marketLowCents) throw new Error('Market value high must be at least the market value low.');

  return {
    linked_storefront_product_id: productId,
    title,
    description: body.description !== undefined ? String(body.description || '').trim() : String(existing?.description || '').trim(),
    image_url: body.image_url !== undefined ? String(body.image_url || '').trim() : String(existing?.image_url || '').trim(),
    fulfillment_mode: fulfillmentMode,
    audience_type: audienceType,
    audience_admin_id: audienceType === 'admin_group' ? audienceAdminId : null,
    audience_label: body.audience_label !== undefined ? String(body.audience_label || '').trim() : String(existing?.audience_label || '').trim(),
    retail_price_cents: retailPriceCents,
    shipping_price_cents: shippingPriceCents,
    market_value_low_cents: marketLowCents || null,
    market_value_high_cents: marketHighCents || null,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    winner_claim_hours: winnerClaimHours,
    terms: body.terms !== undefined ? String(body.terms || '').trim() : String(existing?.terms || '').trim(),
    hide_linked_product: body.hide_linked_product !== undefined ? body.hide_linked_product !== false : existing?.hide_linked_product !== false
  };
}

function registerStorefrontRaffleRoutes({
  app, supabase, stripe, auth, getCurrentUser, buildAppUrl, sendEmail, superAdminEmail, recordStorefrontSale
}) {
  let drawLoopBusy = false;

  async function requireSuperAdmin(req, res, next) {
    try {
      const user = await getCurrentUser(req);
      const allowed = user?.role === 'super_admin' || String(user?.email || '').toLowerCase() === String(superAdminEmail || '').toLowerCase();
      if (!allowed) return res.status(403).json({ error: 'Super admin only' });
      req.raffleAdminUser = user;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  function raffleError(res, error) {
    if (raffleSchemaMissing(error)) return res.status(503).json({ error: `Raffle tables are not installed yet. Run ${RAFFLE_SETUP_FILE} in Supabase.`, setup_required: true });
    return res.status(500).json({ error: error.message || String(error) });
  }

  async function validateLinkedProduct(productId) {
    const result = await supabase.from('storefront_products').select('*').eq('id', productId).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('The linked storefront product could not be found.');
    if (Number(result.data.stock_on_hand || 0) < 1) throw new Error('The linked product must have at least one unit in stock.');
    return result.data;
  }

  async function ensureProductAvailableForRaffle(productId, ignoreRaffleId = '') {
    const result = await supabase
      .from('storefront_raffles')
      .select('id, linked_storefront_product_id, status, starts_at, ends_at, winner_user_id, winner_entry_id, claim_expires_at, fulfillment_mode')
      .eq('linked_storefront_product_id', productId);
    if (result.error) throw result.error;
    const released = new Set(['paid', 'fulfilled', 'canceled']);
    const activeReservations = (result.data || []).filter((row) => String(row.id) !== String(ignoreRaffleId || '') && !released.has(deriveRaffleStatus(row)));
    const product = await validateLinkedProduct(productId);
    if (activeReservations.length >= Number(product.stock_on_hand || 0)) {
      throw new Error(`This product has ${product.stock_on_hand || 0} unit(s) in stock and ${activeReservations.length} already reserved by active raffles.`);
    }
  }

  async function getAdminGroupOwnerIds(adminId) {
    const cleanId = String(adminId || '').trim();
    if (!cleanId) return [];
    const membership = await supabase.from('admin_organization_members').select('organization_id').eq('user_id', cleanId).maybeSingle();
    if (membership.error && !/does not exist|schema cache/i.test(String(membership.error.message || ''))) throw membership.error;
    if (!membership.data?.organization_id) return [cleanId];
    const members = await supabase.from('admin_organization_members').select('user_id').eq('organization_id', membership.data.organization_id);
    if (members.error) throw members.error;
    return [...new Set([cleanId, ...(members.data || []).map((row) => String(row.user_id || '')).filter(Boolean)])];
  }

  async function getAdminGroupLabel(owner) {
    const fallback = owner?.discord_display_name || owner?.discord_username || owner?.email || 'Admin group';
    const membership = await supabase.from('admin_organization_members').select('admin_organizations(name)').eq('user_id', owner?.id).maybeSingle();
    if (membership.error && !/does not exist|schema cache/i.test(String(membership.error.message || ''))) throw membership.error;
    return membership.data?.admin_organizations?.name || fallback;
  }

  async function loadActiveMembers() {
    const result = await supabase.from('users').select('id,email,role,owner_admin_id,revoked');
    if (result.error) throw result.error;
    return (result.data || []).filter(isActiveMember);
  }

  async function eligibleUsersForRaffle(raffle, activeMembers = null) {
    const members = activeMembers || await loadActiveMembers();
    const groupOwnerIds = raffle.audience_type === 'admin_group' ? await getAdminGroupOwnerIds(raffle.audience_admin_id) : [];
    return members.filter((user) => isUserEligibleForRaffle(user, raffle, groupOwnerIds));
  }

  async function attachEligibilityCounts(rows, activeMembers = null) {
    const members = activeMembers || await loadActiveMembers();
    const result = [];
    for (const row of rows || []) {
      const users = await eligibleUsersForRaffle(row, members);
      result.push({ ...row, eligible_count: users.length, entrant_count: row.entries.length, eligible_users: users });
    }
    return result;
  }

  async function lockManualEntries(raffle) {
    if (raffle.entries_locked_at) {
      if (Array.isArray(raffle.entries) && raffle.entries.length) return raffle.entries;
      const existing = await supabase.from('storefront_raffle_entries').select('*').eq('raffle_id', raffle.id).order('entered_at', { ascending: true });
      if (existing.error) throw existing.error;
      return existing.data || [];
    }
    const existing = await supabase.from('storefront_raffle_entries').select('*').eq('raffle_id', raffle.id).order('entered_at', { ascending: true });
    if (existing.error) throw existing.error;
    const lockedAt = new Date().toISOString();
    const lockUpdate = await supabase.from('storefront_raffles').update({ entries_locked_at: lockedAt, updated_at: lockedAt }).eq('id', raffle.id);
    if (lockUpdate.error) throw lockUpdate.error;
    return existing.data || [];
  }

  async function createOrReuseWinnerCheckout(raffle, user) {
    if (String(raffle.fulfillment_mode || 'purchase') !== 'purchase') return null;
    if (!stripe) throw new Error('Stripe is not configured, so the winner checkout link could not be created.');
    const claimRemainingSeconds = Math.floor((new Date(raffle.claim_expires_at || 0).getTime() - Date.now()) / 1000);
    if (claimRemainingSeconds < 1800) throw new Error('The winner claim window has less than 30 minutes remaining.');
    if (raffle.stripe_checkout_session_id) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(raffle.stripe_checkout_session_id);
        if (existing.payment_status === 'paid') throw new Error('This raffle purchase has already been paid.');
        if (existing.status === 'open' && existing.url) return existing;
      } catch (error) {
        if (/already been paid/i.test(error.message || '')) throw error;
      }
    }

    const product = await validateLinkedProduct(raffle.linked_storefront_product_id);
    const lineItems = [{
      quantity: 1,
      price_data: {
        currency: process.env.STRIPE_CURRENCY || 'usd', unit_amount: Number(raffle.retail_price_cents),
        product_data: { name: raffle.title, description: raffle.description || 'Members-only raffle winner purchase', images: raffle.image_url ? [raffle.image_url] : (product.image_url ? [product.image_url] : []) }
      }
    }];
    if (Number(raffle.shipping_price_cents || 0) > 0) lineItems.push({ quantity: 1, price_data: { currency: process.env.STRIPE_CURRENCY || 'usd', unit_amount: Number(raffle.shipping_price_cents), product_data: { name: 'Shipping' } } });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: buildAppUrl(`/raffle.html?checkout=success&raffle=${encodeURIComponent(raffle.id)}`),
      cancel_url: buildAppUrl(`/raffle.html?checkout=cancel&raffle=${encodeURIComponent(raffle.id)}`),
      customer_creation: 'always', customer_email: user.email || undefined, client_reference_id: user.id,
      billing_address_collection: 'required', shipping_address_collection: { allowed_countries: ['US'] }, phone_number_collection: { enabled: true }, automatic_tax: { enabled: true },
      expires_at: Math.min(Math.floor(new Date(raffle.claim_expires_at).getTime() / 1000), Math.floor(Date.now() / 1000) + (24 * 60 * 60)),
      line_items: lineItems,
      metadata: {
        checkout_type: 'raffle_winner_purchase', raffle_id: String(raffle.id), raffle_entry_id: String(raffle.winner_entry_id || ''), user_id: String(user.id), user_email: String(user.email || ''),
        storefront_product_id: String(product.id), raffle_price_cents: String(raffle.retail_price_cents), raffle_shipping_price_cents: String(raffle.shipping_price_cents || 0), quantity: '1'
      }
    });
    const update = await supabase.from('storefront_raffles').update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() }).eq('id', raffle.id);
    if (update.error) throw update.error;
    return session;
  }

  async function sendWinnerEmail(raffle, winner, checkoutSession = null) {
    const raffleUrl = buildAppUrl(`/raffle.html?raffle=${encodeURIComponent(raffle.id)}`);
    const freePrize = String(raffle.fulfillment_mode || 'purchase') === 'free';
    const checkoutUrl = checkoutSession?.url || raffleUrl;
    const subject = freePrize ? `You won a free Shore Shack raffle — ${raffle.title}` : 'You won the Shore Shack retail raffle — checkout ready';
    const text = freePrize
      ? `You won ${raffle.title} for free in the ${raffle.audience_label || 'member'} raffle. No payment is required. Open your winner page: ${raffleUrl}`
      : `You were selected to purchase ${raffle.title} for $${centsToDollars(raffle.retail_price_cents).toFixed(2)} plus $${centsToDollars(raffle.shipping_price_cents).toFixed(2)} shipping. Checkout before ${new Date(raffle.claim_expires_at).toLocaleString()}: ${checkoutUrl}\n\nYou can also open the raffle page while signed in: ${raffleUrl}`;
    const html = freePrize
      ? `<h2>You won!</h2><p>You were selected for <strong>${String(raffle.title || '').replace(/[<>&]/g, '')}</strong> in the ${String(raffle.audience_label || 'member').replace(/[<>&]/g, '')} raffle.</p><p><strong>No payment is required.</strong></p><p><a href="${raffleUrl}">Open your winner page</a></p>`
      : `<h2>Your winner checkout is ready</h2><p>You were selected to purchase <strong>${String(raffle.title || '').replace(/[<>&]/g, '')}</strong> for <strong>$${centsToDollars(raffle.retail_price_cents).toFixed(2)}</strong> plus <strong>$${centsToDollars(raffle.shipping_price_cents).toFixed(2)}</strong> shipping.</p><p>Complete checkout before ${new Date(raffle.claim_expires_at).toLocaleString()}.</p><p><a href="${checkoutUrl}">Checkout now</a></p><p><a href="${raffleUrl}">Or open the members raffle page</a></p>`;
    await sendEmail({ to: winner.user_email, subject, text, html });
  }

  async function drawClaimedRaffle(raffle) {
    const entries = await lockManualEntries(raffle);
    for (const entry of entries.filter((item) => item.is_winner && String(item.winner_status || '') === 'selected')) {
      const resetEntry = await supabase.from('storefront_raffle_entries').update({ is_winner: false, winner_status: 'entered' }).eq('id', entry.id);
      if (resetEntry.error) throw resetEntry.error;
      entry.is_winner = false;
      entry.winner_status = 'entered';
    }
    const currentlyEligible = await eligibleUsersForRaffle(raffle);
    const eligibleUserIds = new Set(currentlyEligible.map((user) => String(user.id)));
    const winner = chooseRaffleWinner(entries.filter((entry) => eligibleUserIds.has(String(entry.user_id))));
    if (!winner) {
      const now = new Date().toISOString();
      await supabase.from('storefront_raffles').update({ status: 'no_eligible', draw_error: 'No eligible members manually entered before the deadline.', updated_at: now }).eq('id', raffle.id);
      return { drawn: false, raffle_id: raffle.id, error: 'No eligible members manually entered before the deadline.' };
    }

    const winnerUpdate = await supabase.from('storefront_raffle_entries').update({ is_winner: true, winner_status: 'selected' }).eq('id', winner.id);
    if (winnerUpdate.error) throw winnerUpdate.error;
    const drawnAt = new Date();
    const freePrize = String(raffle.fulfillment_mode || 'purchase') === 'free';
    const claimExpiresAt = freePrize ? null : new Date(drawnAt.getTime() + Number(raffle.winner_claim_hours || 24) * 60 * 60 * 1000);
    const raffleUpdate = await supabase.from('storefront_raffles').update({
      status: 'winner_selected', winner_entry_id: winner.id, winner_user_id: winner.user_id, drawn_at: drawnAt.toISOString(), claim_expires_at: claimExpiresAt?.toISOString() || null,
      stripe_checkout_session_id: null, draw_error: null, updated_at: drawnAt.toISOString()
    }).eq('id', raffle.id).select('*').single();
    if (raffleUpdate.error) throw raffleUpdate.error;

    const winnerUser = { id: winner.user_id, email: winner.user_email };
    let checkoutSession = null;
    let checkoutError = '';
    if (!freePrize) {
      try { checkoutSession = await createOrReuseWinnerCheckout({ ...raffleUpdate.data, winner_entry_id: winner.id }, winnerUser); }
      catch (error) { checkoutError = error.message || String(error); }
    }
    let email = { success: false, error: '' };
    try { await sendWinnerEmail(raffleUpdate.data, winner, checkoutSession); email.success = true; }
    catch (error) { email.error = error.message || String(error); }
    if (checkoutError || email.error) {
      const warning = [checkoutError && `Checkout: ${checkoutError}`, email.error && `Email: ${email.error}`].filter(Boolean).join(' | ');
      await supabase.from('storefront_raffles').update({ draw_error: warning, updated_at: new Date().toISOString() }).eq('id', raffle.id);
    }
    return { drawn: true, raffle_id: raffle.id, winner, checkout: checkoutSession ? { id: checkoutSession.id, url: checkoutSession.url } : null, checkout_error: checkoutError, email };
  }

  async function claimAndDrawRaffle(raffleId, { force = false } = {}) {
    const current = await supabase.from('storefront_raffles').select('*').eq('id', raffleId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) throw new Error('Raffle not found.');
    const status = deriveRaffleStatus(current.data);
    if (!force && status !== 'closed') return { skipped: status };
    if (['paid', 'fulfilled', 'canceled', 'winner_selected', 'drawing'].includes(status)) return { skipped: status };
    const now = new Date().toISOString();
    const claim = await supabase.from('storefront_raffles').update({ status: 'drawing', draw_started_at: now, draw_error: null, updated_at: now })
      .eq('id', raffleId).is('winner_user_id', null).in('status', ['scheduled', 'live', 'closed', 'draw_error']).select('*').maybeSingle();
    if (claim.error) throw claim.error;
    if (!claim.data) return { skipped: 'already_claimed' };
    try { return await drawClaimedRaffle({ ...claim.data, entries: [] }); }
    catch (error) {
      await supabase.from('storefront_raffles').update({ status: 'draw_error', draw_error: error.message || String(error), updated_at: new Date().toISOString() }).eq('id', raffleId);
      throw error;
    }
  }

  async function processDueRaffles() {
    if (drawLoopBusy) return [];
    drawLoopBusy = true;
    try {
      const staleCutoff = new Date(Date.now() - (2 * 60 * 1000)).toISOString();
      const staleReset = await supabase.from('storefront_raffles').update({ status: 'closed', draw_error: 'Recovered an interrupted automatic draw.', updated_at: new Date().toISOString() })
        .eq('status', 'drawing').lt('draw_started_at', staleCutoff).is('winner_user_id', null);
      if (staleReset.error && !raffleSchemaMissing(staleReset.error)) throw staleReset.error;
      const due = await supabase.from('storefront_raffles').select('*').lte('ends_at', new Date().toISOString()).in('status', ['scheduled', 'live', 'closed']);
      if (due.error) {
        if (raffleSchemaMissing(due.error)) return [];
        throw due.error;
      }
      const results = [];
      for (const raffle of due.data || []) {
        try { results.push(await claimAndDrawRaffle(raffle.id)); }
        catch (error) { console.error(`Automatic raffle draw failed for ${raffle.id}:`, error); }
      }
      return results;
    } finally { drawLoopBusy = false; }
  }

  app.get('/raffles', auth, async (req, res) => {
    try {
      await processDueRaffles();
      const user = await getCurrentUser(req);
      const rows = await attachEligibilityCounts(await loadRafflesWithEntries(supabase));
      const recentCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const visible = rows.filter((row) => {
        const viewerEligible = (row.eligible_users || []).some((candidate) => String(candidate.id) === String(user.id));
        const viewerEntered = (row.entries || []).some((entry) => String(entry.user_id) === String(user.id));
        const viewerIsWinner = String(row.winner_user_id || '') === String(user.id);
        if (!viewerEligible && !viewerEntered && !viewerIsWinner && user.role !== 'super_admin') return false;
        const status = deriveRaffleStatus(row);
        if (['scheduled', 'live', 'closed', 'drawing', 'draw_error', 'no_eligible'].includes(status)) return true;
        if (viewerIsWinner) return true;
        return new Date(row.ends_at || 0).getTime() >= recentCutoff && status !== 'canceled';
      });
      res.json({ raffles: visible.map((row) => publicRaffleView(row, user.id, (row.eligible_users || []).some((candidate) => String(candidate.id) === String(user.id)))) });
    } catch (error) { raffleError(res, error); }
  });

  app.post('/raffles/:id/enter', auth, async (req, res) => {
    try {
      const signedInUser = await getCurrentUser(req);
      const userResult = await supabase.from('users').select('id,email,role,owner_admin_id,revoked').eq('id', signedInUser.id).maybeSingle();
      if (userResult.error) throw userResult.error;
      const user = userResult.data;
      if (!isActiveMember(user)) return res.status(403).json({ error: 'Only active website accounts can enter raffles.' });

      const raffleResult = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (raffleResult.error) throw raffleResult.error;
      const raffle = raffleResult.data;
      if (!raffle) return res.status(404).json({ error: 'Raffle not found.' });
      const status = deriveRaffleStatus(raffle);
      if (status === 'scheduled') return res.status(409).json({ error: 'Entry has not opened yet.' });
      if (status !== 'live') return res.status(409).json({ error: 'Entry for this raffle is closed.' });

      const groupOwnerIds = raffle.audience_type === 'admin_group' ? await getAdminGroupOwnerIds(raffle.audience_admin_id) : [];
      if (!isUserEligibleForRaffle(user, raffle, groupOwnerIds)) return res.status(403).json({ error: 'This raffle is not assigned to your member group.' });

      const existing = await supabase.from('storefront_raffle_entries').select('*').eq('raffle_id', raffle.id).eq('user_id', user.id).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return res.json({ entered: true, duplicate: true, entry: existing.data });

      const entryResult = await supabase.from('storefront_raffle_entries').insert({
        raffle_id: raffle.id,
        user_id: user.id,
        user_email: String(user.email || '').trim().toLowerCase(),
        winner_status: 'entered'
      }).select('*').single();
      if (entryResult.error) {
        if (String(entryResult.error.code || '') === '23505') return res.json({ entered: true, duplicate: true });
        throw entryResult.error;
      }
      res.status(201).json({ entered: true, entry: entryResult.data });
    } catch (error) {
      if (/entry (has not opened|is closed)|only active website|not assigned to your member group/i.test(error.message || '')) return res.status(409).json({ error: error.message });
      raffleError(res, error);
    }
  });

  app.post('/raffles/:id/checkout-session', auth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      const raffleResult = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (raffleResult.error) throw raffleResult.error;
      const raffle = raffleResult.data;
      if (!raffle) return res.status(404).json({ error: 'Raffle not found.' });
      if (String(raffle.fulfillment_mode || 'purchase') !== 'purchase') return res.status(409).json({ error: 'This is a free prize and does not require checkout.' });
      if (String(raffle.winner_user_id || '') !== String(user.id)) return res.status(403).json({ error: 'Only the selected winner can purchase this item.' });
      if (deriveRaffleStatus(raffle) !== 'winner_selected') return res.status(409).json({ error: 'This winner purchase window is no longer active.' });
      const session = await createOrReuseWinnerCheckout(raffle, user);
      res.json({ url: session.url, id: session.id });
    } catch (error) { raffleError(res, error); }
  });

  app.get('/admin/store/raffle-groups', auth, requireSuperAdmin, async (_req, res) => {
    try {
      const usersResult = await supabase.from('users').select('id,email,role,revoked,discord_username,discord_display_name').in('role', ['admin', 'super_admin']).order('email');
      if (usersResult.error) throw usersResult.error;
      const members = await loadActiveMembers();
      const groups = [];
      const seenGroups = new Set();
      for (const owner of (usersResult.data || []).filter((user) => !user.revoked)) {
        const ownerIds = await getAdminGroupOwnerIds(owner.id);
        const groupKey = ownerIds.map(String).sort().join('|');
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        const count = members.filter((user) => ownerIds.map(String).includes(String(user.owner_admin_id || ''))).length;
        groups.push({ id: owner.id, label: await getAdminGroupLabel(owner), email: owner.email, eligible_count: count, owner_ids: ownerIds });
      }
      res.json({ groups, active_member_count: members.length });
    } catch (error) { raffleError(res, error); }
  });

  app.get('/admin/store/raffles', auth, requireSuperAdmin, async (_req, res) => {
    try {
      await processDueRaffles();
      const rows = await attachEligibilityCounts(await loadRafflesWithEntries(supabase));
      res.json({ raffles: rows.map(adminRaffleView) });
    } catch (error) { raffleError(res, error); }
  });

  app.post('/admin/store/raffles', auth, requireSuperAdmin, async (req, res) => {
    try {
      const payload = normalizeRafflePayload(req.body || {});
      const product = await validateLinkedProduct(payload.linked_storefront_product_id);
      await ensureProductAvailableForRaffle(payload.linked_storefront_product_id);
      if (!payload.image_url) payload.image_url = product.image_url || '';
      if (!payload.description) payload.description = product.description || '';
      if (payload.audience_type === 'all_members') payload.audience_label = 'All active members';
      if (payload.audience_type === 'admin_group' && !payload.audience_label) {
        const owner = await supabase.from('users').select('email,discord_username,discord_display_name').eq('id', payload.audience_admin_id).maybeSingle();
        if (owner.error) throw owner.error;
        payload.audience_label = owner.data?.discord_display_name || owner.data?.discord_username || owner.data?.email || 'Selected admin group';
      }
      payload.status = deriveRaffleStatus(payload);
      payload.created_by_user_id = req.raffleAdminUser.id;
      payload.updated_at = new Date().toISOString();
      const result = await supabase.from('storefront_raffles').insert(payload).select('*').single();
      if (result.error) throw result.error;
      const eligible = await eligibleUsersForRaffle(result.data);
      res.status(201).json({ raffle: adminRaffleView({ ...result.data, entries: [], eligible_count: eligible.length }) });
    } catch (error) {
      if (/required|price|shipping|start|market|stock|linked storefront|reserved|choose/i.test(error.message || '')) return res.status(400).json({ error: error.message });
      raffleError(res, error);
    }
  });

  app.patch('/admin/store/raffles/:id', auth, requireSuperAdmin, async (req, res) => {
    try {
      const existingResult = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (existingResult.error) throw existingResult.error;
      const existing = existingResult.data;
      if (!existing) return res.status(404).json({ error: 'Raffle not found.' });
      if (existing.winner_user_id || ['paid', 'fulfilled'].includes(existing.status)) return res.status(409).json({ error: 'A raffle cannot be edited after a winner has been selected.' });
      const payload = normalizeRafflePayload(req.body || {}, existing);
      const product = await validateLinkedProduct(payload.linked_storefront_product_id);
      await ensureProductAvailableForRaffle(payload.linked_storefront_product_id, existing.id);
      if (!payload.image_url) payload.image_url = product.image_url || '';
      if (payload.audience_type === 'all_members') payload.audience_label = 'All active members';
      payload.status = deriveRaffleStatus(payload);
      const entryResult = await supabase.from('storefront_raffle_entries').select('id', { count: 'exact', head: true }).eq('raffle_id', existing.id);
      if (entryResult.error) throw entryResult.error;
      if (Number(entryResult.count || 0) > 0) return res.status(409).json({ error: 'This raffle already has member entries. Cancel it and create a new raffle instead of changing its rules.' });
      payload.entries_locked_at = null;
      payload.updated_at = new Date().toISOString();
      const result = await supabase.from('storefront_raffles').update(payload).eq('id', existing.id).select('*').single();
      if (result.error) throw result.error;
      const eligible = await eligibleUsersForRaffle(result.data);
      res.json({ raffle: adminRaffleView({ ...result.data, entries: [], eligible_count: eligible.length }) });
    } catch (error) {
      if (/required|price|shipping|start|market|stock|linked storefront|reserved|choose/i.test(error.message || '')) return res.status(400).json({ error: error.message });
      raffleError(res, error);
    }
  });

  app.post('/admin/store/raffles/:id/cancel', auth, requireSuperAdmin, async (req, res) => {
    try {
      const existing = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) return res.status(404).json({ error: 'Raffle not found.' });
      if (['paid', 'fulfilled'].includes(deriveRaffleStatus(existing.data))) return res.status(409).json({ error: 'A completed raffle cannot be canceled here.' });
      const result = await supabase.from('storefront_raffles').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
      if (result.error) throw result.error;
      res.json({ canceled: true, raffle: adminRaffleView({ ...result.data, entries: [] }) });
    } catch (error) { raffleError(res, error); }
  });

  app.post('/admin/store/raffles/:id/draw', auth, requireSuperAdmin, async (req, res) => {
    try {
      const current = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (current.error) throw current.error;
      if (!current.data) return res.status(404).json({ error: 'Raffle not found.' });
      const status = deriveRaffleStatus(current.data);
      if (!['closed', 'draw_error', 'claim_expired'].includes(status)) return res.status(409).json({ error: 'This raffle is not ready for a fallback draw.' });
      if (status === 'claim_expired' && current.data.winner_entry_id) {
        const previous = await supabase.from('storefront_raffle_entries').update({ is_winner: false, winner_status: 'expired' }).eq('id', current.data.winner_entry_id);
        if (previous.error) throw previous.error;
        const reset = await supabase.from('storefront_raffles').update({ status: 'closed', winner_entry_id: null, winner_user_id: null, claim_expires_at: null, stripe_checkout_session_id: null, updated_at: new Date().toISOString() }).eq('id', current.data.id);
        if (reset.error) throw reset.error;
      }
      const result = await claimAndDrawRaffle(current.data.id, { force: true });
      res.json(result);
    } catch (error) { raffleError(res, error); }
  });

  app.post('/admin/store/raffles/:id/fulfill-free', auth, requireSuperAdmin, async (req, res) => {
    try {
      const raffleResult = await supabase.from('storefront_raffles').select('*').eq('id', req.params.id).maybeSingle();
      if (raffleResult.error) throw raffleResult.error;
      const raffle = raffleResult.data;
      if (!raffle) return res.status(404).json({ error: 'Raffle not found.' });
      if (String(raffle.fulfillment_mode || '') !== 'free' || !raffle.winner_user_id) return res.status(409).json({ error: 'This raffle does not have a free-prize winner.' });
      if (raffle.status === 'fulfilled') return res.json({ fulfilled: true, duplicate: true });
      const winner = await supabase.from('users').select('id,email').eq('id', raffle.winner_user_id).maybeSingle();
      if (winner.error) throw winner.error;
      const fakeSession = {
        id: `raffle-free-${raffle.id}`, amount_subtotal: 0, amount_total: 0, total_details: { amount_shipping: 0, amount_tax: 0 }, customer_email: winner.data?.email || null,
        customer_details: { email: winner.data?.email || null, name: null, address: {} },
        metadata: {
          checkout_type: 'raffle_winner_purchase', raffle_id: String(raffle.id), raffle_entry_id: String(raffle.winner_entry_id || ''), user_id: String(raffle.winner_user_id),
          user_email: String(winner.data?.email || ''), storefront_product_id: String(raffle.linked_storefront_product_id), raffle_price_cents: '0', raffle_shipping_price_cents: '0', quantity: '1', complimentary_prize: 'true'
        }
      };
      const sale = await recordStorefrontSale(fakeSession);
      const now = new Date().toISOString();
      const update = await supabase.from('storefront_raffles').update({ status: 'fulfilled', fulfilled_at: now, updated_at: now }).eq('id', raffle.id);
      if (update.error) throw update.error;
      if (raffle.winner_entry_id) await supabase.from('storefront_raffle_entries').update({ winner_status: 'fulfilled', is_winner: true }).eq('id', raffle.winner_entry_id);
      res.json({ fulfilled: true, sale });
    } catch (error) { raffleError(res, error); }
  });

  async function listReservedProductIds() {
    try {
      const result = await supabase.from('storefront_raffles').select('linked_storefront_product_id,status,starts_at,ends_at,winner_user_id,winner_entry_id,claim_expires_at,hide_linked_product,fulfillment_mode');
      if (result.error) throw result.error;
      return (result.data || []).filter((row) => row.hide_linked_product !== false && !['paid', 'fulfilled', 'canceled'].includes(deriveRaffleStatus(row))).map((row) => String(row.linked_storefront_product_id || '')).filter(Boolean);
    } catch (error) {
      if (raffleSchemaMissing(error)) return [];
      throw error;
    }
  }

  async function recordRaffleWinnerSaleFromStripeSession(session) {
    const metadata = session?.metadata || {};
    if (String(metadata.checkout_type || '') !== 'raffle_winner_purchase') return { skipped: 'not_raffle_winner_purchase' };
    const raffleId = String(metadata.raffle_id || '').trim();
    if (!raffleId) return { skipped: 'missing_raffle_id' };
    const raffleResult = await supabase.from('storefront_raffles').select('*').eq('id', raffleId).maybeSingle();
    if (raffleResult.error) throw raffleResult.error;
    const raffle = raffleResult.data;
    if (!raffle) throw new Error('Raffle record not found for winner payment.');
    if (String(raffle.winner_user_id || '') !== String(metadata.user_id || '')) throw new Error('Raffle winner identity did not match the payment.');
    const saleResult = await recordStorefrontSale(session);
    const now = new Date().toISOString();
    const raffleUpdate = await supabase.from('storefront_raffles').update({ status: 'paid', paid_at: now, stripe_checkout_session_id: session.id, updated_at: now }).eq('id', raffle.id);
    if (raffleUpdate.error) throw raffleUpdate.error;
    if (raffle.winner_entry_id) {
      const entryUpdate = await supabase.from('storefront_raffle_entries').update({ winner_status: 'paid', is_winner: true }).eq('id', raffle.winner_entry_id);
      if (entryUpdate.error) throw entryUpdate.error;
    }
    return { recorded: true, raffle_id: raffle.id, sale: saleResult };
  }

  const timer = setInterval(() => processDueRaffles().catch((error) => console.error('Automatic raffle draw loop failed:', error)), AUTOMATIC_DRAW_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const initialTimer = setTimeout(() => processDueRaffles().catch((error) => console.error('Initial automatic raffle draw failed:', error)), 1500);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  return { listReservedProductIds, recordRaffleWinnerSaleFromStripeSession, processDueRaffles };
}

module.exports = {
  RAFFLE_SETUP_FILE, deriveRaffleStatus, chooseRaffleWinner, isActiveMember, isUserEligibleForRaffle,
  publicRaffleView, normalizeRafflePayload, registerStorefrontRaffleRoutes
};
