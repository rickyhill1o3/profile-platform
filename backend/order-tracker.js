const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const SCAN_INTERVAL_MS = Math.max(5 * 60 * 1000, Number(process.env.IMAP_SCAN_INTERVAL_MS || 15 * 60 * 1000));
const INITIAL_LOOKBACK_DAYS = Math.max(7, Number(process.env.IMAP_INITIAL_LOOKBACK_DAYS || 90));
const MAX_MESSAGES_PER_SCAN = Math.max(25, Number(process.env.IMAP_MAX_MESSAGES_PER_SCAN || 250));
const MAX_ACCOUNTS_PER_CYCLE = Math.max(1, Number(process.env.IMAP_MAX_ACCOUNTS_PER_CYCLE || 25));
let backgroundAccountCursor = 0;

function clean(v) { return String(v || '').trim(); }
function lower(v) { return clean(v).toLowerCase(); }
function normalizeMailboxPassword(v, providerName = '') {
  const value = clean(v);
  // Google displays 16-character app passwords in four groups. IMAP expects the same password without spaces.
  if (providerName === 'gmail') return value.replace(/\s+/g, '');
  return value;
}
function money(v) {
  const n = Number(String(v || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function htmlEscape(v) {
  return String(v || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sanitizeReceiptHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|form)>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function providerForEmail(email) {
  const domain = lower(email).split('@')[1] || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return { name: 'gmail', host: 'imap.gmail.com', port: 993, secure: true };
  if (['outlook.com','hotmail.com','live.com','msn.com'].includes(domain)) return { name: 'outlook', host: 'outlook.office365.com', port: 993, secure: true };
  if (['yahoo.com','ymail.com','rocketmail.com'].includes(domain)) return { name: 'yahoo', host: 'imap.mail.yahoo.com', port: 993, secure: true };
  if (['icloud.com','me.com','mac.com'].includes(domain)) return { name: 'icloud', host: 'imap.mail.me.com', port: 993, secure: true };
  return null;
}

function detectStore(from, subject, text) {
  const hay = `${from} ${subject} ${text.slice(0, 3000)}`.toLowerCase();
  if (/target\.com|target order|thanks for shopping at target/.test(hay)) return 'target';
  if (/walmart\.com|walmart order/.test(hay)) return 'walmart';
  if (/samsclub\.com|sam'?s club order/.test(hay)) return 'samsclub';
  if (/amazon\.com|amazon order|amazon\.com/.test(hay)) return 'amazon';
  if (/pokemoncenter\.com|pok[eé]mon center/.test(hay)) return 'pokemoncenter';
  if (/crunchyroll/.test(hay)) return 'crunchyroll';
  return '';
}

function detectStatus(subject, text) {
  const hay = `${subject} ${text.slice(0, 7000)}`.toLowerCase();
  if (/delivered|was delivered|delivery complete/.test(hay)) return 'delivered';
  if (/cancel(?:led|ed|ation)|unable to fulfill|we had to cancel/.test(hay)) return 'canceled';
  if (/refund(?:ed)?|refund issued/.test(hay)) return 'refunded';
  if (/shipped|has shipped|on the way|tracking number/.test(hay)) return 'shipped';
  if (/processing|preparing your order|getting your order ready/.test(hay)) return 'processing';
  if (/confirmed|order received|thanks for your order|we've got your order|order placed/.test(hay)) return 'confirmed';
  return 'unknown';
}

function extractOrderNumber(store, subject, text) {
  const hay = `${subject}\n${text}`;
  const patterns = {
    amazon: [/\b(?:order(?: number| #)?\s*[:#]?\s*)(\d{3}-\d{7}-\d{7})\b/i, /\b(\d{3}-\d{7}-\d{7})\b/],
    target: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{8,30})\b/i, /\b(\d{10,20})\b/],
    walmart: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{8,30})\b/i, /\b(\d{7,8}-\d{6,8})\b/],
    samsclub: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{8,30})\b/i],
    pokemoncenter: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{6,30})\b/i],
    crunchyroll: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{6,30})\b/i]
  };
  for (const re of patterns[store] || patterns.target) {
    const m = hay.match(re);
    if (m?.[1]) return m[1].replace(/[.,]$/, '');
  }
  return '';
}

function extractAmounts(text) {
  const find = (labels) => {
    for (const label of labels) {
      const re = new RegExp(`${label}\\s*[:]?\\s*\\$?([0-9,]+(?:\\.[0-9]{2})?)`, 'i');
      const m = text.match(re); if (m) return money(m[1]);
    }
    return null;
  };
  return {
    subtotal: find(['subtotal','items subtotal']),
    tax: find(['estimated tax','sales tax','tax']),
    shipping: find(['shipping(?: & handling)?','delivery fee']),
    total: find(['order total','grand total','total charged','total'])
  };
}

function extractTracking(text) {
  const m = text.match(/(?:tracking(?: number| #)?|track package)\s*[:#]?\s*([A-Z0-9]{8,30})/i);
  return m?.[1] || null;
}

function extractProductSummary(subject, text, store) {
  const lines = text.split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const ignore = /^(order|subtotal|tax|shipping|total|payment|delivery|track|hello|hi |thank|view order|manage order|quantity|qty|price)/i;
  const candidates = lines.filter(x => x.length >= 8 && x.length <= 180 && !ignore.test(x) && !/https?:\/\//i.test(x));
  return candidates.slice(0, 5).join(' • ') || `${store} order ${subject}`.slice(0, 500);
}

function statusRank(s) {
  return ({unknown:0,confirmed:1,processing:2,shipped:3,delivered:4,canceled:5,refunded:6})[s] || 0;
}

function normalizeOrderRef(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function collectOrderRefs(order = {}) {
  const refs = new Set();
  const add = (value) => {
    const raw = clean(value);
    const normalized = normalizeOrderRef(raw);
    if (raw && normalized.length >= 6) refs.add(normalized);
  };
  add(order.external_order_id);
  const walk = (value, key = '', depth = 0) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) return value.forEach(v => walk(v, key, depth + 1));
    if (typeof value === 'object') return Object.entries(value).forEach(([k,v]) => walk(v, k, depth + 1));
    if (/(order|purchase|confirmation).*(id|number|no|#)|^(order_id|order_number|purchase_id)$/i.test(key)) add(value);
  };
  walk(order.metadata || {});
  walk(order.raw_payload || {});
  return [...refs];
}

function serviceOrderNumber(order = {}) {
  const preferred = [
    order.metadata?.order_number, order.metadata?.order_id, order.metadata?.purchase_id,
    order.raw_payload?.order_number, order.raw_payload?.order_id, order.raw_payload?.purchase_id,
    order.raw_payload?.purchaseId, order.external_order_id
  ].map(clean).find(v => normalizeOrderRef(v).length >= 6);
  return preferred || clean(order.external_order_id || order.id);
}

async function loadServiceOrders(supabase, userId) {
  const { data, error } = await supabase.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(2000);
  if (error) throw error;
  return data || [];
}

async function ensureInvestmentRow(supabase, tracked, serviceOrder, active = true) {
  const { data: existing } = await supabase.from('investment_products').select('id').eq('user_id', tracked.user_id).eq('source_order_id', serviceOrder.id).maybeSingle();
  const payload = {
    user_id: tracked.user_id, order_id: tracked.id, source_order_id: serviceOrder.id,
    store: tracked.store, order_number: tracked.order_number,
    product_name: clean(serviceOrder.product_name || tracked.product_summary || 'Tracked product').slice(0, 500),
    sku: clean(serviceOrder.sku), quantity: Number(serviceOrder.metadata?.quantity || serviceOrder.raw_payload?.quantity || 1) || 1,
    purchase_price: Number(serviceOrder.metadata?.purchase_price || serviceOrder.raw_payload?.price || 0) || 0,
    credits_value: Number(serviceOrder.credits_charged || 0) || 0,
    is_active: active, canceled_at: active ? null : new Date().toISOString(), updated_at: new Date().toISOString()
  };
  if (existing?.id) await supabase.from('investment_products').update(payload).eq('id', existing.id);
  else await supabase.from('investment_products').insert(payload);
}

async function syncServiceOrders(supabase, userId, accounts = []) {
  const serviceOrders = await loadServiceOrders(supabase, userId);
  const defaultEmail = accounts[0]?.email || 'waiting-for-imap@local';
  for (const source of serviceOrders) {
    const store = lower(source.site || source.metadata?.site || source.raw_payload?.site || 'unknown').replace(/[^a-z0-9]/g, '');
    const orderNumber = serviceOrderNumber(source);
    if (!orderNumber) continue;
    const { data: prior } = await supabase.from('tracked_orders').select('*').eq('source_order_id', source.id).maybeSingle();
    const payload = {
      user_id: userId, source_order_id: source.id, service_order_external_id: source.external_order_id || null,
      profile_id: prior?.profile_id || accounts[0]?.profile_id || null, source_email: prior?.source_email || defaultEmail,
      store, order_number: prior?.order_number || orderNumber, status: prior?.status || 'confirmed',
      order_date: prior?.order_date || source.created_at || new Date().toISOString(),
      last_status_at: prior?.last_status_at || source.created_at || new Date().toISOString(),
      credits_spent: Number(source.credits_charged || 0), product_summary: clean(source.product_name || source.sku || 'Checkout').slice(0,500),
      updated_at: new Date().toISOString()
    };
    let tracked;
    if (prior?.id) { const r=await supabase.from('tracked_orders').update(payload).eq('id', prior.id).select().single(); tracked=r.data; }
    else {
      const r=await supabase.from('tracked_orders').insert(payload).select().single();
      if (r.error && !/duplicate|unique/i.test(r.error.message||'')) throw r.error;
      tracked=r.data;
      if (!tracked) {
        const fallback=await supabase.from('tracked_orders').select('*').eq('user_id', userId).eq('store', store).eq('order_number', orderNumber).maybeSingle();
        tracked=fallback.data;
        if (tracked?.id && !tracked.source_order_id) {
          const linked=await supabase.from('tracked_orders').update({ source_order_id: source.id, service_order_external_id: source.external_order_id || null }).eq('id', tracked.id).select().single();
          tracked=linked.data || tracked;
        }
      }
    }
    if (tracked) await ensureInvestmentRow(supabase, tracked, source, !['canceled','refunded'].includes(tracked.status));
  }
  return serviceOrders;
}

async function loadScanAccounts(supabase, onlyUserId = null) {
  let profileQuery = supabase.from('profiles').select('id,user_id,profile_name');
  if (onlyUserId) profileQuery = profileQuery.eq('user_id', onlyUserId);
  const { data: profiles, error: pe } = await profileQuery;
  if (pe) throw pe;

  // Verified mailbox rows are also treated as a durable link between Order Tracker and a profile.
  // This prevents a successfully tested mailbox from disappearing from the tracker when one of the
  // optional credential tables is unavailable or a legacy profile row is shaped differently.
  let verifiedStates = [];
  try {
    let stateQuery = supabase.from('imap_scan_accounts').select('*');
    if (onlyUserId) stateQuery = stateQuery.eq('user_id', onlyUserId);
    const stateResult = await stateQuery;
    if (!stateResult.error) verifiedStates = stateResult.data || [];
  } catch (_) {}

  const ids = [...new Set([
    ...(profiles || []).map(p => p.id),
    ...verifiedStates.map(row => row.profile_id).filter(Boolean)
  ])];
  if (!ids.length) return [];

  const pmap = new Map((profiles || []).map(p => [String(p.id), p]));
  for (const state of verifiedStates) {
    if (state.profile_id && !pmap.has(String(state.profile_id))) {
      pmap.set(String(state.profile_id), { id: state.profile_id, user_id: state.user_id });
    }
  }
  const byKey = new Map();
  const addCredential = (c = {}) => {
    const p = pmap.get(String(c.profile_id));
    const email = lower(c.login_email);
    const provider = providerForEmail(email);
    const pass = normalizeMailboxPassword(c.gmail_app_password, provider?.name);
    if (!p || !email || !pass || !provider) return;
    const key = `${p.user_id}:${email}`;
    if (!byKey.has(key)) byKey.set(key, { user_id: p.user_id, profile_id: p.id, email, password: pass, provider });
  };

  // Current multi-store credential table. Older deployments may not have this migration installed yet.
  try {
    const { data: creds, error: ce } = await supabase.from('profile_store_credentials').select('*').in('profile_id', ids);
    if (ce) throw ce;
    for (const c of creds || []) addCredential(c);
  } catch (err) {
    console.warn('IMAP credential table unavailable; checking legacy accounts table:', err.message);
  }

  // Legacy/fallback account row used by the profile editor. This also covers profiles saved before
  // profile_store_credentials was installed or when that migration silently failed.
  try {
    const { data: accounts, error: ae } = await supabase.from('accounts').select('profile_id,login_email,gmail_app_password').in('profile_id', ids);
    if (ae) throw ae;
    for (const account of accounts || []) addCredential(account);
  } catch (err) {
    console.warn('Legacy IMAP accounts lookup failed:', err.message);
  }

  // Final fallback: rebuild verified mailbox credentials directly from their linked profile.
  // This is intentionally done after the normal table scans so current credentials remain canonical.
  for (const state of verifiedStates) {
    const email = lower(state.email);
    if (!email || !state.profile_id || (onlyUserId && String(state.user_id) !== String(onlyUserId))) continue;
    const key = `${state.user_id}:${email}`;
    if (byKey.has(key)) continue;
    const provider = providerForEmail(email);
    if (!provider) continue;

    let credential = null;
    try {
      const r = await supabase.from('profile_store_credentials')
        .select('profile_id,login_email,gmail_app_password')
        .eq('profile_id', state.profile_id)
        .not('gmail_app_password', 'is', null)
        .limit(1);
      credential = r.data?.[0] || null;
    } catch (_) {}
    if (!credential) {
      try {
        const r = await supabase.from('accounts')
          .select('profile_id,login_email,gmail_app_password')
          .eq('profile_id', state.profile_id)
          .limit(1);
        credential = r.data?.[0] || null;
      } catch (_) {}
    }
    const password = normalizeMailboxPassword(credential?.gmail_app_password, provider.name);
    if (password) {
      byKey.set(key, {
        user_id: state.user_id,
        profile_id: state.profile_id,
        email,
        password,
        provider
      });
    }
  }

  return [...byKey.values()];
}

async function upsertScanState(supabase, account, patch) {
  await supabase.from('imap_scan_accounts').upsert({
    user_id: account.user_id, profile_id: account.profile_id, email: account.email,
    provider: account.provider.name, updated_at: new Date().toISOString(), ...patch
  }, { onConflict: 'user_id,email' });
}

async function saveParsedMessage(supabase, account, parsed, uid, adjustCredits = null) {
  const subject = clean(parsed.subject);
  const from = parsed.from?.text || '';
  const text = clean(parsed.text || parsed.html || '').replace(/\u0000/g, '');
  const store = detectStore(from, subject, text);
  if (!store) return { ignored: true };
  const status = detectStatus(subject, text);
  if (status === 'unknown') return { ignored: true };
  const orderNumber = extractOrderNumber(store, subject, text);
  if (!orderNumber) return { ignored: true };
  const messageId = clean(parsed.messageId) || `${account.email}:${uid}`;
  const eventAt = (parsed.date || new Date()).toISOString();
  const amounts = extractAmounts(text);
  const productSummary = extractProductSummary(subject, text, store);
  const receiptHtml = parsed.html ? sanitizeReceiptHtml(String(parsed.html).slice(0, 250000)) : `<pre>${htmlEscape(text.slice(0, 250000))}</pre>`;

  const serviceOrders = await loadServiceOrders(supabase, account.user_id);
  const incomingRef = normalizeOrderRef(orderNumber);
  const serviceOrder = serviceOrders.find(o => collectOrderRefs(o).includes(incomingRef));
  // Only track retailer emails that correspond to a checkout recorded by this platform.
  if (!serviceOrder) return { ignored: true, reason: 'not_a_platform_order' };

  let { data: existing } = await supabase.from('tracked_orders').select('*').eq('source_order_id', serviceOrder.id).maybeSingle();
  if (!existing) {
    await syncServiceOrders(supabase, account.user_id, [account]);
    const lookup = await supabase.from('tracked_orders').select('*').eq('source_order_id', serviceOrder.id).maybeSingle();
    existing = lookup.data;
  }
  if (!existing) return { ignored: true, reason: 'service_order_sync_failed' };
  const shouldAdvance = statusRank(status) >= statusRank(existing.status) || ['canceled','refunded'].includes(status);
  const patch = {
    user_id: account.user_id, source_order_id: serviceOrder.id, service_order_external_id: serviceOrder.external_order_id || null, profile_id: existing?.profile_id || account.profile_id,
    source_email: account.email, store, order_number: orderNumber,
    status: shouldAdvance ? status : existing.status,
    order_date: existing?.order_date || eventAt,
    last_status_at: shouldAdvance ? eventAt : existing.last_status_at,
    subtotal: amounts.subtotal ?? existing?.subtotal ?? null,
    tax: amounts.tax ?? existing?.tax ?? null,
    shipping: amounts.shipping ?? existing?.shipping ?? null,
    total: amounts.total ?? existing?.total ?? null,
    tracking_number: extractTracking(text) || existing?.tracking_number || null,
    product_summary: productSummary || existing?.product_summary || null,
    receipt_html: status === 'confirmed' || !existing?.receipt_html ? receiptHtml : existing.receipt_html,
    receipt_text: status === 'confirmed' || !existing?.receipt_text ? text.slice(0, 250000) : existing.receipt_text,
    raw_subject: subject,
    last_message_id: messageId,
    updated_at: new Date().toISOString()
  };
  const { data: order, error } = await supabase.from('tracked_orders').update(patch).eq('id', existing.id).select().single();
  if (error) throw error;
  await supabase.from('tracked_order_events').upsert({
    order_id: order.id, user_id: account.user_id, status, event_at: eventAt, subject,
    message_id: messageId, source_email: account.email, body_excerpt: text.slice(0, 1000)
  }, { onConflict: 'user_id,message_id', ignoreDuplicates: true });

  const inactive = ['canceled','refunded'].includes(status);
  await ensureInvestmentRow(supabase, order, serviceOrder, !inactive);
  if (inactive && !existing.credits_refunded && Number(serviceOrder.credits_charged || 0) > 0 && typeof adjustCredits === 'function') {
    const refund = Number(serviceOrder.credits_charged || 0);
    await adjustCredits({ userId: account.user_id, delta: refund, reason: 'imap_order_canceled_refund', note: `Credits refunded after ${store} order ${orderNumber} was ${status}`, metadata: { tracked_order_id: order.id, source_order_id: serviceOrder.id, imap_status: status }, orderId: serviceOrder.id });
    await supabase.from('tracked_orders').update({ credits_refunded: true, credits_refunded_at: new Date().toISOString() }).eq('id', order.id);
    await supabase.from('orders').update({ status: 'canceled', metadata: { ...(serviceOrder.metadata || {}), imap_status: status, imap_canceled_at: new Date().toISOString(), credits_refunded_by_imap: refund } }).eq('id', serviceOrder.id);
  }
  return { saved: true, order_id: order.id, status };
}

async function scanAccount(supabase, account, adjustCredits = null) {
  const stateResp = await supabase.from('imap_scan_accounts').select('*').eq('user_id', account.user_id).eq('email', account.email).maybeSingle();
  const state = stateResp.data || {};
  const client = new ImapFlow({
    host: account.provider.host, port: account.provider.port, secure: account.provider.secure,
    auth: { user: account.email, pass: account.password }, logger: false,
    connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 120000
  });
  let saved = 0, checked = 0, highestUid = Number(state.last_seen_uid || 0);
  try {
    await client.connect();
    let mailboxName = 'INBOX';
    if (account.provider.name === 'gmail') {
      try {
        const boxes = await client.list();
        mailboxName = boxes.find(box => box.specialUse === '\\All')?.path || 'INBOX';
      } catch (_) {}
    }
    const lock = await client.getMailboxLock(mailboxName);
    try {
      let range;
      if (highestUid > 0) range = `${highestUid + 1}:*`;
      else {
        const since = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400000);
        const uids = await client.search({ since });
        range = uids.slice(-MAX_MESSAGES_PER_SCAN);
      }
      if ((Array.isArray(range) && !range.length)) return { checked: 0, saved: 0 };
      const fetchRange = Array.isArray(range) ? range : range;
      for await (const msg of client.fetch(fetchRange, { uid: true, source: true, envelope: true })) {
        checked += 1; highestUid = Math.max(highestUid, Number(msg.uid || 0));
        try {
          const parsed = await simpleParser(msg.source);
          const result = await saveParsedMessage(supabase, account, parsed, msg.uid, adjustCredits);
          if (result.saved) saved += 1;
        } catch (e) { console.error('IMAP message parse failed', account.email, msg.uid, e.message); }
        if (checked >= MAX_MESSAGES_PER_SCAN) break;
      }
    } finally { lock.release(); }
    await upsertScanState(supabase, account, { last_scan_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error: null, last_seen_uid: highestUid, is_enabled: true });
    return { checked, saved };
  } catch (err) {
    await upsertScanState(supabase, account, { last_scan_at: new Date().toISOString(), last_error: String(err.message || err).slice(0, 1000), last_seen_uid: highestUid });
    throw err;
  } finally { try { await client.logout(); } catch (_) {} }
}

let scanRunning = false;
async function scanAll(supabase, userId = null, adjustCredits = null) {
  if (scanRunning && !userId) return { skipped: true };
  if (!userId) scanRunning = true;
  try {
    let accounts = await loadScanAccounts(supabase, userId);
    if (userId) await syncServiceOrders(supabase, userId, accounts);
    if (!userId && accounts.length > MAX_ACCOUNTS_PER_CYCLE) {
      const start = backgroundAccountCursor % accounts.length;
      accounts = [...accounts.slice(start), ...accounts.slice(0, start)].slice(0, MAX_ACCOUNTS_PER_CYCLE);
      backgroundAccountCursor = (start + accounts.length) % Math.max(1, (await loadScanAccounts(supabase, null)).length);
    }
    const results = [];
    for (const account of accounts) {
      try { results.push({ email: account.email, ...(await scanAccount(supabase, account, adjustCredits)) }); }
      catch (err) { results.push({ email: account.email, error: err.message }); }
    }
    return { accounts: accounts.length, results };
  } finally { if (!userId) scanRunning = false; }
}

async function tcgToken() {
  const publicKey = clean(process.env.TCGPLAYER_PUBLIC_KEY);
  const privateKey = clean(process.env.TCGPLAYER_PRIVATE_KEY);
  if (!publicKey || !privateKey) throw new Error('TCGplayer API keys are not configured');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: publicKey, client_secret: privateKey });
  const resp = await fetch('https://api.tcgplayer.com/token', { method: 'POST', headers: {'content-type':'application/x-www-form-urlencoded'}, body });
  if (!resp.ok) throw new Error(`TCGplayer authorization failed (${resp.status})`);
  return (await resp.json()).access_token;
}


async function persistVerifiedMailbox(supabase, userId, profileId, email, password) {
  const cleanProfileId = clean(profileId);
  if (!cleanProfileId) return { saved: false, reason: 'profile_id_missing' };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,user_id,account_type')
    .eq('id', cleanProfileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (profileError || !profile) return { saved: false, reason: 'profile_not_found' };

  // Always keep the legacy account row synchronized because every deployment has this table.
  const { data: existingRows, error: existingError } = await supabase
    .from('accounts')
    .select('id')
    .eq('profile_id', cleanProfileId)
    .limit(1);
  if (existingError) throw existingError;
  const payload = {
    profile_id: cleanProfileId,
    provider: clean(profile.account_type || 'target'),
    login_email: email,
    gmail_app_password: password
  };
  if (existingRows?.[0]?.id) {
    const { error } = await supabase.from('accounts').update(payload).eq('id', existingRows[0].id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('accounts').insert(payload);
    if (error) throw error;
  }

  // Keep the newer per-store credential row synchronized when that migration exists.
  try {
    const store = lower(profile.account_type || 'target') || 'target';
    const { data: existingCredential } = await supabase
      .from('profile_store_credentials')
      .select('id')
      .eq('profile_id', cleanProfileId)
      .eq('store', store)
      .maybeSingle();
    const credentialPayload = {
      profile_id: cleanProfileId,
      store,
      login_email: email,
      gmail_app_password: password
    };
    if (existingCredential?.id) await supabase.from('profile_store_credentials').update(credentialPayload).eq('id', existingCredential.id);
    else await supabase.from('profile_store_credentials').insert(credentialPayload);
  } catch (_) {
    // The legacy accounts row above remains the canonical fallback.
  }

  return { saved: true, profile_id: cleanProfileId };
}


function aycdConfig() {
  const baseUrl = clean(process.env.AYCD_INBOX_API_BASE_URL || process.env.AYCD_INBOX_API_URL).replace(/\/$/, '');
  const apiKey = clean(process.env.AYCD_INBOX_API_KEY);
  const searchPath = clean(process.env.AYCD_INBOX_SEARCH_PATH || '/mail/search');
  return {
    // AYCD's Inbox API key alone is intended for supported local AYCD clients. A Render service also
    // needs an externally reachable endpoint (UpLink/bridge). Never treat the key by itself as remote access.
    enabled: lower(process.env.AYCD_INBOX_ENABLED || 'false') === 'true' && !!baseUrl && !!apiKey,
    baseUrl,
    apiKey,
    searchPath: searchPath.startsWith('/') ? searchPath : `/${searchPath}`,
    timeoutMs: Math.max(5000, Number(process.env.AYCD_INBOX_TIMEOUT_MS || 30000)),
    maxResults: Math.max(25, Math.min(2000, Number(process.env.AYCD_INBOX_MAX_RESULTS || 500)))
  };
}

function aycdHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
    'api-key': apiKey
  };
}

function normalizeAycdMessages(payload) {
  const source = Array.isArray(payload) ? payload
    : Array.isArray(payload?.messages) ? payload.messages
    : Array.isArray(payload?.emails) ? payload.emails
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.results) ? payload.results
    : [];
  return source.map((m, index) => ({
    uid: clean(m.uid || m.id || m.message_id || m.messageId || `aycd-${index}`),
    subject: clean(m.subject || m.title),
    from: clean(m.from?.text || m.from || m.sender || m.sender_email || m.senderEmail),
    text: clean(m.text || m.body_text || m.bodyText || m.body || m.snippet),
    html: m.html || m.body_html || m.bodyHtml || null,
    messageId: clean(m.message_id || m.messageId || m.id),
    date: m.date || m.received_at || m.receivedAt || m.created_at || m.createdAt || new Date().toISOString(),
    mailboxEmail: lower(m.account_email || m.accountEmail || m.mailbox || m.email_account || '')
  })).filter(m => m.subject || m.text || m.html);
}

async function fetchAycdMessages(query = '') {
  const cfg = aycdConfig();
  if (!cfg.enabled) return { configured: false, messages: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.baseUrl}${cfg.searchPath}`, {
      method: 'POST',
      headers: aycdHeaders(cfg.apiKey),
      body: JSON.stringify({ query, search: query, limit: cfg.maxResults, max_results: cfg.maxResults }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text }; }
    if (!response.ok) throw new Error(payload?.error || payload?.message || `AYCD Inbox API returned ${response.status}`);
    return { configured: true, messages: normalizeAycdMessages(payload), raw_count: Number(payload?.count || 0) };
  } finally {
    clearTimeout(timer);
  }
}

async function scanAycdForUser(supabase, userId, adjustCredits = null) {
  const cfg = aycdConfig();
  if (!cfg.enabled) return { configured: false, checked: 0, matched: 0, ignored: 0 };
  const serviceOrders = await loadServiceOrders(supabase, userId);
  const refs = [...new Set(serviceOrders.flatMap(collectOrderRefs))].filter(Boolean);
  if (!refs.length) return { configured: true, checked: 0, matched: 0, ignored: 0 };
  // Keep the request broad enough for AYCD implementations that accept plain text search.
  const query = refs.slice(0, 250).join(' OR ');
  const result = await fetchAycdMessages(query);
  let matched = 0, ignored = 0;
  for (const m of result.messages) {
    const account = {
      user_id: userId,
      profile_id: null,
      email: m.mailboxEmail || 'aycd-inbox@connected.local',
      provider: { name: 'aycd', host: '', port: 0, secure: true }
    };
    const parsed = {
      subject: m.subject,
      from: { text: m.from },
      text: m.text,
      html: m.html,
      messageId: m.messageId,
      date: new Date(m.date)
    };
    const saved = await saveParsedMessage(supabase, account, parsed, m.uid, adjustCredits);
    if (saved?.ignored) ignored += 1; else matched += 1;
  }
  return { configured: true, checked: result.messages.length, matched, ignored };
}

function registerOrderTracker({ app, supabase, auth, admin, adjustUserCredits }) {
  app.post('/orders/imap-test', auth, async (req, res) => {
    const email = lower(req.body?.email);
    const provider = providerForEmail(email);
    const password = normalizeMailboxPassword(req.body?.password, provider?.name);
    if (!email || !provider) {
      return res.status(400).json({ error: 'Enter a supported Gmail, Outlook, Yahoo, or iCloud email address.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Enter the mailbox app password before testing.' });
    }

    const client = new ImapFlow({
      host: provider.host,
      port: provider.port,
      secure: provider.secure,
      auth: { user: email, pass: password },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      let mailbox = null;
      try {
        mailbox = { name: client.mailbox?.path || 'INBOX', messages: Number(client.mailbox?.exists || 0) };
      } finally {
        lock.release();
      }
      await client.logout();
      const persisted = await persistVerifiedMailbox(supabase, req.user_id, req.body?.profile_id, email, password);
      if (persisted.saved) {
        // Register the verified mailbox immediately. Do not depend on a second discovery pass before
        // the Order Tracker page can display the connected account.
        await upsertScanState(supabase, {
          user_id: req.user_id,
          profile_id: persisted.profile_id,
          email,
          provider
        }, { is_enabled: true, last_error: null });
      }
      return res.json({
        success: true,
        provider: provider.name,
        email,
        mailbox,
        saved: persisted.saved,
        profile_id: persisted.profile_id || null,
        message: persisted.saved
          ? `IMAP connected and linked to this profile for ${email}.`
          : `IMAP connected successfully to ${email}. Save the profile, then test again to link it.`
      });
    } catch (err) {
      try { client.close(); } catch (_) {}
      const raw = String(err?.responseText || err?.message || 'IMAP connection failed');
      let message = raw;
      if (/authentication|auth|credentials|invalid|login failed/i.test(raw)) {
        message = provider.name === 'gmail'
          ? 'Gmail rejected the login. Confirm 2-Step Verification is enabled and use a 16-character Google App Password, not the normal Gmail password.'
          : `${provider.name} rejected the mailbox login. Confirm the email and app password are correct.`;
      } else if (/timeout|timed out/i.test(raw)) {
        message = 'The mailbox connection timed out. Try again in a moment.';
      }
      return res.status(400).json({ error: message, provider: provider.name });
    }
  });


  app.get('/orders/bootstrap', auth, async (req, res) => {
    try {
      const discovered = await loadScanAccounts(supabase, req.user_id);
      await syncServiceOrders(supabase, req.user_id, discovered);
      for (const account of discovered) {
        try { await upsertScanState(supabase, account, { is_enabled: true }); } catch (_) {}
      }
      let states = [];
      try {
        const stateResult = await supabase.from('imap_scan_accounts').select('*').eq('user_id', req.user_id).order('email');
        if (!stateResult.error) states = stateResult.data || [];
      } catch (_) {}
      const stateByEmail = new Map(states.map(row => [lower(row.email), row]));
      const accounts = discovered.map(account => ({
        ...(stateByEmail.get(account.email) || {}),
        user_id: account.user_id,
        profile_id: account.profile_id,
        email: account.email,
        provider: account.provider.name,
        connected: true,
        credential_ready: true
      }));
      for (const state of states) {
        const email = lower(state.email);
        if (!email || accounts.some(a => lower(a.email) === email)) continue;
        accounts.push({ ...state, email, provider: state.provider || 'imap', connected: true, credential_ready: false });
      }
      let q = supabase.from('tracked_orders').select('*, tracked_order_events(*)').eq('user_id', req.user_id).order('order_date', { ascending: false }).limit(1000);
      const { data, error } = await q;
      if (error) throw error;
      const orders = data || [];
      const summary = orders.reduce((a,o) => { a.total += Number(o.total || 0); a[o.status] = (a[o.status]||0)+1; return a; }, { total:0 });
      summary.success_rate = orders.length ? Math.round(((summary.delivered || 0) + (summary.shipped || 0)) / orders.length * 1000) / 10 : 0;
      res.json({
        accounts,
        connected_count: accounts.length,
        orders,
        summary,
        aycd: { configured: req.role === 'super_admin', mode: 'local_unified_imap_bridge' },
        is_super_admin: req.role === 'super_admin'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/orders/aycd-status', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD Unified Inbox.' });
    res.json({ configured: true, mode: 'local_unified_imap_bridge', requires_local_helper: true });
  });

  // The AYCD IMAP server shown in Inbox binds to 127.0.0.1. Render cannot reach that loopback
  // address, so the bundled local helper scans AYCD on the laptop and submits parsed messages here.
  app.post('/orders/aycd-bridge-ingest', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD Unified Inbox.' });
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 1000) : [];
      const account = {
        user_id: req.user_id,
        profile_id: null,
        email: 'inbox@aycd.me',
        provider: { name: 'aycd-unified-imap', host: '127.0.0.1', port: 0, secure: false }
      };
      await syncServiceOrders(supabase, req.user_id, [account]);
      let checked = 0, matched = 0, ignored = 0;
      const results = [];
      for (const item of messages) {
        checked += 1;
        try {
          const parsed = {
            subject: clean(item.subject),
            from: { text: clean(item.from) },
            text: clean(item.text),
            html: clean(item.html),
            date: item.date ? new Date(item.date) : new Date(),
            messageId: clean(item.messageId) || `aycd:${clean(item.uid) || checked}`
          };
          const result = await saveParsedMessage(supabase, account, parsed, item.uid || checked, adjustUserCredits);
          if (result?.saved) matched += 1; else ignored += 1;
          results.push(result || { ignored: true });
        } catch (error) {
          results.push({ error: error.message });
        }
      }
      try {
        await upsertScanState(supabase, account, {
          is_enabled: true,
          last_scan_at: new Date().toISOString(),
          last_success_at: new Date().toISOString(),
          last_error: null
        });
      } catch (_) {}
      res.json({ success: true, checked, matched, ignored, results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/orders/scan', auth, async (req, res) => {
    try { res.json({ success: true, ...(await scanAll(supabase, req.user_id, adjustUserCredits)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/orders/scan-status', auth, async (req, res) => {
    try {
      const discovered = await loadScanAccounts(supabase, req.user_id);
      await syncServiceOrders(supabase, req.user_id, discovered);
      for (const account of discovered) {
        try { await upsertScanState(supabase, account, { is_enabled: true }); } catch (_) {}
      }

      let states = [];
      try {
        const stateResult = await supabase.from('imap_scan_accounts').select('*').eq('user_id', req.user_id).order('email');
        if (!stateResult.error) states = stateResult.data || [];
      } catch (_) {}
      const stateByEmail = new Map(states.map(row => [lower(row.email), row]));
      const accountsByEmail = new Map();
      for (const account of discovered) {
        accountsByEmail.set(account.email, {
          ...(stateByEmail.get(account.email) || {}),
          user_id: account.user_id,
          profile_id: account.profile_id,
          email: account.email,
          provider: account.provider.name,
          is_enabled: true,
          connected: true,
          credential_ready: true
        });
      }
      // A verified test should be visible immediately, even if a legacy credential lookup later fails.
      for (const state of states) {
        const email = lower(state.email);
        if (!email || accountsByEmail.has(email)) continue;
        accountsByEmail.set(email, {
          ...state,
          email,
          provider: state.provider || providerForEmail(email)?.name || 'imap',
          connected: true,
          credential_ready: false
        });
      }
      const accounts = [...accountsByEmail.values()];
      res.json({ accounts, connected_count: accounts.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/orders/tracked', auth, async (req, res) => {
    const discovered = await loadScanAccounts(supabase, req.user_id);
    await syncServiceOrders(supabase, req.user_id, discovered);
    let q = supabase.from('tracked_orders').select('*, tracked_order_events(*)').eq('user_id', req.user_id).order('order_date', { ascending: false }).limit(1000);
    if (req.query.status) q = q.eq('status', clean(req.query.status));
    if (req.query.year) {
      const y = Number(req.query.year); q = q.gte('order_date', `${y}-01-01T00:00:00Z`).lt('order_date', `${y+1}-01-01T00:00:00Z`);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const orders = data || [];
    const summary = orders.reduce((a,o) => { a.total += Number(o.total || 0); a[o.status] = (a[o.status]||0)+1; return a; }, { total:0 });
    summary.success_rate = orders.length ? Math.round(((summary.delivered || 0) + (summary.shipped || 0)) / orders.length * 1000) / 10 : 0;
    res.json({ orders, summary });
  });

  app.patch('/orders/tracked/:id', auth, async (req, res) => {
    const allowed = ['status','credits_spent','product_summary','total','subtotal','tax','shipping','tracking_number','carrier'];
    const patch = {}; for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('tracked_orders').update(patch).eq('id', req.params.id).eq('user_id', req.user_id).select().single();
    if (error) return res.status(500).json({ error: error.message }); res.json({ order: data });
  });

  app.delete('/orders/tracked/:id', auth, async (req, res) => {
    const { error } = await supabase.from('tracked_orders').delete().eq('id', req.params.id).eq('user_id', req.user_id);
    if (error) return res.status(500).json({ error: error.message }); res.json({ success: true });
  });

  app.get('/orders/receipt/:id', auth, async (req, res) => {
    const { data, error } = await supabase.from('tracked_orders').select('*').eq('id', req.params.id).eq('user_id', req.user_id).maybeSingle();
    if (error || !data) return res.status(404).send('Receipt not found');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${htmlEscape(data.order_number)}</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:32px auto;padding:20px}.head{border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:20px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.receipt{margin-top:24px;border-top:1px solid #ccc;padding-top:18px}@media print{button{display:none}}</style></head><body><button onclick="print()">Print receipt</button><div class="head"><h1>${htmlEscape(data.store)} receipt</h1><div class="meta"><div><b>Order:</b> ${htmlEscape(data.order_number)}</div><div><b>Status:</b> ${htmlEscape(data.status)}</div><div><b>Date:</b> ${htmlEscape(data.order_date || '')}</div><div><b>Total:</b> $${Number(data.total || 0).toFixed(2)}</div></div></div><div class="receipt">${data.receipt_html || `<pre>${htmlEscape(data.receipt_text || 'No email receipt body stored.')}</pre>`}</div></body></html>`);
  });

  app.get('/orders/tax-export', auth, async (req, res) => {
    const year = Number(req.query.year || new Date().getFullYear());
    const { data, error } = await supabase.from('tracked_orders').select('*').eq('user_id', req.user_id)
      .gte('order_date', `${year}-01-01T00:00:00Z`).lt('order_date', `${year+1}-01-01T00:00:00Z`)
      .in('status', ['confirmed','processing','shipped','delivered']).order('order_date');
    if (error) return res.status(500).send(error.message);
    const rows = data || [];
    const total = rows.reduce((s,o)=>s+Number(o.total||0)+Number(o.credits_spent||0),0);
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${year} Order Receipts</title><style>body{font-family:Arial,sans-serif;margin:28px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}.receipt{page-break-before:always}.no-print{margin-bottom:16px}@media print{.no-print{display:none}}</style></head><body><div class="no-print"><button onclick="print()">Print / Save as PDF</button></div><h1>${year} Successful Order Receipt Archive</h1><p>${rows.length} orders • Combined purchase + credits: $${total.toFixed(2)}</p><table><thead><tr><th>Date</th><th>Store</th><th>Order</th><th>Status</th><th>Purchase</th><th>Credits</th></tr></thead><tbody>${rows.map(o=>`<tr><td>${htmlEscape((o.order_date||'').slice(0,10))}</td><td>${htmlEscape(o.store)}</td><td>${htmlEscape(o.order_number)}</td><td>${htmlEscape(o.status)}</td><td>$${Number(o.total||0).toFixed(2)}</td><td>$${Number(o.credits_spent||0).toFixed(2)}</td></tr>`).join('')}</tbody></table>${rows.map(o=>`<section class="receipt"><h2>${htmlEscape(o.store)} — ${htmlEscape(o.order_number)}</h2>${o.receipt_html || `<pre>${htmlEscape(o.receipt_text || '')}</pre>`}</section>`).join('')}</body></html>`);
  });

  app.get('/investment', auth, async (req, res) => {
    const { data, error } = await supabase.from('investment_products').select('*').eq('user_id', req.user_id).order('created_at', { ascending:false });
    if (error) return res.status(500).json({ error: error.message });
    const items = data || [];
    const summary = items.reduce((a,i)=>{ const q=Number(i.quantity||1); a.purchase+=Number(i.purchase_price||0); a.credits+=Number(i.credits_value||0); a.market+=Number(i.market_price||0)*q; return a; },{purchase:0,credits:0,market:0});
    summary.invested = summary.purchase + summary.credits; summary.gain = summary.market - summary.invested; summary.roi = summary.invested ? summary.gain/summary.invested*100 : 0;
    res.json({ items, summary, tcgplayer_configured: !!(process.env.TCGPLAYER_PUBLIC_KEY && process.env.TCGPLAYER_PRIVATE_KEY) });
  });

  app.post('/investment', auth, async (req, res) => {
    const row = { user_id:req.user_id, product_name:clean(req.body.product_name), store:clean(req.body.store), order_number:clean(req.body.order_number), sku:clean(req.body.sku)||null, category:clean(req.body.category)||null, upc:clean(req.body.upc)||null, condition:clean(req.body.condition)||'sealed', quantity:Number(req.body.quantity||1), purchase_price:Number(req.body.purchase_price||0), credits_value:Number(req.body.credits_value||0), market_price:req.body.market_price===''?null:Number(req.body.market_price), market_source:clean(req.body.market_source)||'manual', tcgplayer_product_id:req.body.tcgplayer_product_id||null, tcgplayer_sku:req.body.tcgplayer_sku||null, image_url:clean(req.body.image_url)||null };
    if (!row.product_name) return res.status(400).json({ error:'Product name is required' });
    const { data,error }=await supabase.from('investment_products').insert(row).select().single(); if(error)return res.status(500).json({error:error.message}); res.json({item:data});
  });

  app.patch('/investment/:id', auth, async (req,res)=>{
    const allowed=['product_name','store','order_number','sku','category','upc','condition','quantity','purchase_price','credits_value','market_price','market_source','tcgplayer_product_id','tcgplayer_sku','image_url']; const patch={updated_at:new Date().toISOString()};
    for(const k of allowed) if(Object.prototype.hasOwnProperty.call(req.body||{},k)) patch[k]=req.body[k]===''?null:req.body[k];
    if(Object.prototype.hasOwnProperty.call(patch,'market_price')) patch.market_updated_at=new Date().toISOString();
    const {data,error}=await supabase.from('investment_products').update(patch).eq('id',req.params.id).eq('user_id',req.user_id).select().single(); if(error)return res.status(500).json({error:error.message}); res.json({item:data});
  });

  app.delete('/investment/:id', auth, async (req,res)=>{ const {error}=await supabase.from('investment_products').delete().eq('id',req.params.id).eq('user_id',req.user_id); if(error)return res.status(500).json({error:error.message}); res.json({success:true}); });

  app.post('/investment/refresh-tcgplayer', auth, async (req,res)=>{
    try {
      const { data: items, error } = await supabase.from('investment_products').select('*').eq('user_id', req.user_id).or('tcgplayer_sku.not.is.null,tcgplayer_product_id.not.is.null');
      if(error) throw error; const token=await tcgToken(); let updated=0;
      for(const item of items||[]){
        let url=''; if(item.tcgplayer_sku) url=`https://api.tcgplayer.com/pricing/marketprices/${item.tcgplayer_sku}`; else if(item.tcgplayer_product_id) url=`https://api.tcgplayer.com/pricing/product/${item.tcgplayer_product_id}`; else continue;
        const r=await fetch(url,{headers:{Authorization:`bearer ${token}`,Accept:'application/json'}}); if(!r.ok) continue; const j=await r.json(); const result=(j.results||[])[0]; const price=result?.marketPrice ?? result?.lowPrice ?? null; if(price==null) continue;
        await supabase.from('investment_products').update({market_price:Number(price),market_source:'TCGplayer',market_updated_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',item.id).eq('user_id',req.user_id); updated++;
      }
      res.json({success:true,updated});
    } catch(e){res.status(500).json({error:e.message});}
  });

  if (process.env.IMAP_ORDER_TRACKER_ENABLED !== 'false') {
    setTimeout(() => scanAll(supabase).catch(e => console.error('Initial IMAP order scan failed:', e.message)), 30000);
    setInterval(() => scanAll(supabase).catch(e => console.error('Scheduled IMAP order scan failed:', e.message)), SCAN_INTERVAL_MS);
  }
}

module.exports = { registerOrderTracker, scanAll };
