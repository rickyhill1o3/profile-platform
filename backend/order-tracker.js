const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { encrypt, decrypt } = require('./encryption');
const { parseRetailEmail, expectedWebhookItems, matchScore, mainItemMatch, deriveOverallStatus, parseSupremeWebhookCheckoutAt, norm: reconcileNorm } = require('./retailer-reconciliation');

const SCAN_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.IMAP_SCAN_INTERVAL_MS || 5 * 60 * 1000));
const INITIAL_LOOKBACK_DAYS = Math.max(7, Number(process.env.IMAP_INITIAL_LOOKBACK_DAYS || 365));
const INITIAL_SCAN_START = process.env.IMAP_INITIAL_SCAN_START || '2026-01-01T00:00:00.000Z';
const MAX_MESSAGES_PER_SCAN = Math.max(25, Number(process.env.IMAP_MAX_MESSAGES_PER_SCAN || 250));
const MAX_ACCOUNTS_PER_CYCLE = Math.max(1, Number(process.env.IMAP_MAX_ACCOUNTS_PER_CYCLE || 50));
const MIN_RESCAN_INTERVAL_MS = Math.max(0, Number(process.env.IMAP_MIN_RESCAN_INTERVAL_MS || 2 * 60 * 1000));
const AMAZON_GHOST_GRACE_MS = Math.max(10 * 60 * 1000, Number(process.env.AMAZON_GHOST_GRACE_MS || 20 * 60 * 1000));
let backgroundAccountCursor = 0;
const userScanJobs = new Map();
let checkoutScanRuntime = null;
const checkoutScanTimers = new Map();
let historicalRepairRunning = false;

function notifyCheckoutForOrderTracker(userId) {
  if (!userId || !checkoutScanRuntime) return;
  const key = String(userId);
  const existing = checkoutScanTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    checkoutScanTimers.delete(key);
    Promise.resolve(checkoutScanRuntime(key)).catch(err => console.error('Checkout-triggered Order Tracker refresh failed:', err.message || err));
  }, 5000);
  checkoutScanTimers.set(key, timer);
}

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

function htmlToReadableEmailText(value) {
  const html = String(value || '');
  if (!html) return '';
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    $('script,style,head,title,meta,link,noscript,svg').remove();
    // Retailers such as Target deliberately inject thousands of invisible preheader glyphs.
    // They are harmless in an email client but poison plain-text parsing and our email viewer.
    $('[aria-hidden="true"], [hidden]').remove();
    $('*').each((_, el) => {
      const style = lower($(el).attr('style') || '').replace(/\s+/g, '');
      if (/display:none|visibility:hidden|mso-hide:all|max-height:0(?:px)?|font-size:0(?:px)?/.test(style)) $(el).remove();
    });
    $('br').replaceWith('\n');
    $('p,div,tr,li,h1,h2,h3,h4,h5,h6,section,article,table').each((_, el) => $(el).append('\n'));
    return String($.root().text() || '')
      .replace(/[\u00ad\u034f\u2007\u200b-\u200f\u2060\ufeff]/g, ' ')
      .replace(/&#(?:8199|847);/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (_) { return ''; }
}

function readableEmailText(parsed = {}) {
  const plain = clean(parsed.text || '').replace(/\u0000/g, '');
  const htmlText = htmlToReadableEmailText(parsed.html || '');
  if (!htmlText) return plain;
  if (!plain) return htmlText;
  // Prefer HTML-derived text when the text/plain alternative is mostly Target preheader noise,
  // or when HTML contains materially more useful retailer content.
  const plainNoise = (plain.match(/&#(?:8199|847);/gi) || []).length + (plain.match(/[\u034f\u2007\u00ad]/g) || []).length;
  const usefulPlain = plain.replace(/&#(?:8199|847);/gi, '').replace(/[\u034f\u2007\u00ad\s]/g, '').length;
  const usefulHtml = htmlText.replace(/\s/g, '').length;
  if (plainNoise >= 20 || usefulHtml > Math.max(250, usefulPlain * 1.25)) return htmlText;
  return plain;
}


function archivedTargetBodyNeedsRepair(value = {}) {
  const bodyText = clean(value.body_text || value.text || value.snippet || '');
  const bodyHtml = clean(value.body_html || value.html || '');
  const combined = `${bodyText}
${bodyHtml}`;
  const noiseCount = (combined.match(/&#(?:8199|847);/gi) || []).length + (combined.match(/[\u034f\u2007\u00ad]/g) || []).length;
  const usefulText = bodyText
    .replace(/&#(?:8199|847);/gi, ' ')
    .replace(/[\u034f\u2007\u00ad]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const htmlReadable = bodyHtml ? htmlToReadableEmailText(bodyHtml) : '';
  return noiseCount >= 20 || (!htmlReadable && usefulText.length < 80);
}

async function backfillDamagedTargetArchiveCopies(supabase, account, archivedRow, row) {
  if (!archivedRow?.id || lower(row.store) !== 'target' || archivedTargetBodyNeedsRepair(row)) return 0;
  if (!clean(row.order_number) || !clean(row.email_type) || !clean(row.subject)) return 0;
  try {
    const q = await supabase.from('email_messages')
      .select('id,body_text,body_html,snippet')
      .eq('user_id', row.user_id)
      .eq('mailbox_email', row.mailbox_email)
      .eq('order_number', row.order_number)
      .eq('email_type', row.email_type)
      .eq('subject', row.subject)
      .limit(25);
    if (q.error) return 0;
    let repaired = 0;
    for (const old of q.data || []) {
      if (String(old.id) === String(archivedRow.id) || !archivedTargetBodyNeedsRepair(old)) continue;
      const patch = {
        body_text: row.body_text,
        body_html: row.body_html,
        snippet: row.snippet,
        updated_at: new Date().toISOString()
      };
      const r = await supabase.from('email_messages').update(patch).eq('id', old.id);
      if (!r.error) repaired++;
    }
    return repaired;
  } catch (_) { return 0; }
}

function providerForEmail(email) {
  const domain = lower(email).split('@')[1] || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return { name: 'gmail', host: 'imap.gmail.com', port: 993, secure: true };
  if (['outlook.com','hotmail.com','live.com','msn.com'].includes(domain)) return { name: 'outlook', host: 'outlook.office365.com', port: 993, secure: true };
  if (['yahoo.com','ymail.com','rocketmail.com'].includes(domain)) return { name: 'yahoo', host: 'imap.mail.yahoo.com', port: 993, secure: true };
  if (['icloud.com','me.com','mac.com'].includes(domain)) return { name: 'icloud', host: 'imap.mail.me.com', port: 993, secure: true };
  return null;
}

function providerFromImportedRow(row = {}) {
  const emailProvider = providerForEmail(row.email);
  const rawProvider = lower(row.provider || row.provider_name || '');
  const host = clean(row.imap_host || row.host || emailProvider?.host);
  const port = Number(row.imap_port || row.port || emailProvider?.port || 993);
  const secure = row.imap_secure == null ? (emailProvider?.secure !== false) : !!row.imap_secure;
  let name = emailProvider?.name || rawProvider.replace(/[^a-z0-9]/g, '') || 'imap';
  if (/outlook|hotmail|microsoft|live/.test(rawProvider)) name = 'outlook';
  if (/gmail|google/.test(rawProvider)) name = 'gmail';
  if (/yahoo/.test(rawProvider)) name = 'yahoo';
  if (/icloud|apple/.test(rawProvider)) name = 'icloud';
  if (!host) return null;
  return { name, host, port, secure };
}

function decryptQuiet(value) {
  try { return value ? decrypt(value) : ''; } catch (_) { return ''; }
}

function parseCsvRecords(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => clean(h));
  return rows.filter(r => r.some(v => clean(v))).map(values => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] == null ? '' : values[i]; });
    return obj;
  });
}

async function fetchAllSupabaseRows(queryFactory, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await queryFactory().range(from, from + pageSize - 1);
    if (r.error) throw r.error;
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

async function fetchEmailArchiveRowsByIds(supabase, userId, ids = [], columns = '*', chunkSize = 75) {
  const out = [];
  const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const r = await supabase.from('email_messages').select(columns)
      .eq('user_id', userId).in('id', chunk);
    if (r.error) throw r.error;
    out.push(...(r.data || []));
  }
  return out;
}

async function fetchRecentEmailArchiveByStore(supabase, userId, store, columns, limit = 1000) {
  // Do not ask PostgREST/Postgres to sort and return hundreds/thousands of large MIME/HTML
  // bodies in one statement. First fetch only primary keys through the indexed user/date path,
  // then hydrate those rows in small PK batches. This keeps each DB statement comfortably below
  // hosted statement_timeout even when some retailer emails contain very large HTML bodies.
  const meta = await supabase.from('email_messages').select('id,received_at')
    .eq('user_id', userId).eq('store', store)
    .order('received_at', { ascending:false }).limit(limit);
  if (meta.error) throw meta.error;
  const ids = (meta.data || []).map(x => x.id).filter(Boolean);
  const rows = await fetchEmailArchiveRowsByIds(supabase, userId, ids, columns, 60);
  const rank = new Map((meta.data || []).map((x,i)=>[String(x.id),i]));
  rows.sort((a,b)=>(rank.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)-(rank.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
  return rows;
}

async function fetchEmailArchiveWindow(supabase, userId, startIso, endIso, columns, limit = 1000) {
  const meta = await supabase.from('email_messages').select('id,received_at')
    .eq('user_id', userId)
    .gte('received_at', startIso).lte('received_at', endIso)
    .order('received_at', { ascending:false }).limit(limit);
  if (meta.error) throw meta.error;
  const ids = (meta.data || []).map(x => x.id).filter(Boolean);
  return fetchEmailArchiveRowsByIds(supabase, userId, ids, columns, 60);
}


async function loadOwnedProfileBuilderGmailAccounts(supabase, userId) {
  // STRICT PRIVACY BOUNDARY: only mailboxes attached to profiles owned by the
  // authenticated Order Tracker user are eligible here. Never walk owner_admin_id,
  // downstream users, admins, or AYCD-imported accounts for Supreme reconciliation.
  const { data: profiles, error: pe } = await supabase
    .from('profiles')
    .select('id,user_id,profile_name')
    .eq('user_id', userId);
  if (pe) throw pe;

  const ownedProfiles = profiles || [];
  const ownedProfileIds = ownedProfiles.map(p => p.id).filter(Boolean);
  const profileMap = new Map(ownedProfiles.map(p => [String(p.id), p]));
  const byEmail = new Map();
  let credentialRows = 0;
  const debug = [];
  debug.push(`Owned Profile Builder profiles: ${ownedProfiles.length}`);

  const addCredential = row => {
    if (!row?.profile_id || !profileMap.has(String(row.profile_id))) { debug.push(`Credential skipped: profile not owned/known (${row?.profile_id || 'no profile id'})`); return; }
    const email = lower(row.login_email || row.email);
    const provider = providerForEmail(email);
    if (!email) { debug.push(`Credential skipped for profile ${row.profile_id}: no login email`); return; }
    if (provider?.name !== 'gmail') { debug.push(`Credential skipped: ${email} provider=${provider?.name || 'unknown'} (not Gmail)`); return; }
    const password = normalizeMailboxPassword(row.gmail_app_password || row.password, 'gmail');
    if (!password) { debug.push(`Credential skipped: ${email} has no Gmail app password in this credential row`); return; }
    debug.push(`Gmail credential accepted: ${email} (profile ${row.profile_id})`);
    // One Gmail mailbox may be reused by several of THIS user's profiles. Scan it once.
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        user_id: userId,
        archive_user_id: userId,
        profile_id: row.profile_id,
        email,
        password,
        provider,
        ingestion_source: 'profile_builder_direct_imap'
      });
    }
  };

  // Read both credential stores used by the Profile Editor. The profile ownership
  // check above is authoritative, so a credential row can never escape this user.
  for (let i = 0; i < ownedProfileIds.length; i += 75) {
    const ids = ownedProfileIds.slice(i, i + 75);
    try {
      const r = await supabase.from('profile_store_credentials')
        .select('profile_id,login_email,gmail_app_password')
        .in('profile_id', ids);
      if (r.error) throw r.error;
      credentialRows += (r.data || []).length;
      for (const row of r.data || []) addCredential(row);
    } catch (e) {
      console.warn('[SUPREME OWNED PROFILE CREDENTIALS]', e.message || e);
    }
    try {
      const r = await supabase.from('accounts')
        .select('profile_id,login_email,gmail_app_password')
        .in('profile_id', ids);
      if (r.error) throw r.error;
      credentialRows += (r.data || []).length;
      for (const row of r.data || []) addCredential(row);
    } catch (e) {
      console.warn('[SUPREME OWNED LEGACY ACCOUNTS]', e.message || e);
    }
  }

  // A mailbox that was successfully tested in Profile Builder can also be recovered
  // from imap_scan_accounts, but only when BOTH the scan-state user_id and profile_id
  // resolve back to this same user's owned profile set.
  try {
    const r = await supabase.from('imap_scan_accounts')
      .select('user_id,profile_id,email')
      .eq('user_id', userId);
    if (!r.error) {
      for (const state of r.data || []) {
        const email = lower(state.email);
        if (!state.profile_id || !profileMap.has(String(state.profile_id)) || byEmail.has(email)) continue;
        const provider = providerForEmail(email);
        if (provider?.name !== 'gmail') continue;
        let credential = null;
        try {
          const c = await supabase.from('profile_store_credentials')
            .select('profile_id,login_email,gmail_app_password')
            .eq('profile_id', state.profile_id)
            .not('gmail_app_password', 'is', null)
            .limit(1);
          credential = c.data?.[0] || null;
        } catch (_) {}
        if (!credential) {
          try {
            const c = await supabase.from('accounts')
              .select('profile_id,login_email,gmail_app_password')
              .eq('profile_id', state.profile_id)
              .not('gmail_app_password', 'is', null)
              .limit(1);
            credential = c.data?.[0] || null;
          } catch (_) {}
        }
        addCredential(credential ? { ...credential, email } : null);
      }
    }
  } catch (_) {}

  return {
    accounts: [...byEmail.values()],
    owned_profiles: ownedProfiles.length,
    credential_rows: credentialRows,
    debug
  };
}

async function discoverSupremeFromProfileBuilderMailboxes(supabase, userId, serviceOrders = [], adjustCredits = null, confirmPendingAmazonCheckout = null, options = {}) {
  // Supreme receipts live in the same Profile Builder IMAP mailboxes already used by the normal
  // Order Tracker scanner. Use that proven loader as the PRIMARY source instead of a second,
  // narrower credential query that can return/throw before any mailbox is scanned on legacy data.
  // loadScanAccounts(userId) is already scoped to the authenticated user's profiles / verified
  // scan-state rows. Imported AYCD rows are explicitly excluded below so this remains Profile
  // Builder / direct-IMAP only and can never walk another user's mailboxes.
  const supremeOrders = (serviceOrders || []).filter(order =>
    normalizeStoreKey(order.site || order.metadata?.site || extractNamedPayloadValue(order.raw_payload || {}, ['site','store'])) === 'supreme'
  );
  const debug = [`Supreme service/webhook orders recognized: ${supremeOrders.length}`];

  const stamps=[];
  for (const order of supremeOrders) {
    let webhookCheckout='';
    try { webhookCheckout=parseSupremeWebhookCheckoutAt(order)||''; }
    catch (e) { debug.push(`Supreme order ${order.id||'-'}: checkout-time parser ignored error: ${e.message||e}`); }
    for (const value of [order.created_at, webhookCheckout]) {
      try {
        const ms=new Date(value||0).getTime();
        const minSane=Date.UTC(2000,0,1), maxSane=Date.now()+7*86400000;
        if(Number.isFinite(ms) && ms>=minSane && ms<=maxSane) stamps.push(ms);
        else if(value) debug.push(`Supreme order ${order.id||'-'}: ignored invalid timestamp value=${String(value).slice(0,120)}`);
      } catch (e) { debug.push(`Supreme order ${order.id||'-'}: ignored timestamp conversion error: ${e.message||e}`); }
    }
  }
  // Never let malformed/legacy timestamps abort Supreme discovery before mailbox loading.
  // Some historical service-order timestamps can parse to an out-of-range Date even though
  // getTime() looked numeric upstream. Clamp the live-search floor to a sane epoch range and
  // fall back to one year if anything is unusable.
  const fallbackSinceMs = Date.now() - 365 * 86400000;
  let sinceMs = (stamps.length ? Math.min(...stamps) : fallbackSinceMs) - 2 * 86400000;
  const minSaneMs = Date.UTC(2000, 0, 1);
  const maxSaneMs = Date.now() + 2 * 86400000;
  if (!Number.isFinite(sinceMs) || sinceMs < minSaneMs || sinceMs > maxSaneMs) sinceMs = fallbackSinceMs;
  let since = new Date(sinceMs);
  if (!Number.isFinite(since.getTime())) since = new Date(fallbackSinceMs);
  debug.push(`Live Supreme mailbox search since: ${since.toISOString()}`);

  let normalScanAccounts = [];
  try {
    normalScanAccounts = await loadScanAccounts(supabase, userId);
    debug.push(`Normal Order Tracker loader returned ${normalScanAccounts.length} mailbox account(s) for this user.`);
  } catch (e) {
    debug.push(`FATAL: normal Order Tracker mailbox loader failed: ${e.message || e}`);
    return { profile_mailboxes:0, owned_profiles:0, credential_rows:0, mailboxes_checked:0, messages_found:0, messages_saved:0, failures:1, debug };
  }

  // Search the authenticated user's COMPLETE mailbox pool rather than trusting the purchase email
  // guessed from a Supreme webhook/profile. Regular users/admins get only the direct IMAP mailboxes
  // they configured in Profile Builder. The super admin may additionally search the AYCD/OAuth2
  // mailboxes imported into that same super-admin account. No mailbox owned by another website user
  // is eligible, even when an email address or bot profile name happens to match.
  const includeImported = !!options.includeImported;
  const merged = new Map();
  for (const a of normalScanAccounts) {
    const email = lower(a.email);
    const belongsToUser = String(a.user_id || '') === String(userId) || String(a.archive_user_id || '') === String(userId);
    const isImported = !!a.imported_account_id || /^aycd/i.test(String(a.ingestion_source || ''));
    const isDirectProfile = !!a.profile_id && !isImported;
    if (!belongsToUser || !email || (!isDirectProfile && !(includeImported && isImported))) continue;
    const provider = a.provider || providerForEmail(email);
    if (!provider?.host) continue;
    if (!merged.has(email)) merged.set(email, {
      ...a,
      user_id:userId,
      archive_user_id:a.archive_user_id || userId,
      provider,
      ingestion_source:isImported ? (a.ingestion_source || 'aycd_import') : 'profile_builder_direct_imap'
    });
  }

  // Secondary diagnostic-only loader. It is no longer allowed to prevent the scan. If it finds
  // an additional owned Gmail credential, merge it; if its schema query fails, record that fact.
  let ownedProfiles = 0, credentialRows = 0;
  try {
    const ownedMailboxLoad = await loadOwnedProfileBuilderGmailAccounts(supabase, userId);
    ownedProfiles = ownedMailboxLoad.owned_profiles || 0;
    credentialRows = ownedMailboxLoad.credential_rows || 0;
    debug.push(...(ownedMailboxLoad.debug || []));
    for (const a of ownedMailboxLoad.accounts || []) {
      const email = lower(a.email);
      if (email && !merged.has(email)) merged.set(email, a);
    }
  } catch (e) {
    debug.push(`Narrow Profile Builder credential loader failed (non-fatal): ${e.message || e}`);
  }

  const accounts = [...merged.values()];
  const directCount = accounts.filter(a => !a.imported_account_id && !/^aycd/i.test(String(a.ingestion_source || ''))).length;
  const importedCount = accounts.length - directCount;
  debug.push(`Unique user-owned mailboxes ready to scan: ${accounts.length} (Profile Builder direct: ${directCount}, AYCD/imported: ${importedCount}, includeImported=${includeImported})`);
  for (const a of accounts) debug.push(`Mailbox queued: ${a.email} (profile ${a.profile_id || '-'})`);

  let mailboxesChecked=0, messagesFound=0, messagesSaved=0, failures=0;
  const worker = async account => {
    let auth;
    try {
      auth = await imapAuthForAccount(supabase,account);
    } catch (e) {
      failures++; debug.push(`${account.email}: IMAP AUTH BUILD FAILURE: ${e.message || e}`); return;
    }
    const client=new ImapFlow({host:account.provider.host,port:account.provider.port,secure:account.provider.secure,
      auth,logger:false,connectionTimeout:30000,greetingTimeout:30000,socketTimeout:90000});
    try {
      await client.connect();
      let boxes=[]; try{boxes=await client.list();}catch(_){ }
      // Gmail's All Mail can be localized or unavailable through IMAP. Prefer \All, then INBOX.
      const mailboxName=boxes.find(b=>b.specialUse==='\\All')?.path || 'INBOX';
      const lock=await client.getMailboxLock(mailboxName);
      try {
        mailboxesChecked++;
        debug.push(`Connected: ${account.email}; searching mailbox ${mailboxName}`);
        const uidSet = new Set();
        const searches = [
          { since, from:'support@supremenewyork.com' },
          { since, from:'supremenewyork.com' },
          { since, subject:'online shop order' },
          { since, subject:'online shop order has been shipped' }
        ];
        for (const criteria of searches) {
          try {
            const hits = await client.search(criteria,{uid:true}) || [];
            debug.push(`${account.email}: SEARCH ${JSON.stringify(criteria)} -> ${hits.length} UID(s)`);
            for (const uid of hits) { const n=Number(uid); if(n) uidSet.add(n); }
          } catch (e) {
            debug.push(`${account.email}: SEARCH ${JSON.stringify(criteria)} FAILED: ${e.message || e}`);
          }
        }

        // If Gmail accepted every metadata SEARCH but returned zero, inspect a bounded recent UID
        // tail. This is diagnostic and catches provider SEARCH quirks without downloading the inbox.
        if (!uidSet.size && client.mailbox?.uidNext) {
          const endUid = Math.max(1, Number(client.mailbox.uidNext) - 1);
          const startUid = Math.max(1, endUid - 750);
          debug.push(`${account.email}: metadata search returned 0; inspecting recent UID tail ${startUid}:${endUid}`);
          try {
            for await (const msg of client.fetch(`${startUid}:${endUid}`,{uid:true,envelope:true},{uid:true})) {
              const from = lower((msg.envelope?.from || []).map(x=>`${x.name||''} <${x.address||''}>`).join(' '));
              const subject = clean(msg.envelope?.subject || '');
              if (from.includes('supremenewyork.com') || /^online shop order(?: has been shipped)?$/i.test(subject)) uidSet.add(Number(msg.uid));
            }
          } catch (e) { debug.push(`${account.email}: recent UID metadata tail FAILED: ${e.message || e}`); }
        }

        let uids=[...uidSet].filter(Boolean).sort((a,b)=>a-b).slice(-1000);
        messagesFound += uids.length;
        debug.push(`${account.email}: Supreme metadata search matched ${uids.length} UID(s)`);
        const range=imapUidSet(uids); if(!range) return;
        for await (const msg of client.fetch(range,{uid:true,source:true,envelope:true},{uid:true})) {
          try {
            const parsed=await simpleParser(msg.source);
            const sender=lower(parsed.from?.text||''); const subject=clean(parsed.subject||'');
            debug.push(`${account.email} UID ${msg.uid}: from=${sender || '-'} | subject=${subject || '-'}`);
            const isSupreme = sender.includes('supremenewyork.com') ||
              /^online shop order(?: has been shipped)?$/i.test(subject) || /supreme/i.test(subject);
            if(!isSupreme) { debug.push(`${account.email} UID ${msg.uid}: rejected by Supreme metadata filter`); continue; }
            const result=await saveParsedMessage(supabase,account,parsed,msg.uid,adjustCredits,confirmPendingAmazonCheckout);
            // saveParsedMessage can legitimately return ignored/not-saved when the same Message-ID
            // is already archived. That still means discovery succeeded, so log it distinctly.
            if(result?.saved) { messagesSaved++; debug.push(`${account.email} UID ${msg.uid}: SAVED as Supreme email`); }
            else debug.push(`${account.email} UID ${msg.uid}: Supreme message parsed; archive result=${JSON.stringify(result || {})}`);
          } catch(e) { failures++; debug.push(`${account.email} UID ${msg.uid}: MIME/PARSE FAILURE: ${e.message || e}`); }
        }
      } finally { lock.release(); }
    } catch(e) { failures++; debug.push(`${account.email}: IMAP FAILURE: ${e.message || e}`); console.warn('[SUPREME PROFILE IMAP]',account.email,e.message||e); }
    finally { try{await client.logout();}catch(_){} }
  };

  for(let i=0;i<accounts.length;i+=4) await Promise.all(accounts.slice(i,i+4).map(worker));
  return { profile_mailboxes:accounts.length, owned_profiles:ownedProfiles, credential_rows:credentialRows, mailboxes_checked:mailboxesChecked, messages_found:messagesFound, messages_saved:messagesSaved, failures, debug };
}

async function fetchSupremeArchiveCandidatesForOrders(supabase, userId, serviceOrders = [], columns = '*') {
  // Supreme mail is easy to identify from lightweight RFC822 metadata: the sender is
  // support@supremenewyork.com and the subjects are "online shop order" / "online shop order
  // has been shipped".  Do NOT hydrate the first N arbitrary messages in a date window; users
  // with hundreds of connected mailboxes can have >1,000 unrelated messages in the same day,
  // which previously pushed the actual Supreme receipts outside the LIMIT before filtering.
  const supremeOrders = (serviceOrders || []).filter(order =>
    normalizeStoreKey(order.site || order.metadata?.site || extractNamedPayloadValue(order.raw_payload || {}, ['site','store'])) === 'supreme'
  );
  if (!supremeOrders.length) return { rows: [], metadata_scanned: 0, candidates_found: 0, windows: 0 };

  const spans = [];
  for (const order of supremeOrders) {
    const stamps = [new Date(order.created_at || 0).getTime(), new Date(parseSupremeWebhookCheckoutAt(order) || 0).getTime()]
      .filter(Number.isFinite).filter(ms => ms > 0);
    if (!stamps.length) continue;
    const anchor = Math.min(...stamps);
    // Confirmation arrives immediately; split-shipment emails can arrive days/weeks later.
    spans.push({ start: anchor - 2 * 24 * 60 * 60 * 1000, end: anchor + 120 * 24 * 60 * 60 * 1000 });
  }
  spans.sort((a,b)=>a.start-b.start);
  const windows = [];
  for (const span of spans) {
    const last = windows[windows.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else windows.push({ ...span });
  }

  const candidateMeta = new Map();
  let metadataScanned = 0;
  for (const window of windows.slice(-80)) {
    const rows = await fetchAllSupabaseRows(() => supabase.from('email_messages')
      .select('id,received_at,store,subject,from_text,mailbox_email,message_id')
      .eq('user_id', userId)
      .gte('received_at', new Date(window.start).toISOString())
      .lte('received_at', new Date(window.end).toISOString())
      .order('received_at', { ascending: true }), 750);
    metadataScanned += rows.length;
    for (const row of rows) {
      const sender = lower(row.from_text || '');
      const subject = clean(row.subject || '');
      const looksSupreme = lower(row.store) === 'supreme' ||
        /(?:^|@|\.)supremenewyork\.com\b|support@supremenewyork\.com/i.test(sender) ||
        /^online shop order(?: has been shipped)?$/i.test(subject);
      if (looksSupreme && row.id) candidateMeta.set(String(row.id), row);
    }
  }

  const ids = [...candidateMeta.keys()];
  const hydrated = await fetchEmailArchiveRowsByIds(supabase, userId, ids, columns, 50);
  hydrated.sort((a,b)=>new Date(a.received_at||0)-new Date(b.received_at||0));
  return { rows: hydrated, metadata_scanned: metadataScanned, candidates_found: ids.length, windows: windows.length };
}

async function buildMailboxOwnerMap(supabase) {
  const profiles = await fetchAllSupabaseRows(() => supabase.from('profiles').select('id,user_id'));
  const pmap = new Map(profiles.map(p => [String(p.id), p]));
  const emailMap = new Map();
  const add = (profileId, value) => {
    const email = lower(value);
    const profile = pmap.get(String(profileId));
    if (!email || !profile) return;
    const current = emailMap.get(email) || { profileIds: new Set(), userIds: new Set() };
    current.profileIds.add(String(profile.id)); current.userIds.add(String(profile.user_id));
    emailMap.set(email, current);
  };
  try {
    const rows = await fetchAllSupabaseRows(() => supabase.from('profile_store_credentials').select('profile_id,login_email'));
    for (const row of rows) add(row.profile_id, row.login_email);
  } catch (_) {}
  try {
    const rows = await fetchAllSupabaseRows(() => supabase.from('accounts').select('profile_id,login_email'));
    for (const row of rows) add(row.profile_id, row.login_email);
  } catch (_) {}
  const out = new Map();
  for (const [email, value] of emailMap.entries()) {
    const userIds = [...value.userIds], profileIds = [...value.profileIds];
    out.set(email, userIds.length === 1
      ? { match_status: 'matched', matched_user_id: userIds[0], matched_profile_id: profileIds.length === 1 ? profileIds[0] : null }
      : { match_status: userIds.length > 1 ? 'ambiguous' : 'unmatched', matched_user_id: null, matched_profile_id: null });
  }
  return out;
}

async function refreshImportedMailboxMatches(supabase, importedByUserId = null) {
  const ownerMap = await buildMailboxOwnerMap(supabase);
  let q = supabase.from('imported_mail_accounts').select('id,email,imported_by_user_id');
  if (importedByUserId) q = q.eq('imported_by_user_id', importedByUserId);
  const { data, error } = await q;
  if (error) throw error;
  let matched = 0, ambiguous = 0, unmatched = 0;
  for (const row of data || []) {
    const match = ownerMap.get(lower(row.email)) || { match_status: 'unmatched', matched_user_id: null, matched_profile_id: null };
    if (match.match_status === 'matched') matched++; else if (match.match_status === 'ambiguous') ambiguous++; else unmatched++;
    await supabase.from('imported_mail_accounts').update({ ...match, updated_at: new Date().toISOString() }).eq('id', row.id);
  }
  return { matched, ambiguous, unmatched, total: (data || []).length };
}

async function refreshImportedAccessToken(supabase, account) {
  const refreshToken = decryptQuiet(account.refresh_token_enc);
  const clientId = decryptQuiet(account.client_id_enc);
  const clientSecret = decryptQuiet(account.client_secret_enc);
  if (!refreshToken || !clientId) throw new Error('OAuth refresh token or client ID is missing.');
  const provider = lower(account.provider?.name);
  let url = '', params = null;
  if (provider === 'outlook') {
    url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    params = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
    });
    if (clientSecret) params.set('client_secret', clientSecret);
  } else if (provider === 'gmail') {
    url = 'https://oauth2.googleapis.com/token';
    params = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
    if (clientSecret) params.set('client_secret', clientSecret);
  } else {
    throw new Error(`OAuth refresh is not supported yet for ${provider || 'this provider'}.`);
  }
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(clean(payload.error_description || payload.error || `OAuth refresh failed (${response.status})`));
  const patch = {
    status: 'connected', last_error: null, last_test_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  if (payload.refresh_token && payload.refresh_token !== refreshToken) patch.refresh_token_enc = encrypt(payload.refresh_token);
  if (account.imported_account_id) await supabase.from('imported_mail_accounts').update(patch).eq('id', account.imported_account_id);
  return payload.access_token;
}

async function imapAuthForAccount(supabase, account) {
  if (account.imported_account_id && account.auth_method === 'oauth2') {
    const accessToken = await refreshImportedAccessToken(supabase, account);
    return { user: account.email, accessToken };
  }
  const pass = account.password || decryptQuiet(account.app_password_enc) || decryptQuiet(account.password_enc);
  if (!pass) throw new Error('No usable mailbox credential is available.');
  return { user: account.email, pass: normalizeMailboxPassword(pass, account.provider?.name) };
}

async function loadImportedScanAccounts(supabase, onlyUserId = null) {
  let q = supabase.from('imported_mail_accounts').select('*').eq('is_enabled', true).eq('is_placeholder', false);
  if (onlyUserId) q = q.or(`imported_by_user_id.eq.${onlyUserId},matched_user_id.eq.${onlyUserId}`);
  const { data, error } = await q.order('last_scan_at', { ascending: true, nullsFirst: true });
  if (error) {
    if (/imported_mail_accounts|relation .* does not exist|schema cache/i.test(String(error.message || ''))) return [];
    throw error;
  }
  const out = [];
  for (const row of data || []) {
    const provider = providerFromImportedRow(row);
    if (!provider) continue;
    const effectiveUserId = row.matched_user_id || row.imported_by_user_id;
    out.push({
      user_id: effectiveUserId,
      archive_user_id: row.imported_by_user_id,
      profile_id: row.matched_profile_id || null,
      email: lower(row.email),
      provider,
      ingestion_source: 'aycd_import',
      imported_account_id: row.id,
      auth_method: lower(row.auth_method),
      refresh_token_enc: row.refresh_token_enc,
      client_id_enc: row.client_id_enc,
      client_secret_enc: row.client_secret_enc,
      app_password_enc: row.app_password_enc,
      password_enc: row.password_enc,
      folders: row.folders,
      folder_state: row.folder_state || {}
    });
  }
  return out;
}

function detectStore(from, subject, text) {
  const hay = `${from} ${subject} ${text.slice(0, 3000)}`.toLowerCase();
  if (/target\.com|target order|thanks for shopping at target/.test(hay)) return 'target';
  if (/walmart\.com|walmart order/.test(hay)) return 'walmart';
  if (/samsclub\.com|sam'?s club order/.test(hay)) return 'samsclub';
  if (/amazon\.com|amazon order|amazon\.com/.test(hay)) return 'amazon';
  if (/pokemoncenter\.com|pok[eé]mon center/.test(hay)) return 'pokemoncenter';
  if (/crunchyroll/.test(hay)) return 'crunchyroll';
  if (/supremenewyork\.com|us\.supreme\.com|\bsupreme\b/.test(hay)) return 'supreme';
  if (/books\s*-?\s*a\s*-?\s*million|booksamillion(?:\.com)?|\bbam!?(?:\s|$)/i.test(hay)) return 'booksamillion';
  return '';
}

function detectStatus(subject, text) {
  // Classification intentionally favors explicit subject/status phrases. Retailer HTML often
  // contains generic words such as "delivery" or "delivered" in navigation/footer copy,
  // which previously caused order-confirmation emails (notably Books-A-Million) to be marked
  // delivered before they had even shipped.
  const subj = clean(subject).toLowerCase();
  const body = clean(text).slice(0, 12000).toLowerCase();
  const hay = `${subj} ${body}`;

  if (/cancel(?:led|ed|ation)|unable to fulfill|we had to cancel/.test(subj) ||
      /(?:your|this|the) order (?:has been|was|is) cancel(?:led|ed)|we had to cancel (?:your )?order|unable to fulfill (?:your )?order/.test(body)) return 'canceled';
  if (/refund(?:ed)?|refund issued/.test(subj) || /refund (?:has been|was|is) issued|we(?:'|’)ve refunded|your refund/.test(body)) return 'refunded';

  // A retailer confirmation/summary subject is authoritative. This prevents phrases such as
  // "we will email you as soon as your order has shipped" from being mistaken for a shipment.
  if (/order confirmation|order confirmed|ordered:|thanks for your order|thanks for shopping with us|order received|order placed|order summary|^online shop order$/.test(subj)) return 'confirmed';

  if (/\bdelivered\b|delivery complete|items? (?:has|have) arrived/.test(subj) ||
      /(?:your|the|this) (?:package|order|shipment) (?:has been|was|is) delivered|delivery (?:is )?complete|items? (?:has|have) arrived from order/.test(body)) return 'delivered';

  if (/\bshipped\b|has shipped|on the way/.test(subj) ||
      /(?:your|the|this) (?:package|order|shipment) (?:has|have) shipped|we(?:'|’)ve shipped|was shipped|tracking number\s*[:#]/.test(body)) return 'shipped';

  if (/processing|preparing your order|getting your order ready/.test(subj)) return 'processing';

  if (/order confirmation|thanks for your order|thanks for shopping with us|here(?:'|’)s your order|we(?:'|’)ve got your order|order placed/.test(body)) return 'confirmed';

  if (/we(?:'|’)re processing your order|preparing your order|getting your order ready/.test(body)) return 'processing';
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
    crunchyroll: [/\b(?:order(?: number| #)?\s*[:#]?\s*)([A-Z0-9-]{6,30})\b/i],
    supreme: [/\bOrder\s+(\d{6,20})\b/i, /\border\s*#?\s*(\d{6,20})\b/i],
    booksamillion: [
      /\b(?:order\s*(?:number|no\.?|#)?\s*[:#-]?\s*)(\d{8,20})\b/i,
      /\b(?:delivery\s+orders?\s*)?(?:order\s*)?#\s*[:#-]?\s*(\d{8,20})\b/i,
      /\b(\d{12,16})\b/
    ]
  };
  for (const re of patterns[store] || patterns.target) {
    const m = hay.match(re);
    if (m?.[1]) return m[1].replace(/[.,]$/, '');
  }
  // Some retailers omit the order number from the subject and only place it in the
  // rendered receipt body. Keep this label-based fallback strict so SKU, tracking,
  // phone, and payment numbers are not mistaken for order references.
  const generic = hay.match(/\b(?:order|confirmation|purchase)\s*(?:number|no\.?|id|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{5,29})\b/i);
  return generic?.[1]?.replace(/[.,]$/, '') || '';
}


function extractOrderNumbers(store, subject, text) {
  const hay = `${subject}\n${text}`;
  const found = [];
  const add = value => {
    const v = clean(value).replace(/[.,)\]]+$/, '');
    if (v && !found.includes(v)) found.push(v);
  };
  if (store === 'amazon') {
    for (const m of hay.matchAll(/\b(?:order(?: number| #)?\s*[:#]?\s*)?(\d{3}-\d{7}-\d{7})\b/gi)) add(m[1]);
    for (const m of hay.matchAll(/\b(\d{3})%2d(\d{7})%2d(\d{7})\b/gi)) add(`${m[1]}-${m[2]}-${m[3]}`);
  } else if (store === 'booksamillion') {
    for (const m of hay.matchAll(/\b(?:order\s*(?:number|no\.?|#)?\s*[:#-]?\s*)(\d{8,20})\b/gi)) add(m[1]);
  }
  if (!found.length) add(extractOrderNumber(store, subject, text));
  return found;
}

function extractAmazonItemQuantity(subject, text) {
  const hay = `${subject}\n${text}`;
  const patterns = [
    /\b(?:ordered:\s*)?(\d+)\s+(?:toy\s+)?items?\b/i,
    /\bquantity\s*[:#]?\s*(\d+)\b/i,
    /\bqty\s*[:#]?\s*(\d+)\b/i
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (m?.[1]) return Math.max(1, Number(m[1]) || 1);
  }
  return 1;
}

function findEmailValues(value, out = new Set(), depth = 0) {
  if (depth > 7 || value == null) return out;
  if (Array.isArray(value)) { value.forEach(v => findEmailValues(v, out, depth + 1)); return out; }
  if (typeof value === 'object') { Object.values(value).forEach(v => findEmailValues(v, out, depth + 1)); return out; }
  const matches = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  matches.forEach(email => out.add(lower(email)));
  return out;
}

function findNamedPayloadValue(value, names, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findNamedPayloadValue(item, names, depth + 1); if (found != null) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = lower(key).replace(/[^a-z0-9]/g, '');
    if (names.includes(normalizedKey) && child != null && typeof child !== 'object') return child;
    if (normalizedKey === 'name' && names.includes(lower(value.name).replace(/[^a-z0-9]/g, '')) && value.value != null) return value.value;
  }
  for (const child of Object.values(value)) { const found = findNamedPayloadValue(child, names, depth + 1); if (found != null) return found; }
  return null;
}

async function matchPendingAmazonOrder(supabase, account, parsed, orderNumber, amounts, messageId) {
  const eventMs = new Date(parsed.date || Date.now()).getTime();
  const emailQuantity = extractAmazonItemQuantity(clean(parsed.subject), clean(parsed.text || parsed.html || ''));

  // Amazon Fast can report the task/configured quantity rather than the final
  // quantity Amazon accepted. Therefore quantity is evidence for display only;
  // it must never reject or multiply-confirm a checkout.
  //
  // One Amazon confirmation email consumes exactly one pending webhook. When a
  // burst contains many indistinguishable ghost successes, the closest unused
  // webhook for the same mailbox is selected and all others remain pending.
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', account.user_id)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  const allOrders = data || [];
  const messageAlreadyUsed = allOrders.some(order => {
    const meta = order.metadata || {};
    return clean(meta.matched_email_message_id) === clean(messageId);
  });
  if (messageAlreadyUsed) return null;

  const candidates = allOrders.filter(order => {
    const meta = order.metadata || {};
    if (!String(order.site || meta.site || '').toLowerCase().includes('amazon')) return false;
    if (!(order.status === 'pending_email_verification' || meta.email_verification_required === true)) return false;
    if (meta.matched_email_message_id || meta.email_verified_at || Number(order.credits_charged || 0) > 0) return false;

    const emails = findEmailValues(order.raw_payload || {});
    if (emails.size && !emails.has(lower(account.email))) return false;

    const createdMs = new Date(order.created_at || meta.waiting_for_confirmation_since || 0).getTime();
    // Permit delayed Amazon/AYCD delivery while keeping the match inside the
    // same checkout burst. The nearest unused webhook wins.
    return Number.isFinite(createdMs) && Math.abs(eventMs - createdMs) <= 30 * 60 * 1000;
  }).map(order => {
    const createdMs = new Date(order.created_at || order.metadata?.waiting_for_confirmation_since || 0).getTime();
    const unitPrice = money(order.metadata?.purchase_price || findNamedPayloadValue(order.raw_payload || {}, ['price','unitprice'])) || 0;

    // Total is only a tie-breaker. Amazon emails include tax and the webhook
    // quantity may be wrong, so do not require an exact quantity or total.
    let totalTieBreak = Number.MAX_SAFE_INTEGER;
    if (amounts.total != null && unitPrice > 0) {
      const inferredUnits = Math.max(1, Math.round(amounts.total / unitPrice));
      const merchandiseEstimate = unitPrice * inferredUnits;
      totalTieBreak = Math.abs(amounts.total - merchandiseEstimate);
    }
    return { order, timeDiff: Math.abs(eventMs - createdMs), totalTieBreak };
  }).sort((a, b) => (a.timeDiff - b.timeDiff) || (a.totalTieBreak - b.totalTieBreak) || String(a.order.id).localeCompare(String(b.order.id)));

  return candidates[0] ? { serviceOrder: candidates[0].order, emailQuantity } : null;
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

function detectCarrierFromTracking(trackingNumber, hint = '') {
  const code = clean(trackingNumber).replace(/\s+/g, '').toUpperCase();
  const h = lower(hint);
  if (/fedex/.test(h)) return 'fedex';
  if (/\bups\b/.test(h)) return 'ups';
  if (/usps|postal service/.test(h)) return 'usps';
  if (/^1Z[0-9A-Z]{16}$/.test(code)) return 'ups';
  if (/^(94|93|92|95)\d{18,20}$/.test(code) || /^\d{20,22}$/.test(code)) return 'usps';
  if (/^\d{12}$/.test(code) || /^\d{15}$/.test(code) || /^\d{20}$/.test(code)) return 'fedex';
  return '';
}

function carrierTrackingUrl(carrier, trackingNumber) {
  const code = encodeURIComponent(clean(trackingNumber));
  if (!code) return '';
  if (carrier === 'ups') return `https://www.ups.com/track?tracknum=${code}`;
  if (carrier === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${code}`;
  if (carrier === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${code}`;
  return '';
}

async function checkEasyPostDelivered(supabase, userId = null) {
  const key = clean(process.env.EASYPOST_API_KEY);
  if (!key) return { checked: 0, delivered_shipments: 0, delivered_orders: 0, disabled: true };
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

  let q = supabase.from('tracked_orders')
    .select('id,user_id,tracking_number,carrier,status')
    .eq('status','shipped')
    .limit(200);
  if (userId) q = q.eq('user_id', userId);
  const { data: orders, error } = await q;
  if (error) throw error;
  if (!(orders || []).length) return { checked:0, delivered_shipments:0, delivered_orders:0, disabled:false };

  const orderIds=(orders||[]).map(o=>o.id).filter(Boolean);
  const shipmentsByOrder=new Map(orderIds.map(id=>[String(id),[]]));
  try {
    for(let i=0;i<orderIds.length;i+=100){
      const r=await supabase.from('tracked_order_shipments')
        .select('id,order_id,tracking_number,carrier,status,delivered_at')
        .in('order_id',orderIds.slice(i,i+100));
      if(r.error) throw r.error;
      for(const row of r.data||[]) (shipmentsByOrder.get(String(row.order_id))||[]).push(row);
    }
  } catch (err) {
    console.warn('[TRACKING] Shipment row lookup failed; falling back to order-level tracking:', err.message || err);
  }

  let checked = 0, deliveredShipments = 0, deliveredOrders = 0;

  async function lookupTracker(code, carrierHint='') {
    let tracker = null;
    const lookup = await fetch(`https://api.easypost.com/v2/trackers?tracking_code=${encodeURIComponent(code)}`, { headers: { Authorization: auth } });
    if (lookup.ok) {
      const payload = await lookup.json().catch(()=>({}));
      tracker = (payload.trackers || []).find(t => clean(t.tracking_code).toUpperCase() === code.toUpperCase()) || null;
    }
    if (!tracker) {
      const body = new URLSearchParams();
      body.set('tracker[tracking_code]', code);
      if (carrierHint) body.set('tracker[carrier]', carrierHint);
      const created = await fetch('https://api.easypost.com/v2/trackers', { method:'POST', headers:{ Authorization:auth, 'content-type':'application/x-www-form-urlencoded' }, body });
      if (created.ok) tracker = await created.json().catch(()=>null);
    }
    return tracker;
  }

  for (const order of orders || []) {
    const shipmentRows = shipmentsByOrder.get(String(order.id)) || [];
    const candidates = shipmentRows.length
      ? shipmentRows.filter(s => clean(s.tracking_number)).map(s => ({ shipment:s, code:clean(s.tracking_number), carrier:clean(s.carrier || detectCarrierFromTracking(s.tracking_number || '')) }))
      : (clean(order.tracking_number) ? [{ shipment:null, code:clean(order.tracking_number), carrier:clean(order.carrier || detectCarrierFromTracking(order.tracking_number || '')) }] : []);
    if (!candidates.length) continue;

    for (const item of candidates) {
      // Already-delivered package rows do not need another paid API lookup.
      if (item.shipment && lower(item.shipment.status) === 'delivered') continue;
      try {
        const tracker = await lookupTracker(item.code, item.carrier);
        checked++;
        if (!tracker) continue;
        const trackerStatus=lower(tracker.status);
        const carrier=lower(tracker.carrier || item.carrier || order.carrier) || null;
        if (item.shipment) {
          const patch={ updated_at:new Date().toISOString() };
          if(carrier) patch.carrier=carrier;
          if(trackerStatus) patch.status=trackerStatus;
          if(trackerStatus==='delivered') patch.delivered_at=tracker.est_delivery_date || tracker.updated_at || new Date().toISOString();
          await supabase.from('tracked_order_shipments').update(patch).eq('id',item.shipment.id);
          if(trackerStatus==='delivered') deliveredShipments++;
        } else if (carrier && !order.carrier) {
          await supabase.from('tracked_orders').update({carrier,updated_at:new Date().toISOString()}).eq('id',order.id);
        }
      } catch (err) {
        console.warn(`[TRACKING] ${item.code}: ${err.message || err}`);
      }
    }

    // Re-read package statuses after this order's checks. For split Supreme shipments, the order
    // becomes delivered only after every known package has been delivered.
    let allDelivered=false;
    if (shipmentRows.length) {
      const r=await supabase.from('tracked_order_shipments').select('status').eq('order_id',order.id);
      if(!r.error && (r.data||[]).length) allDelivered=(r.data||[]).every(x=>lower(x.status)==='delivered');
    } else {
      try {
        const tracker=await lookupTracker(clean(order.tracking_number), clean(order.carrier || detectCarrierFromTracking(order.tracking_number || '')));
        checked++;
        allDelivered=lower(tracker?.status)==='delivered';
      } catch(_) {}
    }
    if(allDelivered){
      const now=new Date().toISOString();
      const upd=await supabase.from('tracked_orders').update({status:'delivered',last_status_at:now,updated_at:now}).eq('id',order.id).eq('status','shipped').select('id');
      if(!upd.error && (upd.data||[]).length) deliveredOrders++;
    }
  }
  if (checked) console.log(`[TRACKING] EasyPost checked ${checked} package lookup(s); ${deliveredShipments} shipment(s) and ${deliveredOrders} order(s) marked delivered.`);
  return { checked, delivered_shipments:deliveredShipments, delivered_orders:deliveredOrders, disabled:false };
}

function extractProductSummary(subject, text, store) {
  const lines = text.split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const ignore = /^(order|subtotal|tax|shipping|total|payment|delivery|track|hello|hi |thank|view order|manage order|quantity|qty|price)/i;
  const candidates = lines.filter(x => x.length >= 8 && x.length <= 180 && !ignore.test(x) && !/https?:\/\//i.test(x));
  return candidates.slice(0, 5).join(' • ') || `${store} order ${subject}`.slice(0, 500);
}

function statusRank(s) {
  return ({unknown:0,waiting_confirmation:0.5,confirmed:1,processing:2,shipped:3,delivered:4,canceled:5,refunded:6})[s] || 0;
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
  const direct = [
    order.metadata?.purchase_id, order.metadata?.purchaseId,
    order.metadata?.order_number, order.metadata?.order_id,
    order.raw_payload?.purchase_id, order.raw_payload?.purchaseId, order.raw_payload?.purchaseID,
    order.raw_payload?.order_number, order.raw_payload?.order_id,
    order.external_order_id
  ].map(clean).find(v => normalizeOrderRef(v).length >= 6);
  if (direct) return direct;
  const refs = collectOrderRefs(order);
  return refs[0] || clean(order.external_order_id || order.id);
}

async function loadServiceOrders(supabase, userId) {
  const { data, error } = await supabase.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(2000);
  if (error) throw error;
  return data || [];
}


function normalizeStoreKey(value) {
  const raw = lower(value);
  const compact = raw.replace(/[^a-z0-9]/g, '');
  // Webhook `Site` values are not consistent: Stellar Supreme uses `us.supreme.com`
  // while our service/tracker rows use `supreme`. Canonicalize known retailer domains
  // before any exact store comparison so reconciliation does not incorrectly conclude
  // that there are zero Supreme webhook orders.
  if (compact.includes('supreme')) return 'supreme';
  if (compact.includes('target')) return 'target';
  if (compact.includes('amazon')) return 'amazon';
  if (compact.includes('pokemoncenter')) return 'pokemoncenter';
  if (compact.includes('walmart')) return 'walmart';
  if (compact.includes('samsclub') || compact === 'sams') return 'samsclub';
  return compact;
}

function normalizePayloadKey(value) {
  return lower(value).replace(/[^a-z0-9]/g, '');
}

function unwrapDiscordValue(value) {
  return clean(value).replace(/^\|\|/, '').replace(/\|\|$/, '').trim();
}

function extractNamedPayloadValue(payload, names = []) {
  const wanted = new Set(names.map(normalizePayloadKey));
  const found = [];
  const visit = (value, key = '', depth = 0) => {
    if (depth > 10 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const fieldName = normalizePayloadKey(value.name || '');
      if (fieldName && wanted.has(fieldName) && value.value != null) {
        const candidate = unwrapDiscordValue(value.value);
        if (candidate) found.push(candidate);
      }
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, depth + 1);
      return;
    }
    if (wanted.has(normalizePayloadKey(key))) {
      const candidate = unwrapDiscordValue(value);
      if (candidate) found.push(candidate);
    }
  };
  visit(payload);
  return found.find(Boolean) || '';
}

function serviceOrderProfileName(source = {}) {
  return clean(
    source.metadata?.profile_name || source.metadata?.profile ||
    extractNamedPayloadValue(source.raw_payload || {}, ['profile_name','profileName','profile'])
  );
}

async function buildProfileMailboxIndex(supabase, userId = null) {
  let pq = supabase.from('profiles').select('id,user_id,profile_name,account_type');
  if (userId) pq = pq.eq('user_id', userId);
  const { data: profiles, error } = await pq;
  if (error) throw error;
  const list = profiles || [];
  const ids = list.map(p => p.id).filter(Boolean);
  const credentials = new Map();
  const addCredential = (row = {}, storeValue = '') => {
    const profileId = String(row.profile_id || '');
    const email = lower(row.login_email);
    if (!profileId || !email || !email.includes('@')) return;
    const current = credentials.get(profileId) || [];
    current.push({ email, store: normalizeStoreKey(storeValue) });
    credentials.set(profileId, current);
  };
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    try {
      const r = await supabase.from('profile_store_credentials').select('profile_id,store,login_email').in('profile_id', chunk);
      if (!r.error) for (const row of r.data || []) addCredential(row, row.store);
    } catch (_) {}
    try {
      const r = await supabase.from('accounts').select('profile_id,provider,login_email').in('profile_id', chunk);
      if (!r.error) for (const row of r.data || []) addCredential(row, row.provider);
    } catch (_) {}
  }
  return { profiles: list, credentials };
}

function resolveExactProfileMailbox(source = {}, index = {}) {
  const profileName = serviceOrderProfileName(source);
  if (!profileName) return null;
  const userId = String(source.user_id || '');
  const store = normalizeStoreKey(source.site || source.metadata?.site || extractNamedPayloadValue(source.raw_payload || {}, ['site','store']));
  let matches = (index.profiles || []).filter(p =>
    String(p.user_id || '') === userId && lower(p.profile_name) === lower(profileName)
  );
  if (!matches.length) return null;
  if (store) {
    const byStore = matches.filter(p => normalizeStoreKey(p.account_type) === store ||
      (index.credentials.get(String(p.id)) || []).some(c => !c.store || c.store === store));
    if (byStore.length) matches = byStore;
  }
  const candidates = [];
  for (const profile of matches) {
    let creds = index.credentials.get(String(profile.id)) || [];
    if (store) {
      const storeCreds = creds.filter(c => !c.store || c.store === store);
      if (storeCreds.length) creds = storeCreds;
    }
    for (const cred of creds) candidates.push({ profile_id: profile.id, email: cred.email, profile_name: profile.profile_name });
  }
  const uniqueEmails = [...new Set(candidates.map(c => c.email).filter(Boolean))];
  if (uniqueEmails.length !== 1) return null;
  const exact = candidates.find(c => c.email === uniqueEmails[0]);
  return exact || null;
}

async function removeMismatchedOrderEmailLinks(supabase, trackedOrderId, authoritativeEmail) {
  const orderId = clean(trackedOrderId);
  const email = lower(authoritativeEmail);
  if (!orderId || !email) return 0;
  let removed = 0;
  try {
    const links = await supabase.from('tracked_order_emails').select('id,email_id').eq('order_id', orderId);
    if (!links.error && links.data?.length) {
      const emailIds = links.data.map(r => r.email_id).filter(Boolean);
      if (emailIds.length) {
        const messages = await supabase.from('email_messages').select('id,mailbox_email').in('id', emailIds);
        if (!messages.error) {
          const mailboxById = new Map((messages.data || []).map(m => [String(m.id), lower(m.mailbox_email)]));
          const badIds = links.data.filter(link => mailboxById.get(String(link.email_id)) && mailboxById.get(String(link.email_id)) !== email).map(link => link.id);
          if (badIds.length) {
            const del = await supabase.from('tracked_order_emails').delete().in('id', badIds);
            if (!del.error) removed += badIds.length;
          }
        }
      }
    }
  } catch (_) {}
  try {
    const legacy = await supabase.from('email_messages').select('id,mailbox_email').eq('linked_order_id', orderId);
    if (!legacy.error) {
      const bad = (legacy.data || []).filter(m => lower(m.mailbox_email) && lower(m.mailbox_email) !== email).map(m => m.id);
      if (bad.length) {
        const upd = await supabase.from('email_messages').update({ linked_order_id: null, updated_at: new Date().toISOString() }).in('id', bad);
        if (!upd.error) removed += bad.length;
      }
    }
  } catch (_) {}
  // Remove status events that came from a different mailbox too. Otherwise an old
  // wrong-mailbox confirmation can keep an order blue/green even after its email link
  // has been detached from the corrected profile.
  try {
    const events = await supabase.from('tracked_order_events').select('id,source_email').eq('order_id', orderId);
    if (!events.error) {
      const badEventIds = (events.data || []).filter(e => lower(e.source_email) && lower(e.source_email) !== email).map(e => e.id);
      if (badEventIds.length) {
        const del = await supabase.from('tracked_order_events').delete().in('id', badEventIds);
        if (!del.error) removed += badEventIds.length;
      }
    }
  } catch (_) {}
  return removed;
}

function trackedOrderActualCost(tracked = {}, serviceOrder = {}) {
  // Investment Value should represent what the retailer actually charged, not the
  // bot/webhook item-price estimate. Once a retailer confirmation is linked, the
  // tracked order contains the receipt total (merchandise + tax + shipping/fees).
  const receiptTotal = Number(tracked.total);
  if (Number.isFinite(receiptTotal) && receiptTotal > 0) return Math.round(receiptTotal * 100) / 100;

  // Some retailers expose the components without a labeled grand total. In that
  // case reconstruct the actual charge from the receipt components.
  const parts = [tracked.subtotal, tracked.tax, tracked.shipping]
    .map(Number)
    .filter(Number.isFinite);
  if (parts.length && parts.some(v => v > 0)) {
    return Math.round(parts.reduce((sum, value) => sum + value, 0) * 100) / 100;
  }

  // Before a retailer email is available keep the existing webhook fallback. This
  // value is automatically replaced as soon as a confirmed receipt is processed.
  const fallback = Number(serviceOrder.metadata?.purchase_price || serviceOrder.raw_payload?.price || 0);
  return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback * 100) / 100 : 0;
}

async function ensureInvestmentRow(supabase, tracked, serviceOrder, active = true) {
  const { data: existing } = await supabase.from('investment_products').select('id').eq('user_id', tracked.user_id).eq('source_order_id', serviceOrder.id).maybeSingle();
  const payload = {
    user_id: tracked.user_id, order_id: tracked.id, source_order_id: serviceOrder.id,
    store: tracked.store, order_number: tracked.order_number,
    product_name: clean(serviceOrder.product_name || tracked.product_summary || 'Tracked product').slice(0, 500),
    sku: clean(serviceOrder.sku), quantity: Number(serviceOrder.metadata?.quantity || serviceOrder.raw_payload?.quantity || 1) || 1,
    // purchase_price is intentionally the TOTAL retailer spend for this tracked
    // order. The Investment page already sums this field once per order row.
    purchase_price: trackedOrderActualCost(tracked, serviceOrder),
    credits_value: Number(serviceOrder.credits_charged || 0) || 0,
    is_active: active, canceled_at: active ? null : new Date().toISOString(), updated_at: new Date().toISOString()
  };
  if (existing?.id) await supabase.from('investment_products').update(payload).eq('id', existing.id);
  else await supabase.from('investment_products').insert(payload);
}

async function syncServiceOrders(supabase, userId, accounts = []) {
  const serviceOrders = await loadServiceOrders(supabase, userId);
  const profileMailboxIndex = await buildProfileMailboxIndex(supabase, userId);
  const defaultEmail = accounts[0]?.email || 'waiting-for-imap@local';
  for (const source of serviceOrders) {
    const store = lower(source.site || source.metadata?.site || source.raw_payload?.site || 'unknown').replace(/[^a-z0-9]/g, '');
    const orderNumber = serviceOrderNumber(source);
    if (!orderNumber) continue;
    const { data: prior } = await supabase.from('tracked_orders').select('*').eq('source_order_id', source.id).maybeSingle();
    const sourceEmails = findEmailValues(source.raw_payload || {});
    const metadataEmail = lower(
      source.metadata?.checkout_account_email ||
      source.metadata?.account_email ||
      source.metadata?.purchase_email ||
      source.metadata?.login_email ||
      source.metadata?.email ||
      source.email || ''
    );
    // Historical webhook payloads can contain several addresses (website user, bot
    // account, notification address). Prefer the address that is actually one of
    // this user's configured retailer mailboxes. This repairs old rows that were
    // previously labeled waiting-for-imap@local.
    const exactProfileIdentity = resolveExactProfileMailbox(source, profileMailboxIndex);
    const matchingAccount = accounts.find(account => sourceEmails.has(lower(account.email)))
      || accounts.find(account => lower(account.email) === metadataEmail);
    const orderEmail = lower(exactProfileIdentity?.email || matchingAccount?.email || metadataEmail || [...sourceEmails][0] || '');
    const priorEmail = lower(prior?.source_email || '');
    const priorIsPlaceholder = !priorEmail || priorEmail === 'waiting-for-imap@local';
    // An exact profile-name match inside THIS website user is authoritative for legacy
    // Astral/bot webhooks that did not include the account email. This is what separates
    // profiles such as "Carnival" and "red card 8032 stickydelivery" even when the old
    // checkout webhook only stored the profile name.
    const retailerReconciled = ['matched','probable'].includes(lower(prior?.reconciliation_status));
    const resolvedEmail = lower(retailerReconciled && !priorIsPlaceholder ? priorEmail : (exactProfileIdentity?.email || orderEmail || (priorIsPlaceholder ? defaultEmail : priorEmail)));
    const payload = {
      user_id: userId, source_order_id: source.id, service_order_external_id: source.external_order_id || null,
      profile_id: exactProfileIdentity?.profile_id || matchingAccount?.profile_id || prior?.profile_id || accounts[0]?.profile_id || null,
      source_email: resolvedEmail,
      store, order_number: prior?.order_number || orderNumber,
      status: prior?.status || (['confirmed','processing','shipped','delivered','canceled','refunded'].includes(lower(source.status)) ? lower(source.status) : 'waiting_confirmation'),
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
          const linked=await supabase.from('tracked_orders').update({ source_order_id: source.id, service_order_external_id: source.external_order_id || null, source_email: resolvedEmail, profile_id: matchingAccount?.profile_id || tracked.profile_id || null }).eq('id', tracked.id).select().single();
          tracked=linked.data || tracked;
        }
      }
    }
    if (tracked && exactProfileIdentity?.email && !['supreme'].includes(store) && !['matched','probable'].includes(lower(tracked.reconciliation_status))) {
      await removeMismatchedOrderEmailLinks(supabase, tracked.id, exactProfileIdentity.email);
    }
    if (tracked && ['confirmed','processing','shipped','delivered'].includes(lower(tracked.status))) {
      await ensureInvestmentRow(supabase, tracked, source, true);
    } else if (tracked && ['canceled','refunded'].includes(lower(tracked.status))) {
      const { data: investment } = await supabase.from('investment_products').select('id').eq('user_id', tracked.user_id).eq('source_order_id', source.id).maybeSingle();
      if (investment?.id) await ensureInvestmentRow(supabase, tracked, source, false);
    }
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
    if (!byKey.has(key)) byKey.set(key, { user_id: p.user_id, profile_id: p.id, email, password: pass, provider, ingestion_source: 'profile_builder_direct_imap' });
  };

  // Current multi-store credential table. Older deployments may not have this migration installed yet.
  try {
    // Large users can own hundreds of profiles. Chunk `in` filters to avoid PostgREST
    // returning 400 Bad Request when the generated query URL is too large.
    for (let i = 0; i < ids.length; i += 75) {
      const { data: creds, error: ce } = await supabase
        .from('profile_store_credentials')
        .select('*')
        .in('profile_id', ids.slice(i, i + 75));
      if (ce) throw ce;
      for (const c of creds || []) addCredential(c);
    }
  } catch (err) {
    console.warn('IMAP credential table unavailable; checking legacy accounts table:', err.message);
  }

  // Legacy/fallback account row used by the profile editor. This also covers profiles saved before
  // profile_store_credentials was installed or when that migration silently failed.
  try {
    for (let i = 0; i < ids.length; i += 75) {
      const { data: accounts, error: ae } = await supabase
        .from('accounts')
        .select('profile_id,login_email,gmail_app_password')
        .in('profile_id', ids.slice(i, i + 75));
      if (ae) throw ae;
      for (const account of accounts || []) addCredential(account);
    }
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

  const imported = await loadImportedScanAccounts(supabase, onlyUserId);
  for (const account of imported) {
    const key = `${account.user_id}:${account.email}`;
    if (!byKey.has(key)) byKey.set(key, account);
  }
  return [...byKey.values()];
}

async function upsertScanState(supabase, account, patch) {
  const stateUserId = account.archive_user_id || account.user_id;
  await supabase.from('imap_scan_accounts').upsert({
    user_id: stateUserId, profile_id: account.profile_id, email: account.email,
    provider: account.provider.name, updated_at: new Date().toISOString(), ...patch
  }, { onConflict: 'user_id,email' });
  if (account.imported_account_id) {
    const importedPatch = { updated_at: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(patch, 'last_scan_at')) importedPatch.last_scan_at = patch.last_scan_at;
    if (Object.prototype.hasOwnProperty.call(patch, 'last_success_at')) importedPatch.last_success_at = patch.last_success_at;
    if (Object.prototype.hasOwnProperty.call(patch, 'last_seen_uid')) importedPatch.last_seen_uid = patch.last_seen_uid;
    if (Object.prototype.hasOwnProperty.call(patch, 'last_error')) importedPatch.last_error = patch.last_error;
    importedPatch.status = patch.last_error ? 'error' : (patch.last_success_at ? 'connected' : 'ready');
    try { await supabase.from('imported_mail_accounts').update(importedPatch).eq('id', account.imported_account_id); } catch (_) {}
  }
}


async function archiveEmailMetadata(supabase, account, parsed, uid, classification = {}) {
  const subject = clean(parsed.subject);
  const fromText = clean(parsed.from?.text || parsed.from || '');
  const toText = clean(parsed.to?.text || parsed.to || '');
  const ccText = clean(parsed.cc?.text || parsed.cc || '');
  const bodyText = readableEmailText(parsed);
  const store = classification.store || detectStore(fromText, subject, bodyText) || 'unknown';
  const emailType = classification.status || detectStatus(subject, bodyText) || 'unknown';
  const orderNumber = classification.orderNumber || (store !== 'unknown' ? extractOrderNumber(store, subject, bodyText) : '') || null;
  const messageId = clean(parsed.messageId) || `${account.email}:${uid}`;
  const receivedAt = (parsed.date || new Date()).toISOString();
  const keepForever = ['confirmed','processing','shipped','delivered','canceled','refunded'].includes(emailType);
  const row = {
    user_id: account.archive_user_id || account.user_id, message_id: messageId, imap_uid: Number(uid || 0) || null,
    mailbox_email: lower(account.email), from_text: fromText.slice(0,1000), to_text: toText.slice(0,2000), cc_text: ccText.slice(0,2000),
    subject: subject.slice(0,1000), received_at: receivedAt, store, email_type: emailType, order_number: orderNumber,
    source_type: account.ingestion_source || (String(account.provider?.name || '').startsWith('aycd') ? 'aycd' : 'direct_imap'),
    snippet: bodyText.replace(/\s+/g,' ').slice(0,600), keep_forever: keepForever, is_order_related: keepForever,
    body_text: bodyText.slice(0,250000),
    body_html: parsed.html ? sanitizeReceiptHtml(String(parsed.html).slice(0,250000)) : null,
    has_attachments: Array.isArray(parsed.attachments) && parsed.attachments.length > 0, attachment_count: Array.isArray(parsed.attachments) ? parsed.attachments.length : 0,
    updated_at: new Date().toISOString()
  };
  let { data, error } = await supabase.from('email_messages').upsert(row, { onConflict:'user_id,message_id' }).select().single();
  if (error && /body_text|body_html|column .* does not exist|schema cache/i.test(String(error.message || ''))) {
    const legacyRow = { ...row };
    delete legacyRow.body_text;
    delete legacyRow.body_html;
    ({ data, error } = await supabase.from('email_messages').upsert(legacyRow, { onConflict:'user_id,message_id' }).select().single());
  }
  if (error) {
    // Keep order scanning operational before the optional Email Center migration is installed.
    if (!/email_messages|relation .* does not exist|schema cache/i.test(String(error.message||''))) throw error;
    return null;
  }
  // Older AYCD imports sometimes stored only Target's invisible preheader while a later OAuth/IMAP
  // fetch has the complete RFC822 message. If the fresh copy is readable, repair any legacy copy
  // of the same Target event as well. This keeps existing tracked_order_emails links and the
  // "View all order emails" screen from continuing to show the stale &#8199;/&#847; body.
  try { await backfillDamagedTargetArchiveCopies(supabase, account, data, row); } catch (_) {}
  return data;
}
async function linkOrderEmail(supabase, orderId, emailId, status, eventAt) {
  if (!orderId || !emailId) return;
  try {
    await supabase.from('tracked_order_emails').upsert({
      order_id: orderId,
      email_id: emailId,
      event_type: status || 'unknown',
      event_at: eventAt || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict:'order_id,email_id' });
  } catch (_) {
    // Optional migration. The legacy linked_order_id continues to work until installed.
  }
}


async function reconcileTrackedOrderItems(supabase, trackedOrder, serviceOrder, retail, status, eventAt, emailId) {
  if (!trackedOrder?.id || !['target','supreme'].includes(lower(trackedOrder.store))) return null;
  const expected = expectedWebhookItems(serviceOrder);
  const parsedItems = Array.isArray(retail?.items) ? retail.items : [];
  let existing = [];
  try {
    const r = await supabase.from('tracked_order_items').select('*').eq('order_id', trackedOrder.id).order('created_at');
    if (r.error) throw r.error;
    existing = r.data || [];
  } catch (error) {
    if (/tracked_order_items|relation .* does not exist|schema cache/i.test(String(error.message || ''))) return null;
    throw error;
  }

  // Target uses item-level cancellations for the shipping-threshold filler, but it also sends
  // a separate full-order cancellation when the entire checkout is killed. A full-order email
  // often has no item rows, so apply it to every known line item explicitly.
  if (lower(trackedOrder.store) === 'target' && status === 'canceled' && retail?.cancellation_scope === 'full_order' && existing.length) {
    const eventMs = new Date(eventAt || 0).getTime();
    for (const old of [...existing]) {
      const oldMs = new Date(old.last_event_at || 0).getTime();
      if (Number.isFinite(eventMs) && Number.isFinite(oldMs) && oldMs > eventMs) continue;
      const r = await supabase.from('tracked_order_items').update({
        status: 'canceled', last_event_at: eventAt, last_email_id: emailId || null,
        updated_at: new Date().toISOString()
      }).eq('id', old.id).select().single();
      if (r.error) throw r.error;
      existing = existing.map(x => x.id === old.id ? r.data : x);
    }
  }

  const matchedIds = [];
  for (const item of parsedItems) {
    let best = null, bestScore = 0;
    for (const old of existing) {
      const score = Math.max(
        mainItemMatch([{ product_name: old.product_name, sku: old.sku }], item) ? 1 : 0,
        reconcileNorm(old.product_name) === reconcileNorm(item.product_name) ? 1 : 0
      );
      const sizeCompatible = !old.size || !item.size || reconcileNorm(old.size) === reconcileNorm(item.size);
      if (score > bestScore && sizeCompatible) { best = old; bestScore = score; }
    }
    const isMain = expected.some(e => mainItemMatch([e], item) && (!e.size || !item.size || reconcileNorm(e.size) === reconcileNorm(item.size)));
    const role = isMain ? 'main' : (lower(trackedOrder.store) === 'target' ? 'filler' : 'normal');
    const itemStatus = lower(item.status || status || 'confirmed');
    const payload = {
      retailer_order_number: trackedOrder.order_number,
      product_name: clean(item.product_name).slice(0,500),
      sku: clean(item.sku) || best?.sku || null,
      size: clean(item.size) || best?.size || null,
      style: clean(item.style) || best?.style || null,
      quantity: Math.max(1, Number(item.quantity || best?.quantity || 1)),
      price: item.price == null ? (best?.price ?? null) : Number(item.price),
      role: best?.role === 'main' ? 'main' : role,
      status: itemStatus === 'pending' ? 'confirmed' : itemStatus,
      last_event_at: eventAt,
      last_email_id: emailId || null,
      updated_at: new Date().toISOString()
    };
    let saved;
    if (best?.id) {
      const r = await supabase.from('tracked_order_items').update(payload).eq('id', best.id).select().single();
      if (r.error) throw r.error; saved = r.data;
      existing = existing.map(x => x.id === best.id ? saved : x);
    } else {
      const r = await supabase.from('tracked_order_items').insert({ order_id: trackedOrder.id, ...payload }).select().single();
      if (r.error) throw r.error; saved = r.data; existing.push(saved);
    }
    if (saved?.id) matchedIds.push(saved.id);
  }

  // A Target confirmation containing only the filler is the critical ghost-success case.
  // Create an explicit missing main-item row so an unrelated filler cancellation cannot be
  // interpreted as a successful checkout or as a cancellation of the desired product.
  if (status === 'confirmed' && expected.length) {
    for (const e of expected) {
      const hasMain = existing.some(i => i.role === 'main' && mainItemMatch([e], i));
      const emailContainsMain = parsedItems.some(i => mainItemMatch([e], i));
      if (!hasMain && !emailContainsMain) {
        const r = await supabase.from('tracked_order_items').insert({
          order_id: trackedOrder.id, retailer_order_number: trackedOrder.order_number,
          product_name: clean(e.product_name || e.sku || trackedOrder.product_summary || 'Expected item').slice(0,500),
          sku: clean(e.sku) || null, size: clean(e.size) || null, quantity: Math.max(1,Number(e.quantity||1)), price:e.price==null?null:Number(e.price),
          role:'main', status:'missing', last_event_at:eventAt, last_email_id:emailId||null, updated_at:new Date().toISOString()
        }).select().single();
        if (!r.error && r.data) existing.push(r.data);
      }
    }
  }

  // Shipping is many-to-many: one order can have several tracking numbers and one shipment
  // can contain only a subset of a multi-item Supreme order.
  const tracking = clean(retail?.tracking_number);
  if (tracking && ['shipped','delivered'].includes(status)) {
    const carrier = detectCarrierFromTracking(tracking, '');
    const shipPayload = {
      order_id: trackedOrder.id, retailer_order_number: trackedOrder.order_number,
      tracking_number: tracking, carrier: carrier || null, status,
      shipped_at: status === 'shipped' ? eventAt : undefined,
      delivered_at: status === 'delivered' ? eventAt : null,
      last_email_id: emailId || null, updated_at: new Date().toISOString()
    };
    if (shipPayload.shipped_at === undefined) delete shipPayload.shipped_at;
    let sr = await supabase.from('tracked_order_shipments').upsert(shipPayload,{onConflict:'order_id,tracking_number'}).select().single();
    if (sr.error) throw sr.error;
    for (const itemId of matchedIds) {
      await supabase.from('tracked_order_shipment_items').upsert({ shipment_id: sr.data.id, item_id: itemId, quantity:1 }, { onConflict:'shipment_id,item_id' });
    }
  } else if (status === 'delivered' && matchedIds.length) {
    // Target delivery mail may omit the tracking number. Mark the shipment(s) already linked
    // to the delivered item rather than inventing a new package.
    const links = await supabase.from('tracked_order_shipment_items').select('shipment_id').in('item_id', matchedIds);
    const shipmentIds = [...new Set((links.data||[]).map(x=>x.shipment_id).filter(Boolean))];
    if (shipmentIds.length) await supabase.from('tracked_order_shipments').update({status:'delivered',delivered_at:eventAt,updated_at:new Date().toISOString()}).in('id',shipmentIds);
  }

  const refreshed = await supabase.from('tracked_order_items').select('*').eq('order_id',trackedOrder.id).order('created_at');
  if (refreshed.error) throw refreshed.error;
  const overall = deriveOverallStatus(refreshed.data || []);
  const mainMissing = (refreshed.data || []).some(i => i.role === 'main' && i.status === 'missing');
  const note = mainMissing ? 'Main webhook item was not present in the retailer confirmation; filler-only order detected.' : null;
  await supabase.from('tracked_orders').update({
    status: overall,
    reconciliation_status: mainMissing ? 'main_item_missing' : 'matched',
    reconciliation_note: note,
    last_status_at: eventAt,
    updated_at: new Date().toISOString()
  }).eq('id',trackedOrder.id);
  return { items: refreshed.data || [], overall_status: overall, main_missing: mainMissing };
}

async function matchSupremeServiceOrder(supabase, account, serviceOrders, retail, eventAt, messageId) {
  const candidates = [];
  const trackedResult = await supabase.from('tracked_orders')
    .select('source_order_id,order_number,reconciliation_note,reconciliation_score')
    .eq('user_id', account.user_id).eq('store', 'supreme');
  const trackedBySource = new Map((trackedResult.data || []).map(row => [String(row.source_order_id || ''), row]));
  const incomingRef = normalizeOrderRef(retail.order_number);

  for (const order of serviceOrders) {
    const site = normalizeStoreKey(order.site || order.metadata?.site || extractNamedPayloadValue(order.raw_payload || {}, ['site','store']));
    if (site !== 'supreme') continue;
    const tracked = trackedBySource.get(String(order.id)) || null;
    const trackedRef = normalizeOrderRef(tracked?.order_number);

    // During the new batch matcher, a row already claimed by a different retailer order is
    // locked so a later near-identical confirmation cannot steal it. Legacy assignments do not
    // have this marker and remain eligible to be repaired.
    if (tracked?.reconciliation_note === 'supreme_batch_v2' && trackedRef && incomingRef && trackedRef !== incomingRef) continue;

    let score = matchScore(order, retail, eventAt, account.email);
    if (trackedRef && incomingRef && trackedRef === incomingRef) score += 25;
    const sourceRefs = collectOrderRefs(order);
    if (incomingRef && sourceRefs.includes(incomingRef)) score += 25;
    if (score >= 55) candidates.push({ order, score });
  }
  candidates.sort((a,b) => b.score-a.score || Math.abs(new Date(a.order.created_at)-new Date(eventAt))-Math.abs(new Date(b.order.created_at)-new Date(eventAt)) || String(a.order.id).localeCompare(String(b.order.id)));
  return candidates[0] || null;
}

function archivedRetailerReadableText(email = {}) {
  const plain = clean(email.body_text || '');
  // Some older archive rows contain only a tiny preheader/plain-text fragment while the complete
  // Supreme receipt survived in body_html. Prefer the richer representation for reconciliation.
  if (plain.length >= 180 && /Order\s+\d{6,20}|successfully submitted|Price:/i.test(plain)) return plain;
  let html = String(email.body_html || '');
  if (html) {
    html = html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>|<\/div\s*>|<\/tr\s*>|<\/li\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;|&#8199;|&#847;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/=3D/gi, '=')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }
  if (html.length > plain.length) return html;
  return plain || clean(email.snippet || '');
}

async function rebuildSupremeBatchAssignments(supabase, userId, retailerEmails = []) {
  const confirmationEmails = [];
  let supremeArchiveSeen = 0, supremeConfirmedSeen = 0, supremeParsedOrders = 0, supremeParsedItems = 0;
  for (const email of retailerEmails || []) {
    const text = archivedRetailerReadableText(email);
    const store = lower(email.store) === 'supreme' ? 'supreme' : detectStore(email.from_text || '', email.subject || '', text);
    if (store !== 'supreme') continue;
    supremeArchiveSeen++;
    const status = detectStatus(email.subject || '', text);
    if (status !== 'confirmed') continue;
    supremeConfirmedSeen++;
    const retail = parseRetailEmail('supreme', 'confirmed', email.subject || '', text);
    if (!retail.order_number) continue;
    supremeParsedOrders++;
    supremeParsedItems += (retail.items || []).length;
    confirmationEmails.push({ email, retail, eventAt: new Date(email.received_at || Date.now()).toISOString() });
  }
  const allOrders = await loadServiceOrders(supabase, userId);
  const supremeOrders = allOrders.filter(order => normalizeStoreKey(order.site || order.metadata?.site || extractNamedPayloadValue(order.raw_payload || {}, ['site','store'])) === 'supreme');
  // Report the actual webhook/service-order count even when no Supreme email has been archived yet.
  // Previously this function returned before loading service orders, producing the misleading
  // `Supreme webhook orders: 0` while the diagnostic immediately below showed Supreme rows.
  if (!confirmationEmails.length) return { confirmations:0, assigned:0, skipped:0, supreme_archive_seen:supremeArchiveSeen, supreme_confirmed_seen:supremeConfirmedSeen, parsed_order_numbers:supremeParsedOrders, parsed_items:supremeParsedItems, supreme_webhook_orders:supremeOrders.length, candidate_pairs:0 };

  if (!supremeOrders.length) return { confirmations:confirmationEmails.length, assigned:0, skipped:confirmationEmails.length, supreme_archive_seen:supremeArchiveSeen, supreme_confirmed_seen:supremeConfirmedSeen, parsed_order_numbers:supremeParsedOrders, parsed_items:supremeParsedItems, supreme_webhook_orders:0 };

  // Global one-to-one assignment. Retailer-confirmation checkout time + exact item set carry most
  // of the score. Mailbox/profile identity is only a small hint because Supreme bot profile names
  // are not guaranteed to point at the actual purchase inbox.
  const pairs = [];
  for (const c of confirmationEmails) {
    const mailbox = lower(c.email.mailbox_email);
    for (const order of supremeOrders) {
      const score = matchScore(order, c.retail, c.eventAt, mailbox);
      // A readable item set remains the safest signal. For legacy Supreme archive rows whose
      // text conversion lost the line items, an exact retailer-vs-Stellar checkout minute is
      // still strong enough to enter the global one-to-one assignment pool.
      const hasItems = (c.retail.items || []).length > 0;
      const threshold = hasItems ? 55 : 40;
      if (score >= threshold) pairs.push({ c, order, score, hasItems });
    }
  }
  pairs.sort((a,b) => b.score-a.score
    || Math.abs(new Date(a.order.created_at)-new Date(a.c.eventAt))-Math.abs(new Date(b.order.created_at)-new Date(b.c.eventAt))
    || String(a.order.id).localeCompare(String(b.order.id)));

  const batchOrderIds = new Set(pairs.map(pair => String(pair.order.id)));
  const usedEmails = new Set(), usedOrders = new Set(), assignments = [];
  for (const pair of pairs) {
    const emailKey = String(pair.c.email.id || pair.c.email.message_id || pair.c.retail.order_number);
    const orderKey = String(pair.order.id);
    if (usedEmails.has(emailKey) || usedOrders.has(orderKey)) continue;
    usedEmails.add(emailKey); usedOrders.add(orderKey); assignments.push(pair);
  }

  if (!assignments.length) return { confirmations:confirmationEmails.length, assigned:0, skipped:confirmationEmails.length, supreme_archive_seen:supremeArchiveSeen, supreme_confirmed_seen:supremeConfirmedSeen, parsed_order_numbers:supremeParsedOrders, parsed_items:supremeParsedItems, supreme_webhook_orders:supremeOrders.length, candidate_pairs:pairs.length };

  const { data: allTrackedRows } = await supabase.from('tracked_orders').select('*').eq('user_id',userId).eq('store','supreme');
  const trackedRows = (allTrackedRows || []).filter(row => batchOrderIds.has(String(row.source_order_id || '')));
  const trackedBySource = new Map(trackedRows.map(row => [String(row.source_order_id || ''), row]));
  const trackedIds = trackedRows.map(row => row.id).filter(Boolean);

  // Manual Supreme reconciliation is a rebuild, not an incremental guess. Clear old Supreme
  // mail links and item/shipment projections, then replay every archived Supreme message in time
  // order after the confirmations have been assigned.
  if (trackedIds.length) {
    try {
      const shipmentRows = await supabase.from('tracked_order_shipments').select('id').in('order_id',trackedIds);
      const shipmentIds = (shipmentRows.data || []).map(x=>x.id).filter(Boolean);
      if (shipmentIds.length) await supabase.from('tracked_order_shipment_items').delete().in('shipment_id',shipmentIds);
      await supabase.from('tracked_order_shipments').delete().in('order_id',trackedIds);
    } catch (_) {}
    try { await supabase.from('tracked_order_items').delete().in('order_id',trackedIds); } catch (_) {}
    try { await supabase.from('tracked_order_emails').delete().in('order_id',trackedIds); } catch (_) {}
    try { await supabase.from('email_messages').update({linked_order_id:null,updated_at:new Date().toISOString()}).eq('user_id',userId).eq('store','supreme'); } catch (_) {}
  }

  // Move every Supreme tracked order to a temporary unique reference first so swapped legacy
  // assignments cannot hit the unique (user, store, order_number) constraint while being fixed.
  for (const row of trackedRows || []) {
    const tempRef = `supreme-rematch-${String(row.source_order_id || row.id).replace(/[^a-zA-Z0-9_-]/g,'').slice(-48)}`;
    await supabase.from('tracked_orders').update({
      order_number: tempRef, status:'waiting_confirmation', reconciliation_status:'pending', reconciliation_note:'supreme_batch_rebuild',
      tracking_number:null, carrier:null, last_message_id:null, updated_at:new Date().toISOString()
    }).eq('id',row.id);
  }

  for (const pair of assignments) {
    const tracked = trackedBySource.get(String(pair.order.id));
    if (!tracked?.id) continue;
    const ref = clean(pair.c.retail.order_number);
    const sourceMetadata = { ...(pair.order.metadata || {}), purchase_id:ref, order_number:ref, supreme_batch_match_version:2,
      supreme_retailer_checkout_at:pair.c.retail.retailer_checkout_at || null, supreme_confirmation_email_id:pair.c.email.id || null };
    await supabase.from('tracked_orders').update({
      order_number:ref, source_email:lower(pair.c.email.mailbox_email)||tracked.source_email,
      status:'confirmed', order_date:pair.c.retail.retailer_checkout_at || pair.c.eventAt,
      last_status_at:pair.c.eventAt, reconciliation_status:'matched', reconciliation_score:pair.score,
      reconciliation_note:'supreme_batch_v2', updated_at:new Date().toISOString()
    }).eq('id',tracked.id);
    await supabase.from('orders').update({ external_order_id:ref, status:'confirmed', metadata:sourceMetadata }).eq('id',pair.order.id);
  }

  // Unassigned Supreme checkouts retain their webhook identity instead of the temporary reference.
  for (const order of supremeOrders) {
    if (!batchOrderIds.has(String(order.id)) || usedOrders.has(String(order.id))) continue;
    const tracked = trackedBySource.get(String(order.id)); if (!tracked?.id) continue;
    const fallback = serviceOrderNumber({ ...order, external_order_id: null }) || clean(order.id);
    await supabase.from('tracked_orders').update({ order_number:fallback, reconciliation_note:null, updated_at:new Date().toISOString() }).eq('id',tracked.id);
  }

  return { confirmations:confirmationEmails.length, assigned:assignments.length, skipped:confirmationEmails.length-assignments.length, supreme_archive_seen:supremeArchiveSeen, supreme_confirmed_seen:supremeConfirmedSeen, parsed_order_numbers:supremeParsedOrders, parsed_items:supremeParsedItems, supreme_webhook_orders:supremeOrders.length, candidate_pairs:pairs.length,
    assignments:assignments.map(x=>({ order_number:x.c.retail.order_number, source_order_id:x.order.id, mailbox:lower(x.c.email.mailbox_email), score:x.score, parsed_items:(x.c.retail.items||[]).map(i=>({name:i.product_name,size:i.size,price:i.price})), retailer_checkout_at:x.c.retail.retailer_checkout_at||null, webhook_checkout_at:parseSupremeWebhookCheckoutAt(x.order)||null })) };
}

async function saveParsedMessage(supabase, account, parsed, uid, adjustCredits = null, confirmPendingAmazonCheckout = null) {
  const subject = clean(parsed.subject);
  const from = parsed.from?.text || '';
  const text = readableEmailText(parsed);
  const store = detectStore(from, subject, text);
  const status = detectStatus(subject, text);
  if (!store || status === 'unknown') {
    const archivedEmail = await archiveEmailMetadata(supabase, account, parsed, uid, { store: store || 'unknown', status });
    return { ignored: true, email_id: archivedEmail?.id || null };
  }

  const orderNumbers = extractOrderNumbers(store, subject, text);
  const primaryOrderNumber = orderNumbers[0] || '';
  const archivedEmail = await archiveEmailMetadata(supabase, account, parsed, uid, { store, status, orderNumber: primaryOrderNumber || null });
  if (!primaryOrderNumber) return { ignored: true, email_id: archivedEmail?.id || null };

  const messageId = clean(parsed.messageId) || `${account.email}:${uid}`;
  const eventAt = (parsed.date || new Date()).toISOString();
  const amounts = extractAmounts(text);
  const productSummary = extractProductSummary(subject, text, store);
  const retail = parseRetailEmail(store, status, subject, text);
  retail.order_number = retail.order_number || primaryOrderNumber;
  const bodyLinesForName = text.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  if (store === 'supreme') { const di = bodyLinesForName.findIndex(x=>/^Dear\b/i.test(x)); if (di>=0) retail.customer_name = bodyLinesForName.slice(di,di+3).join(' ').replace(/^Dear\s*/i,'').replace(/,$/,'').trim(); }
  const receiptHtml = parsed.html ? sanitizeReceiptHtml(String(parsed.html).slice(0, 250000)) : `<pre>${htmlEscape(text.slice(0, 250000))}</pre>`;
  const serviceOrders = await loadServiceOrders(supabase, account.user_id);

  // Amazon confirmation emails are intentionally one-to-one with bot checkout pings. A burst
  // of 15 possible successes plus 2 actual Amazon confirmation emails must confirm exactly 2
  // webhook orders, never all 15.
  let matchedServiceOrders = [];
  let amazonPendingMatch = null;
  if (store === 'amazon' && status === 'confirmed') {
    const direct = serviceOrders.find(o => collectOrderRefs(o).includes(normalizeOrderRef(primaryOrderNumber)));
    if (direct) matchedServiceOrders = [direct];
    else {
      amazonPendingMatch = await matchPendingAmazonOrder(supabase, account, parsed, primaryOrderNumber, amounts, messageId);
      if (amazonPendingMatch?.serviceOrder) matchedServiceOrders = [amazonPendingMatch.serviceOrder];
    }
  } else if (store === 'supreme') {
    // Confirmation emails are deliberately re-scored across the whole Supreme checkout batch.
    // Shipment emails then use the retailer order number learned from the confirmation.
    const direct = serviceOrders.find(o => collectOrderRefs(o).includes(normalizeOrderRef(primaryOrderNumber)));
    if (status === 'confirmed') {
      const winner = await matchSupremeServiceOrder(supabase, account, serviceOrders, retail, eventAt, messageId);
      if (winner?.order) matchedServiceOrders = [winner.order];
      else if (direct) matchedServiceOrders = [direct];
    } else if (direct) matchedServiceOrders = [direct];
  } else {
    const incomingRefs = new Set(orderNumbers.map(normalizeOrderRef).filter(Boolean));
    matchedServiceOrders = serviceOrders.filter(o => collectOrderRefs(o).some(ref => incomingRefs.has(ref)));
  }

  // Only track retailer emails that correspond to checkouts recorded by this platform.
  if (!matchedServiceOrders.length) return { ignored: true, reason: 'not_a_platform_order', email_id: archivedEmail?.id || null };

  const results = [];
  for (let index = 0; index < matchedServiceOrders.length; index++) {
    let serviceOrder = matchedServiceOrders[index];
    const serviceRefs = collectOrderRefs(serviceOrder);
    const matchedOrderNumber = orderNumbers.find(n => serviceRefs.includes(normalizeOrderRef(n))) || primaryOrderNumber;

    let { data: existing } = await supabase.from('tracked_orders').select('*').eq('source_order_id', serviceOrder.id).maybeSingle();
    if (!existing) {
      await syncServiceOrders(supabase, account.user_id, [account]);
      const lookup = await supabase.from('tracked_orders').select('*').eq('source_order_id', serviceOrder.id).maybeSingle();
      existing = lookup.data;
    }
    if (!existing) continue;

    // If a previous version misclassified this exact same message (for example the BAM order
    // confirmation that was marked delivered), allow the corrected classifier to replace it.
    const sameMessageReclassification = clean(existing.last_message_id) === messageId && existing.status !== status;
    const lateAmazonGhostConfirmation = store === 'amazon' && status === 'confirmed' && existing.status === 'canceled' && !!serviceOrder.metadata?.ghost_suspected_at;
    const shouldAdvance = sameMessageReclassification || lateAmazonGhostConfirmation || statusRank(status) >= statusRank(existing.status) || ['canceled','refunded'].includes(status);

    const preserveFinancials = store === 'amazon' && status !== 'confirmed';
    const patch = {
      user_id: account.user_id,
      source_order_id: serviceOrder.id,
      service_order_external_id: serviceOrder.external_order_id || null,
      profile_id: existing?.profile_id || account.profile_id,
      source_email: account.email,
      store,
      order_number: matchedOrderNumber,
      status: shouldAdvance ? status : existing.status,
      order_date: existing?.order_date || eventAt,
      last_status_at: shouldAdvance ? eventAt : existing.last_status_at,
      subtotal: preserveFinancials ? existing?.subtotal ?? null : (amounts.subtotal ?? existing?.subtotal ?? null),
      tax: preserveFinancials ? existing?.tax ?? null : (amounts.tax ?? existing?.tax ?? null),
      shipping: preserveFinancials ? existing?.shipping ?? null : (amounts.shipping ?? existing?.shipping ?? null),
      total: preserveFinancials ? existing?.total ?? null : (amounts.total ?? existing?.total ?? null),
      tracking_number: extractTracking(text) || existing?.tracking_number || null,
      carrier: detectCarrierFromTracking(extractTracking(text) || existing?.tracking_number || '', `${subject} ${text.slice(0,2000)}`) || existing?.carrier || null,
      product_summary: (status === 'confirmed' ? productSummary : existing?.product_summary || productSummary) || null,
      receipt_html: status === 'confirmed' || !existing?.receipt_html ? receiptHtml : existing.receipt_html,
      receipt_text: status === 'confirmed' || !existing?.receipt_text ? text.slice(0, 250000) : existing.receipt_text,
      raw_subject: subject,
      last_message_id: messageId,
      updated_at: new Date().toISOString()
    };
    const { data: order, error } = await supabase.from('tracked_orders').update(patch).eq('id', existing.id).select().single();
    if (error) throw error;
    if (store === 'supreme') {
      const score = matchScore(serviceOrder, retail, eventAt, account.email);
      await supabase.from('tracked_orders').update({ reconciliation_score: score, reconciliation_status: score >= 80 ? 'matched' : 'probable', reconciliation_note:'supreme_batch_v2', updated_at:new Date().toISOString() }).eq('id', order.id).then(()=>{}).catch(()=>{});
    }

    if (archivedEmail?.id) {
      // Keep the legacy single-link populated for older UI/code, and also record the new
      // many-to-many link so one Amazon shipment email can belong to several actual orders.
      if (!archivedEmail.linked_order_id) {
        await supabase.from('email_messages').update({ linked_order_id: order.id, is_order_related: true, keep_forever: true, updated_at: new Date().toISOString() }).eq('id', archivedEmail.id);
      } else {
        await supabase.from('email_messages').update({ is_order_related: true, keep_forever: true, updated_at: new Date().toISOString() }).eq('id', archivedEmail.id);
      }
      await linkOrderEmail(supabase, order.id, archivedEmail.id, status, eventAt);
    }

    let lineReconciliation = null;
    if (['target','supreme'].includes(store)) {
      try { lineReconciliation = await reconcileTrackedOrderItems(supabase, order, serviceOrder, retail, status, eventAt, archivedEmail?.id || null); }
      catch (reconcileError) { console.warn(`[ORDER-ITEMS] ${store} ${matchedOrderNumber}: ${reconcileError.message || reconcileError}`); }
    }

    if (index === 0) {
      await supabase.from('tracked_order_events').upsert({
        order_id: order.id, user_id: account.user_id, status, event_at: eventAt, subject,
        message_id: messageId, source_email: account.email, body_excerpt: text.slice(0, 1000)
      }, { onConflict: 'user_id,message_id', ignoreDuplicates: true });
    }

    const effectiveStatus = lineReconciliation?.overall_status || status;
    const sourceMetadata = {
      ...(serviceOrder.metadata || {}),
      purchase_id: serviceOrder.metadata?.purchase_id || matchedOrderNumber,
      order_number: matchedOrderNumber,
      confirmation_status: status,
      imap_status: effectiveStatus,
      item_level_reconciled_at: lineReconciliation ? eventAt : (serviceOrder.metadata?.item_level_reconciled_at || null),
      imap_last_message_at: eventAt,
      imap_last_message_id: messageId,
      ...(store === 'supreme' ? { supreme_batch_match_version: 2, supreme_retailer_checkout_at: retail.retailer_checkout_at || serviceOrder.metadata?.supreme_retailer_checkout_at || null } : {})
    };
    if (status === 'confirmed') sourceMetadata.confirmed_by_email_at = eventAt;

    const deferAmazonConfirmation = store === 'amazon' && status === 'confirmed' && amazonPendingMatch && serviceOrder.id === amazonPendingMatch.serviceOrder?.id && typeof confirmPendingAmazonCheckout === 'function';
    if (!deferAmazonConfirmation) {
      await supabase.from('orders').update({ status: effectiveStatus, external_order_id: matchedOrderNumber, metadata: sourceMetadata }).eq('id', serviceOrder.id);
    }
    if (deferAmazonConfirmation) {
      const confirmed = await confirmPendingAmazonCheckout({
        serviceOrder, amazonOrderNumber: matchedOrderNumber, messageId, eventAt,
        emailTotal: amounts.total, emailQuantity: amazonPendingMatch.emailQuantity
      });
      if (confirmed?.order) {
        serviceOrder = confirmed.order;
        await supabase.from('tracked_orders').update({ credits_spent: Number(confirmed.order.credits_charged || 0), updated_at: new Date().toISOString() }).eq('id', order.id);
      }
    }

    const inactive = ['canceled','refunded'].includes(effectiveStatus);
    await ensureInvestmentRow(supabase, order, serviceOrder, !inactive);
    if (inactive && !existing.credits_refunded && Number(serviceOrder.credits_charged || 0) > 0 && typeof adjustCredits === 'function') {
      const refund = Number(serviceOrder.credits_charged || 0);
      await adjustCredits({ userId: account.user_id, delta: refund, reason: 'imap_order_canceled_refund', note: `Credits refunded after ${store} order ${matchedOrderNumber} was ${effectiveStatus}`, metadata: { tracked_order_id: order.id, source_order_id: serviceOrder.id, imap_status: effectiveStatus }, orderId: serviceOrder.id });
      await supabase.from('tracked_orders').update({ credits_refunded: true, credits_refunded_at: new Date().toISOString() }).eq('id', order.id);
      await supabase.from('orders').update({ status: 'canceled', metadata: { ...sourceMetadata, imap_canceled_at: new Date().toISOString(), credits_refunded_by_imap: refund } }).eq('id', serviceOrder.id);
    }
    results.push({ saved: true, order_id: order.id, status, order_number: matchedOrderNumber });
  }

  return results.length === 1 ? results[0] : { saved: true, status, matched_orders: results.length, orders: results };
}

function imapUidSet(values = []) {
  return [...new Set((values || []).map(Number).filter(Number.isFinite).filter(v => v > 0))]
    .sort((a, b) => a - b)
    .join(',');
}

function describeImapError(err, mailboxName = '') {
  const parts = [];
  if (mailboxName) parts.push(`folder=${mailboxName}`);
  if (err?.message) parts.push(`message=${err.message}`);
  if (err?.responseText) parts.push(`response=${err.responseText}`);
  if (err?.responseStatus) parts.push(`status=${err.responseStatus}`);
  if (err?.code) parts.push(`code=${err.code}`);
  if (err?.command) parts.push(`command=${err.command}`);
  return parts.join(' | ') || String(err || 'Unknown IMAP error');
}


async function markAmazonGhostCandidates(supabase, account) {
  const cutoff = new Date(Date.now() - AMAZON_GHOST_GRACE_MS).toISOString();
  const { data, error } = await supabase.from('orders').select('*')
    .eq('user_id', account.user_id)
    .eq('status', 'pending_email_verification')
    .lt('created_at', cutoff)
    .order('created_at', { ascending:true })
    .limit(500);
  if (error) return { marked:0, error:error.message };
  let marked = 0;
  for (const serviceOrder of data || []) {
    const meta = serviceOrder.metadata || {};
    if (!String(serviceOrder.site || meta.site || '').toLowerCase().includes('amazon')) continue;
    if (meta.matched_email_message_id || meta.email_verified_at || Number(serviceOrder.credits_charged || 0) > 0) continue;
    const emails = findEmailValues(serviceOrder.raw_payload || {});
    // Never ghost-close an Amazon ping unless the webhook itself identifies this exact mailbox.
    // If account identity is missing/ambiguous, leave it yellow for manual review.
    if (!emails.size || !emails.has(lower(account.email))) continue;
    if (meta.ghost_suspected_at) continue;
    const now = new Date().toISOString();
    const nextMeta = { ...meta, ghost_suspected_at: now, ghost_reason: 'No Amazon confirmation email found after a successful mailbox scan.', confirmation_status:'ghost_suspected' };
    await supabase.from('orders').update({ metadata: nextMeta }).eq('id', serviceOrder.id).eq('status','pending_email_verification');
    const { data: tracked } = await supabase.from('tracked_orders').select('*').eq('source_order_id', serviceOrder.id).maybeSingle();
    if (tracked?.id) {
      await supabase.from('tracked_orders').update({
        status:'canceled',
        last_status_at:now,
        product_summary: clean(tracked.product_summary || serviceOrder.product_name || 'Amazon checkout') + ' · Ghost checkout: no retailer confirmation email found',
        updated_at:now
      }).eq('id', tracked.id);
      try {
        await supabase.from('tracked_order_events').upsert({
          order_id:tracked.id,user_id:account.user_id,status:'canceled',event_at:now,
          subject:'Amazon ghost checkout — no confirmation email found',
          message_id:`ghost:${serviceOrder.id}`,source_email:account.email,
          body_excerpt:'No Amazon confirmation email was found after the mailbox successfully scanned beyond the checkout grace period. No credits were charged.'
        },{onConflict:'user_id,message_id',ignoreDuplicates:true});
      } catch (_) {}
    }
    marked += 1;
  }
  if (marked) console.log(`[AMAZON GHOST] ${account.email}: marked ${marked} unconfirmed webhook checkout(s) as ghost candidates; credits remain uncharged.`);
  return { marked };
}

async function scanImportedAccount(supabase, account, adjustCredits = null, onProgress = null, confirmPendingAmazonCheckout = null) {
  const { data: row, error: rowError } = await supabase.from('imported_mail_accounts').select('*').eq('id', account.imported_account_id).maybeSingle();
  if (rowError || !row) throw rowError || new Error('Imported mailbox row no longer exists.');
  const lastSuccessMs = row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
  if (MIN_RESCAN_INTERVAL_MS > 0 && lastSuccessMs && Date.now() - lastSuccessMs < MIN_RESCAN_INTERVAL_MS) {
    if (onProgress) onProgress({ checked:0,total:0,saved:0,skippedRecent:true });
    return { checked:0,total:0,saved:0,skipped_recent:true };
  }
  const client = new ImapFlow({
    host:account.provider.host,port:account.provider.port,secure:account.provider.secure,
    auth:await imapAuthForAccount(supabase,account),logger:false,
    connectionTimeout:30000,greetingTimeout:30000,socketTimeout:120000
  });
  let checked=0,saved=0,total=0;
  let activeMailbox = '';
  const folderState = row.folder_state && typeof row.folder_state === 'object' ? { ...row.folder_state } : {};
  const started = new Date().toISOString();
  try {
    console.log(`[DIRECT IMAP] START ${account.email}`);
    await client.connect();
    let boxes=[]; try{boxes=await client.list();}catch(_){}
    const requested = new Set(String(row.folders || 'Inbox').split(',').map(v=>lower(v)).filter(Boolean));
    const folders=[];
    const addFolder = name => { if(name && !folders.includes(name)) folders.push(name); };
    if (account.provider.name === 'gmail') {
      addFolder(boxes.find(b=>b.specialUse==='\\All')?.path || 'INBOX');
    } else {
      addFolder(boxes.find(b=>lower(b.path)==='inbox')?.path || 'INBOX');
      if ([...requested].some(v=>/junk|spam/.test(v))) {
        const junk=boxes.find(b=>b.specialUse==='\\Junk') || boxes.find(b=>/junk|spam/i.test(String(b.path||b.name||'')));
        if(junk?.path)addFolder(junk.path);
      }
    }
    for (const mailboxName of folders) {
      activeMailbox = mailboxName;
      const lock=await client.getMailboxLock(mailboxName);
      try {
        const key=lower(mailboxName);
        const prior=folderState[key]||{};
        let highestUid=Number(prior.last_seen_uid||0);
        let ids=[];
        if(highestUid>0) ids=await client.search({uid:`${highestUid+1}:*`},{uid:true});
        else {
          const configuredStart=new Date(INITIAL_SCAN_START);const fallbackStart=new Date(Date.now()-INITIAL_LOOKBACK_DAYS*86400000);
          ids=await client.search({since:Number.isNaN(configuredStart.getTime())?fallbackStart:configuredStart},{uid:true});
        }
        ids=(ids||[]).map(Number).filter(Boolean).sort((a,b)=>a-b).slice(0,MAX_MESSAGES_PER_SCAN);
        console.log(`[DIRECT IMAP] ${account.email} folder=${mailboxName} checkpoint=${highestUid || 0} queued=${ids.length}`);
        total += ids.length;
        if(onProgress)onProgress({checked,total,saved,folder:mailboxName});
        const uidRange = imapUidSet(ids);
        if (!uidRange) continue;
        // search(..., { uid:true }) returns message UIDs. ImapFlow fetch() treats
        // its range as sequence numbers unless uid:true is supplied in the
        // THIRD options argument. Without this, Outlook commonly replies with
        // a generic "Command failed" for perfectly valid UID values.
        for await (const msg of client.fetch(uidRange,{uid:true,source:true,envelope:true},{uid:true})) {
          checked++; highestUid=Math.max(highestUid,Number(msg.uid||0));
          try{const parsed=await simpleParser(msg.source);const result=await saveParsedMessage(supabase,account,parsed,msg.uid,adjustCredits,confirmPendingAmazonCheckout);if(result.saved)saved++;}catch(e){console.error('Imported IMAP parse failed',account.email,mailboxName,msg.uid,e.message)}
          if(onProgress)onProgress({checked,total,saved,folder:mailboxName});
        }
        folderState[key]={last_seen_uid:highestUid,updated_at:new Date().toISOString()};
      } finally {lock.release();}
    }
    const now=new Date().toISOString();
    await supabase.from('imported_mail_accounts').update({folder_state:folderState,last_scan_at:now,last_success_at:now,last_error:null,status:'connected',updated_at:now}).eq('id',account.imported_account_id);
    await upsertScanState(supabase,account,{last_scan_at:now,last_success_at:now,last_error:null,is_enabled:true,scan_started_at:started,scanned_through_at:now,initial_scan_start_at:INITIAL_SCAN_START});
    if (checked < MAX_MESSAGES_PER_SCAN) await markAmazonGhostCandidates(supabase, account).catch(()=>{});
    console.log(`[DIRECT IMAP] COMPLETE ${account.email} checked=${checked} indexed=${saved} folders=${folders.length}`);
    return {checked,total,saved,folders:folders.length};
  } catch(err) {
    console.error(`[DIRECT IMAP] FAILED ${account.email}: ${describeImapError(err, activeMailbox)}`);
    const now=new Date().toISOString();
    try{await supabase.from('imported_mail_accounts').update({last_scan_at:now,last_error:String(err.message||err).slice(0,1000),status:'error',updated_at:now}).eq('id',account.imported_account_id);}catch(_){}
    throw err;
  } finally {try{await client.logout();}catch(_){}}
}

async function scanAccount(supabase, account, adjustCredits = null, onProgress = null, confirmPendingAmazonCheckout = null) {
  if (account.imported_account_id) return scanImportedAccount(supabase, account, adjustCredits, onProgress, confirmPendingAmazonCheckout);
  const stateOwnerId = account.archive_user_id || account.user_id;
  const stateResp = await supabase.from('imap_scan_accounts').select('*').eq('user_id', stateOwnerId).eq('email', account.email).maybeSingle();
  const state = stateResp.data || {};
  const lastSuccessMs = state.last_success_at ? new Date(state.last_success_at).getTime() : 0;
  if (MIN_RESCAN_INTERVAL_MS > 0 && lastSuccessMs && Date.now() - lastSuccessMs < MIN_RESCAN_INTERVAL_MS) {
    if (onProgress) onProgress({ checked: 0, total: 0, saved: 0, skippedRecent: true });
    return { checked: 0, total: 0, saved: 0, skipped_recent: true };
  }
  const client = new ImapFlow({
    host: account.provider.host, port: account.provider.port, secure: account.provider.secure,
    auth: await imapAuthForAccount(supabase, account), logger: false,
    connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 120000
  });
  let saved = 0, checked = 0, highestUid = Number(state.last_seen_uid || 0), total = 0;
  const scanStartedAt = new Date().toISOString();
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
      let uids = [];
      if (highestUid > 0) {
        uids = await client.search({ uid: `${highestUid + 1}:*` }, { uid: true });
      } else {
        const configuredStart = new Date(INITIAL_SCAN_START);
        const fallbackStart = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400000);
        const since = Number.isNaN(configuredStart.getTime()) ? fallbackStart : configuredStart;
        uids = await client.search({ since }, { uid: true });
      }
      uids = (uids || []).map(Number).filter(Boolean).sort((a,b)=>a-b);
      total = uids.length;
      if (!uids.length) {
        const now = new Date().toISOString();
        await upsertScanState(supabase, account, { last_scan_at: now, last_success_at: now, last_error: null, is_enabled: true, scan_started_at: scanStartedAt, scanned_through_at: now, initial_scan_start_at: state.initial_scan_start_at || INITIAL_SCAN_START });
        await markAmazonGhostCandidates(supabase, account).catch(()=>{});
        if (onProgress) onProgress({ checked: 0, total: 0, saved: 0 });
        return { checked: 0, total: 0, saved: 0 };
      }
      const batch = uids.slice(0, MAX_MESSAGES_PER_SCAN);
      total = batch.length;
      if (onProgress) onProgress({ checked: 0, total, saved: 0 });
      const uidRange = imapUidSet(batch);
      if (!uidRange) return { checked: 0, total: 0, saved: 0 };
      for await (const msg of client.fetch(uidRange, { uid: true, source: true, envelope: true }, { uid: true })) {
        checked += 1;
        highestUid = Math.max(highestUid, Number(msg.uid || 0));
        try {
          const parsed = await simpleParser(msg.source);
          const result = await saveParsedMessage(supabase, account, parsed, msg.uid, adjustCredits, confirmPendingAmazonCheckout);
          if (result.saved) saved += 1;
        } catch (e) { console.error('IMAP message parse failed', account.email, msg.uid, e.message); }
        if (onProgress) onProgress({ checked, total, saved });
      }
    } finally { lock.release(); }
    const now = new Date().toISOString();
    await upsertScanState(supabase, account, { last_scan_at: now, last_success_at: now, last_error: null, last_seen_uid: highestUid, is_enabled: true, scan_started_at: scanStartedAt, scanned_through_at: now, initial_scan_start_at: state.initial_scan_start_at || INITIAL_SCAN_START });
    if (checked < MAX_MESSAGES_PER_SCAN) await markAmazonGhostCandidates(supabase, account).catch(()=>{});
    return { checked, total, saved };
  } catch (err) {
    console.error(`[DIRECT IMAP] FAILED ${account.email}: ${describeImapError(err, 'INBOX')}`);
    await upsertScanState(supabase, account, { last_scan_at: new Date().toISOString(), last_error: describeImapError(err, 'INBOX').slice(0, 1000), last_seen_uid: highestUid, scan_started_at: scanStartedAt });
    throw err;
  } finally { try { await client.logout(); } catch (_) {} }
}


async function linkedTrackedOrderIds(supabase, orderIds = []) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  const linked = new Set();
  if (!ids.length) return linked;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const r = await supabase.from('tracked_order_emails').select('order_id').in('order_id', chunk);
      if (!r.error) for (const row of r.data || []) if (row.order_id) linked.add(String(row.order_id));
    } catch (_) {}
    try {
      const r = await supabase.from('email_messages').select('linked_order_id').in('linked_order_id', chunk);
      if (!r.error) for (const row of r.data || []) if (row.linked_order_id) linked.add(String(row.linked_order_id));
    } catch (_) {}
  }
  return linked;
}

async function reconcileHistoricalOrderProfileIdentity(supabase, rows = []) {
  const sourceIds = [...new Set((rows || []).map(r => r.source_order_id).filter(Boolean))];
  if (!sourceIds.length) return { corrected: 0, unlinked: 0 };
  const sourceMap = new Map();
  for (let i = 0; i < sourceIds.length; i += 100) {
    const r = await supabase.from('orders').select('id,user_id,site,metadata,raw_payload').in('id', sourceIds.slice(i, i + 100));
    if (!r.error) for (const source of r.data || []) sourceMap.set(String(source.id), source);
  }
  const indexes = new Map();
  let corrected = 0, unlinked = 0;
  for (const order of rows || []) {
    if (lower(order.store) === 'supreme' || ['matched','probable'].includes(lower(order.reconciliation_status))) continue;
    const source = sourceMap.get(String(order.source_order_id || ''));
    if (!source) continue;
    const uid = String(order.user_id || source.user_id || '');
    if (!uid) continue;
    if (!indexes.has(uid)) indexes.set(uid, await buildProfileMailboxIndex(supabase, uid));
    const identity = resolveExactProfileMailbox(source, indexes.get(uid));
    if (!identity?.email) continue;
    const currentEmail = lower(order.source_email);
    const currentProfileId = String(order.profile_id || '');
    if (currentEmail !== lower(identity.email) || currentProfileId !== String(identity.profile_id || '')) {
      const patch = { source_email: lower(identity.email), profile_id: identity.profile_id || order.profile_id || null, updated_at: new Date().toISOString() };
      const upd = await supabase.from('tracked_orders').update(patch).eq('id', order.id);
      if (!upd.error) {
        order.source_email = patch.source_email;
        order.profile_id = patch.profile_id;
        corrected++;
      }
    }
    unlinked += await removeMismatchedOrderEmailLinks(supabase, order.id, identity.email);
  }
  return { corrected, unlinked };
}

async function repairHistoricalOrderEmails(supabase, userId = null, adjustCredits = null, confirmPendingAmazonCheckout = null, options = {}) {
  const maxOrders = Math.max(1, Math.min(500, Number(options.maxOrders || 20)));
  const priorityIds = [...new Set((options.priorityOrderIds || []).map(String).filter(Boolean))];
  const rowsById = new Map();

  // Always load explicitly damaged/linked orders first, even when they are months old. The old
  // implementation only inspected the newest 100 candidates, so an older broken Target order
  // could be reported as "reconciled" without ever being fetched from its OAuth/IMAP mailbox.
  for (let i = 0; i < priorityIds.length; i += 100) {
    let pq = supabase.from('tracked_orders')
      .select('id,user_id,source_order_id,profile_id,source_email,store,order_number,order_date,status,reconciliation_status')
      .in('id', priorityIds.slice(i, i + 100));
    if (userId) pq = pq.eq('user_id', userId);
    const pr = await pq;
    if (pr.error) throw pr.error;
    for (const row of pr.data || []) rowsById.set(String(row.id), row);
  }

  let q = supabase.from('tracked_orders')
    .select('id,user_id,source_order_id,profile_id,source_email,store,order_number,order_date,status,reconciliation_status')
    .not('order_number','is',null)
    .order('order_date',{ascending:false})
    .limit(Math.max(maxOrders * 8, 100));
  if (userId) q = q.eq('user_id', userId);
  const recent = await q;
  if (recent.error) throw recent.error;
  for (const row of recent.data || []) if (!rowsById.has(String(row.id))) rowsById.set(String(row.id), row);
  const rows = [...rowsById.values()];

  // Legacy bot/Astral webhooks frequently carried only a Profile name. Re-resolve that
  // profile inside the already-known website user before deciding which mailbox to search.
  // This prevents a historical order from being searched in another profile's mailbox.
  const identityRepair = await reconcileHistoricalOrderProfileIdentity(supabase, rows || []);

  const validRows = (rows || []).filter(order => {
    const email = lower(order.source_email);
    return email && email !== 'waiting-for-imap@local' && email.includes('@') && clean(order.order_number);
  });
  const linked = await linkedTrackedOrderIds(supabase, validRows.map(order => order.id));
  // Normally historical repair only touches orders with no linked mail. Manual retailer
  // reconciliation can force a source re-fetch for already-linked orders whose AYCD copy was
  // truncated to an invisible Target preheader before HTML parsing was fixed.
  const eligible = options.forceLinked ? validRows : validRows.filter(order => !linked.has(String(order.id)));
  const prioritySet = new Set(priorityIds);
  const candidates = [
    ...eligible.filter(order => prioritySet.has(String(order.id))),
    ...eligible.filter(order => !prioritySet.has(String(order.id)))
  ].slice(0, maxOrders);
  if (!candidates.length) return { checked_orders:0, matched_messages:0, repaired_orders:0, identity_corrected:identityRepair.corrected, wrong_links_removed:identityRepair.unlinked, skipped:true };

  const accounts = await loadScanAccounts(supabase, userId);
  const accountMap = new Map(accounts.map(account => [`${account.user_id}:${lower(account.email)}`, account]));
  const profileAccountMap = new Map();
  for (const account of accounts) {
    if (!account.profile_id) continue;
    const key = `${account.user_id}:${account.profile_id}`;
    // Prefer Profile Builder IMAP/app-password rows over imported AYCD OAuth rows when both exist.
    const existing = profileAccountMap.get(key);
    if (!existing || (existing.imported_account_id && !account.imported_account_id)) profileAccountMap.set(key, account);
  }
  const resolveRepairAccount = (order) => {
    const exact = accountMap.get(`${order.user_id}:${lower(order.source_email)}`);
    if (exact) return exact;
    if (order.profile_id) return profileAccountMap.get(`${order.user_id}:${order.profile_id}`) || null;
    return null;
  };
  const byMailbox = new Map();
  for (const order of candidates) {
    const account = resolveRepairAccount(order);
    if (!account) continue;
    const key = `${account.user_id}:${lower(account.email)}`;
    if (!byMailbox.has(key)) byMailbox.set(key, { account, orders:[] });
    byMailbox.get(key).orders.push(order);
  }

  let checkedOrders = 0, matchedMessages = 0, repairedOrders = 0, mailboxFailures = 0;
  const details = [];
  // Report orders that could not even be mapped to a connected OAuth2/IMAP mailbox. This makes
  // a bad profile/mailbox association visible instead of looking like a parser failure.
  for (const order of candidates) {
    const account = resolveRepairAccount(order);
    if (!account) details.push({
      tracked_order_id: order.id, order_number: clean(order.order_number), mailbox: lower(order.source_email),
      store: lower(order.store), profile_id: order.profile_id || null, result: 'mailbox_not_connected', messages_found: 0, messages_processed: 0
    });
  }
  for (const { account, orders } of byMailbox.values()) {
    const client = new ImapFlow({
      host:account.provider.host, port:account.provider.port, secure:account.provider.secure,
      auth:await imapAuthForAccount(supabase,account), logger:false,
      connectionTimeout:30000, greetingTimeout:30000, socketTimeout:120000
    });
    try {
      console.log(`[ORDER REPAIR] START ${account.email} for ${orders.length} historical order(s)`);
      await client.connect();
      let boxes=[]; try { boxes=await client.list(); } catch (_) {}
      let mailboxName='INBOX';
      if (account.provider.name === 'gmail') mailboxName=boxes.find(b=>b.specialUse==='\\All')?.path || 'INBOX';
      const lock=await client.getMailboxLock(mailboxName);
      try {
        const processedUids = new Set();
        for (const order of orders) {
          checkedOrders++;
          const orderNumber = clean(order.order_number);
          const detail = {
            tracked_order_id: order.id, order_number: orderNumber, mailbox: lower(account.email),
            store: lower(order.store), auth_method: account.auth_method || (account.imported_account_id ? 'imported' : 'app_password'),
            mailbox_source: account.imported_account_id ? 'aycd_imported_oauth' : 'profile_builder_imap', profile_id: account.profile_id || order.profile_id || null,
            result: 'searching', messages_found: 0, messages_processed: 0, saved_messages: 0
          };
          details.push(detail);
          let uids=[];
          try {
            // TEXT searches the full RFC822 message (headers + MIME body) on Gmail/Outlook.
            // This bypasses the damaged archive copy and fetches the retailer's original message.
            uids = await client.search({ text: orderNumber }, { uid:true });
          } catch (searchError) {
            detail.result = 'imap_search_failed';
            detail.error = clean(searchError.message || searchError).slice(0,500);
            console.warn(`[ORDER REPAIR] IMAP text search failed ${account.email} ${orderNumber}: ${searchError.message || searchError}`);
            continue;
          }
          uids=(uids||[]).map(Number).filter(Boolean).sort((a,b)=>a-b).slice(-50);
          detail.messages_found = uids.length;
          const fresh = uids.filter(uid => !processedUids.has(uid));
          for (const uid of fresh) processedUids.add(uid);
          const uidRange=imapUidSet(fresh);
          if (!uidRange) { detail.result = uids.length ? 'already_processed_this_pass' : 'no_live_message_found'; continue; }
          for await (const msg of client.fetch(uidRange,{uid:true,source:true,envelope:true},{uid:true})) {
            detail.messages_processed++;
            try {
              const parsed=await simpleParser(msg.source);
              const result=await saveParsedMessage(supabase,account,parsed,msg.uid,adjustCredits,confirmPendingAmazonCheckout);
              if (result?.saved) { matchedMessages++; detail.saved_messages++; }
            } catch (parseError) {
              detail.error = clean(parseError.message || parseError).slice(0,500);
              console.warn(`[ORDER REPAIR] Parse/link failed ${account.email} uid=${msg.uid}: ${parseError.message || parseError}`);
            }
          }
          const after = await linkedTrackedOrderIds(supabase,[order.id]);
          if (after.has(String(order.id))) repairedOrders++;
          try {
            const ir = await supabase.from('tracked_order_items').select('product_name,role,status').eq('order_id', order.id).order('created_at');
            if (!ir.error) {
              detail.items = ir.data || [];
              const main = (ir.data || []).filter(i => i.role === 'main');
              detail.main_item_status = main.map(i => i.status).filter(Boolean).join(', ') || null;
              const filler = (ir.data || []).filter(i => i.role === 'filler');
              detail.filler_item_status = filler.map(i => i.status).filter(Boolean).join(', ') || null;
            }
            const tr = await supabase.from('tracked_orders').select('status,reconciliation_status,reconciliation_note').eq('id',order.id).maybeSingle();
            if (!tr.error && tr.data) {
              detail.final_order_status = tr.data.status;
              detail.reconciliation_status = tr.data.reconciliation_status;
              detail.reconciliation_note = tr.data.reconciliation_note || null;
            }
          } catch (_) {}
          detail.result = detail.saved_messages ? 'live_mime_processed' : (detail.error ? 'message_processing_failed' : 'live_message_found_not_linked');
        }
      } finally { lock.release(); }
      console.log(`[ORDER REPAIR] COMPLETE ${account.email}`);
    } catch (mailboxError) {
      mailboxFailures++;
      console.warn(`[ORDER REPAIR] FAILED ${account.email}: ${describeImapError(mailboxError)}`);
    } finally { try { await client.logout(); } catch (_) {} }
  }
  return { checked_orders:checkedOrders, matched_messages:matchedMessages, repaired_orders:repairedOrders, mailbox_failures:mailboxFailures, candidates:candidates.length, identity_corrected:identityRepair.corrected, wrong_links_removed:identityRepair.unlinked, details };
}

async function runHistoricalOrderEmailRepair(supabase, userId = null, adjustCredits = null, confirmPendingAmazonCheckout = null, options = {}) {
  // Background repair remains single-flight, but a user-clicked targeted reconciliation must not
  // be silently skipped just because the scheduled repair happens to be running. Targeted repair
  // uses its own IMAP connections and idempotent message/order upserts, so it is safe to run in
  // parallel and is far preferable to returning repair_already_running without checking a mailbox.
  const allowConcurrent = options.allowConcurrent === true;
  if (historicalRepairRunning && !allowConcurrent) return { skipped:true, reason:'repair_already_running' };
  if (!allowConcurrent) historicalRepairRunning = true;
  try {
    const result = await repairHistoricalOrderEmails(supabase, userId, adjustCredits, confirmPendingAmazonCheckout, options);
    return { ...result, concurrent_with_background_repair: allowConcurrent && historicalRepairRunning };
  } finally {
    if (!allowConcurrent) historicalRepairRunning = false;
  }
}

async function syncRecentServiceOrdersForBackground(supabase, accounts = []) {
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const r = await supabase.from('orders').select('user_id,created_at').gte('created_at', since)
      .order('created_at',{ascending:false}).limit(2000);
    if (r.error) throw r.error;
    const userIds = [...new Set((r.data || []).map(x => x.user_id).filter(Boolean))].slice(0,100);
    for (const userId of userIds) {
      const userAccounts = accounts.filter(a => String(a.user_id) === String(userId));
      try { await syncServiceOrders(supabase, userId, userAccounts); }
      catch (err) { console.warn(`[ORDER TRACKER] Background order sync failed for ${userId}:`, err.message || err); }
    }
    if (userIds.length) console.log(`[ORDER TRACKER] Background synced tracked-order records for ${userIds.length} recent user(s).`);
  } catch (err) { console.warn('[ORDER TRACKER] Background recent-order sync skipped:', err.message || err); }
}

let scanRunning = false;
async function scanAll(supabase, userId = null, adjustCredits = null, onProgress = null, confirmPendingAmazonCheckout = null) {
  if (scanRunning && !userId) return { skipped: true };
  if (!userId) scanRunning = true;
  try {
    let accounts = await loadScanAccounts(supabase, userId);
    if (userId) await syncServiceOrders(supabase, userId, accounts);
    else await syncRecentServiceOrdersForBackground(supabase, accounts);
    // Mailboxes referenced by pending checkouts are always scanned first so a 500-account
    // imported AYCD pool does not delay a fresh retailer confirmation behind the round-robin queue.
    let pendingEmails = new Set();
    try {
      let oq = supabase.from('orders').select('raw_payload,metadata,status,created_at').order('created_at',{ascending:false}).limit(2000);
      if (userId) oq = oq.eq('user_id', userId);
      const or = await oq;
      if (!or.error) {
        for (const order of or.data || []) {
          const status = lower(order.status || order.metadata?.confirmation_status);
          if (['delivered','canceled','refunded'].includes(status)) continue;
          for (const email of findEmailValues(order.raw_payload || {})) pendingEmails.add(email);
          for (const email of findEmailValues(order.metadata || {})) pendingEmails.add(email);
        }
      }
    } catch (_) {}
    accounts.sort((a,b) => Number(pendingEmails.has(b.email)) - Number(pendingEmails.has(a.email)));
    if (!userId && accounts.length > MAX_ACCOUNTS_PER_CYCLE) {
      const priority = accounts.filter(a => pendingEmails.has(a.email));
      const regular = accounts.filter(a => !pendingEmails.has(a.email));
      const prioritySlice = priority.slice(0, MAX_ACCOUNTS_PER_CYCLE);
      const remainingSlots = Math.max(0, MAX_ACCOUNTS_PER_CYCLE - prioritySlice.length);
      const start = regular.length ? backgroundAccountCursor % regular.length : 0;
      const rotated = regular.length ? [...regular.slice(start), ...regular.slice(0,start)] : [];
      accounts = [...prioritySlice, ...rotated.slice(0, remainingSlots)];
      if (regular.length && remainingSlots) backgroundAccountCursor = (start + remainingSlots) % regular.length;
    }
    const results = [];
    console.log(`[ORDER TRACKER] ${userId ? 'User/manual' : 'Background'} IMAP cycle: ${accounts.length} mailbox(es), ${pendingEmails.size} pending-checkout email(s) prioritized.`);
    if (onProgress) onProgress({ phase: 'scanning', accountIndex: 0, accountTotal: accounts.length, checked: 0, total: 0 });
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      try {
        const result = await scanAccount(supabase, account, adjustCredits, detail => {
          if (onProgress) onProgress({ phase: 'scanning', accountIndex: index, accountTotal: accounts.length, email: account.email, ...detail });
        }, confirmPendingAmazonCheckout);
        results.push({ email: account.email, ...result });
      } catch (err) {
        results.push({ email: account.email, error: err.message });
      }
      if (onProgress) onProgress({ phase: 'scanning', accountIndex: index + 1, accountTotal: accounts.length, email: account.email, accountComplete: true });
    }
    return { accounts: accounts.length, results };
  } finally { if (!userId) scanRunning = false; }
}

function scanJobView(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, phase: job.phase, percent: job.percent,
    message: job.message, accountIndex: job.accountIndex, accountTotal: job.accountTotal,
    email: job.email || null, checked: job.checked || 0, total: job.total || 0,
    startedAt: job.startedAt, completedAt: job.completedAt || null,
    error: job.error || null, result: job.result || null
  };
}

function startUserScanJob(supabase, userId, adjustCredits, confirmPendingAmazonCheckout) {
  const current = userScanJobs.get(String(userId));
  if (current?.status === 'running') return current;
  const job = { id: `${userId}:${Date.now()}`, status: 'running', phase: 'starting', percent: 1, message: 'Preparing connected mailboxes…', accountIndex: 0, accountTotal: 0, checked: 0, total: 0, startedAt: new Date().toISOString() };
  userScanJobs.set(String(userId), job);
  Promise.resolve().then(async () => {
    try {
      const result = await scanAll(supabase, userId, adjustCredits, progress => {
        job.phase = progress.phase || 'scanning';
        job.accountIndex = Number(progress.accountIndex || 0);
        job.accountTotal = Number(progress.accountTotal || 0);
        job.email = progress.email || job.email;
        job.checked = Number(progress.checked || 0);
        job.total = Number(progress.total || 0);
        const accountFraction = job.accountTotal ? job.accountIndex / job.accountTotal : 0;
        const messageFraction = job.total ? Math.min(1, job.checked / job.total) : 0;
        job.percent = Math.max(2, Math.min(98, Math.round((accountFraction + (messageFraction / Math.max(1, job.accountTotal))) * 96)));
        job.message = job.email ? `Scanning ${job.email} (${Math.min(job.checked, job.total || job.checked)} of ${job.total || 'new'} messages)…` : 'Scanning connected mailboxes…';
      }, confirmPendingAmazonCheckout);
      job.status = 'complete'; job.phase = 'complete'; job.percent = 100; job.message = 'Email scan complete.'; job.completedAt = new Date().toISOString(); job.result = result;
    } catch (error) {
      job.status = 'failed'; job.phase = 'failed'; job.percent = 100; job.message = 'Email scan finished with an error.'; job.error = error.message; job.completedAt = new Date().toISOString();
    }
  });
  return job;
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

async function scanAycdForUser(supabase, userId, adjustCredits = null, confirmPendingAmazonCheckout = null) {
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
    const saved = await saveParsedMessage(supabase, account, parsed, m.uid, adjustCredits, confirmPendingAmazonCheckout);
    if (saved?.ignored) ignored += 1; else matched += 1;
  }
  return { configured: true, checked: result.messages.length, matched, ignored };
}

function registerOrderTracker({ app, supabase, auth, admin, adjustUserCredits, confirmPendingAmazonCheckout }) {
  checkoutScanRuntime = async (userId) => {
    // A checkout webhook is the strongest signal that this user's mailbox should be checked now.
    // First persist the webhook order into tracked_orders, then scan only this user's relevant mailboxes.
    const accounts = await loadScanAccounts(supabase, userId);
    await syncServiceOrders(supabase, userId, accounts);
    // A fresh checkout must bypass the normal anti-thrash rescan window. Clear only this user's
    // last-success timestamps; UID checkpoints remain intact, so only genuinely newer mail is fetched.
    try { await supabase.from('imap_scan_accounts').update({ last_success_at:null }).eq('user_id', userId); } catch (_) {}
    try { await supabase.from('imported_mail_accounts').update({ last_success_at:null }).eq('matched_user_id', userId).eq('is_enabled', true); } catch (_) {}
    console.log(`[ORDER TRACKER] Checkout-triggered mailbox scan for user ${userId}; ${accounts.length} mailbox(es).`);
    await scanAll(supabase, userId, adjustUserCredits, null, confirmPendingAmazonCheckout);
    // Confirmation emails can arrive a little after the webhook. Schedule one quiet follow-up pass
    // outside the minimum rescan interval so users do not have to open Order Tracker to cause it.
    setTimeout(() => {
      scanAll(supabase, userId, adjustUserCredits, null, confirmPendingAmazonCheckout)
        .catch(err => console.error('[ORDER TRACKER] Follow-up checkout scan failed:', err.message || err));
    }, Math.max(MIN_RESCAN_INTERVAL_MS + 5000, 150000));
  };

  app.post('/admin/email-center/import-aycd-accounts', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });
    try {
      const csvText = String(req.body?.csv || '');
      if (!csvText.trim()) return res.status(400).json({ error: 'Choose an AYCD CSV export first.' });
      if (Buffer.byteLength(csvText, 'utf8') > 8 * 1024 * 1024) return res.status(413).json({ error: 'CSV is too large for a single import.' });
      const records = parseCsvRecords(csvText);
      if (!records.length) return res.status(400).json({ error: 'No account rows were found in the CSV.' });
      const ownerMap = await buildMailboxOwnerMap(supabase);
      let imported = 0, ready = 0, placeholders = 0, matched = 0, ambiguous = 0, unsupported = 0;
      const errors = [];
      for (const record of records) {
        const email = lower(record.Username || record.Email || record.email);
        if (!email || !email.includes('@')) continue;
        const provider = clean(record.Provider || providerForEmail(email)?.name || '');
        const inferred = providerForEmail(email);
        const rawHost = clean(record.Host || inferred?.host || '');
        const rawPort = Number(record.Port || inferred?.port || 993) || 993;
        const rawSecure = record['Requires SSL'] === '' ? (inferred?.secure !== false) : !/^(false|0|no)$/i.test(clean(record['Requires SSL']));
        const refreshToken = clean(record['OAuth2 Refresh Token']);
        const clientId = clean(record['OAuth2 Client ID']);
        const clientSecret = clean(record['OAuth2 Client Secret']);
        const appPassword = clean(record['App Password']);
        const password = clean(record.Password);
        const loginType = clean(record['Login Type'] || record['IMAP Auth Method']);
        let authMethod = refreshToken && clientId ? 'oauth2' : (appPassword ? 'app_password' : (password ? 'password' : 'unsupported'));
        const p = lower(provider);
        // Outlook/Hotmail basic auth is no longer a dependable server-side path. Do not mark
        // a password-only Microsoft row ready; keep it visible as unsupported until OAuth exists.
        if (/outlook|hotmail|microsoft|live/.test(p) && authMethod === 'password') authMethod = 'unsupported';
        const isPlaceholder = authMethod === 'unsupported';
        const match = ownerMap.get(email) || { match_status:'unmatched', matched_user_id:null, matched_profile_id:null };
        const row = {
          imported_by_user_id: req.user_id,
          email, provider, category: clean(record.Category),
          imap_host: rawHost || null, imap_port: rawPort, imap_secure: rawSecure,
          folders: clean(record.Folders) || null, login_type: loginType || null, auth_method: authMethod,
          password_enc: password ? encrypt(password) : null,
          app_password_enc: appPassword ? encrypt(appPassword) : null,
          refresh_token_enc: refreshToken ? encrypt(refreshToken) : null,
          client_id_enc: clientId ? encrypt(clientId) : null,
          client_secret_enc: clientSecret ? encrypt(clientSecret) : null,
          mail_proxy_enc: clean(record['Mail Proxy']) ? encrypt(clean(record['Mail Proxy'])) : null,
          browser_proxy_enc: clean(record['Browser Proxy']) ? encrypt(clean(record['Browser Proxy'])) : null,
          is_enabled: !isPlaceholder, is_placeholder: isPlaceholder,
          status: isPlaceholder ? 'placeholder' : 'ready', last_error: null,
          matched_user_id: match.matched_user_id, matched_profile_id: match.matched_profile_id, match_status: match.match_status,
          updated_at: new Date().toISOString()
        };
        const result = await supabase.from('imported_mail_accounts').upsert(row, { onConflict:'imported_by_user_id,email' });
        if (result.error) { errors.push(`${email}: ${result.error.message}`); continue; }
        imported++; if (isPlaceholder) placeholders++; else ready++;
        if (match.match_status === 'matched') matched++; else if (match.match_status === 'ambiguous') ambiguous++;
        if (authMethod === 'unsupported') unsupported++;
      }
      res.json({ success:true, imported, ready, placeholders, matched, ambiguous, unsupported, errors:errors.slice(0,25), message:`Imported ${imported} AYCD account rows. ${ready} are ready for direct scanning.` });
    } catch (error) { res.status(500).json({ error:error.message }); }
  });

  app.get('/admin/email-center/imported-accounts', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });
    const { data, error } = await supabase.from('imported_mail_accounts')
      .select('id,email,provider,category,auth_method,is_enabled,is_placeholder,status,last_error,last_test_at,last_scan_at,last_success_at,match_status,matched_user_id,matched_profile_id,created_at,updated_at')
      .eq('imported_by_user_id', req.user_id).order('email');
    if (error) return res.status(500).json({ error:error.message });
    const rows = data || [];
    const summary = rows.reduce((a,r) => { a.total++; a[r.status || 'unknown']=(a[r.status || 'unknown']||0)+1; if(r.is_enabled)a.enabled++; if(r.match_status==='matched')a.matched++; if(r.match_status==='ambiguous')a.ambiguous++; return a; }, {total:0,enabled:0,matched:0,ambiguous:0});
    res.json({ accounts:rows, summary });
  });

  app.post('/admin/email-center/imported-accounts/rematch', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });
    try { res.json({ success:true, ...(await refreshImportedMailboxMatches(supabase, req.user_id)) }); }
    catch (error) { res.status(500).json({ error:error.message }); }
  });

  app.patch('/admin/email-center/imported-accounts/:id', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });
    const patch = { updated_at:new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_enabled')) patch.is_enabled = !!req.body.is_enabled;
    const { data, error } = await supabase.from('imported_mail_accounts').update(patch).eq('id',req.params.id).eq('imported_by_user_id',req.user_id).select('id,email,is_enabled,status').maybeSingle();
    if (error) return res.status(500).json({error:error.message});
    res.json({success:true,account:data});
  });

  app.post('/admin/email-center/imported-accounts/:id/test', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });
    try {
      const { data:row, error } = await supabase.from('imported_mail_accounts').select('*').eq('id',req.params.id).eq('imported_by_user_id',req.user_id).maybeSingle();
      if (error || !row) return res.status(404).json({error:error?.message || 'Imported account not found.'});
      const provider = providerFromImportedRow(row); if(!provider) return res.status(400).json({error:'No supported IMAP host is available for this row.'});
      const account = { user_id:row.matched_user_id||row.imported_by_user_id, archive_user_id:row.imported_by_user_id, profile_id:row.matched_profile_id||null, email:lower(row.email), provider, imported_account_id:row.id, auth_method:lower(row.auth_method), refresh_token_enc:row.refresh_token_enc, client_id_enc:row.client_id_enc, client_secret_enc:row.client_secret_enc, app_password_enc:row.app_password_enc, password_enc:row.password_enc, ingestion_source:'aycd_import' };
      const client = new ImapFlow({ host:provider.host,port:provider.port,secure:provider.secure,auth:await imapAuthForAccount(supabase,account),logger:false,connectionTimeout:20000,greetingTimeout:20000,socketTimeout:30000 });
      await client.connect(); const lock=await client.getMailboxLock('INBOX'); let messages=0; try{messages=Number(client.mailbox?.exists||0);}finally{lock.release();} await client.logout();
      await supabase.from('imported_mail_accounts').update({status:'connected',last_error:null,last_test_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',row.id);
      res.json({success:true,email:row.email,provider:provider.name,messages});
    } catch (error) {
      try { await supabase.from('imported_mail_accounts').update({status:'error',last_error:String(error.message||error).slice(0,1000),last_test_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',req.params.id).eq('imported_by_user_id',req.user_id); } catch (_) {}
      res.status(400).json({error:error.message});
    }
  });
  app.post('/admin/email-center/imported-accounts/:id/rescan-history', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    try {
      const { data:row, error } = await supabase.from('imported_mail_accounts').select('*')
        .eq('id',req.params.id).eq('imported_by_user_id',req.user_id).maybeSingle();
      if (error || !row) return res.status(404).json({ error:error?.message || 'Imported account not found.' });
      const resetAt = new Date().toISOString();
      const reset = await supabase.from('imported_mail_accounts').update({
        folder_state:{}, last_scan_at:null, last_success_at:null, last_error:null, status:'ready', updated_at:resetAt
      }).eq('id',row.id);
      if (reset.error) throw reset.error;
      // Also clear the legacy scan checkpoint for the same mailbox if one exists.
      try {
        await supabase.from('imap_scan_accounts').update({ last_seen_uid:0, last_scan_at:null, last_success_at:null, last_error:null })
          .eq('email', lower(row.email));
      } catch (_) {}
      const provider = providerFromImportedRow(row);
      if (provider) {
        const account = { user_id:row.matched_user_id||row.imported_by_user_id, archive_user_id:row.imported_by_user_id,
          profile_id:row.matched_profile_id||null, email:lower(row.email), provider, imported_account_id:row.id,
          auth_method:lower(row.auth_method), refresh_token_enc:row.refresh_token_enc, client_id_enc:row.client_id_enc,
          client_secret_enc:row.client_secret_enc, app_password_enc:row.app_password_enc, password_enc:row.password_enc,
          folders:row.folders, folder_state:{}, ingestion_source:'aycd_import' };
        Promise.resolve().then(() => scanImportedAccount(supabase, account, adjustUserCredits, null, confirmPendingAmazonCheckout))
          .catch(err => console.error(`[DIRECT IMAP] History rescan failed ${row.email}:`, err.message || err));
      }
      res.status(202).json({ success:true, email:row.email, message:'Mailbox history checkpoint reset and rescan started.' });
    } catch (error) { res.status(500).json({ error:error.message }); }
  });

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



  async function decorateTrackedOrdersWithEmails(userId, orders = []) {
    const ids = (orders || []).map(o => o.id).filter(Boolean);
    if (!ids.length) return orders || [];
    const counts = new Map(ids.map(id => [id, { total:0, confirmed:0, processing:0, shipped:0, delivered:0, canceled:0, refunded:0, unknown:0 }]));
    let junctionWorked = false;
    try {
      const { data, error } = await supabase.from('tracked_order_emails')
        .select('order_id,event_type,email_messages!inner(id)')
        .in('order_id', ids);
      if (!error) {
        junctionWorked = true;
        for (const row of data || []) {
          const c = counts.get(row.order_id); if (!c) continue;
          const t = lower(row.event_type || 'unknown');
          c.total += 1; c[t] = (c[t] || 0) + 1;
        }
      }
    } catch (_) {}
    if (!junctionWorked) {
      try {
        const { data } = await supabase.from('email_messages').select('id,linked_order_id,email_type').in('linked_order_id', ids);
        for (const row of data || []) {
          const c = counts.get(row.linked_order_id); if (!c) continue;
          const t = lower(row.email_type || 'unknown');
          c.total += 1; c[t] = (c[t] || 0) + 1;
        }
      } catch (_) {}
    }
    const itemMap = new Map(ids.map(id => [String(id), []]));
    const shipmentMap = new Map(ids.map(id => [String(id), []]));
    try {
      for (let i=0;i<ids.length;i+=100) {
        const r=await supabase.from('tracked_order_items').select('*').in('order_id',ids.slice(i,i+100)).order('created_at');
        if (r.error) throw r.error;
        for (const row of r.data||[]) (itemMap.get(String(row.order_id))||[]).push(row);
      }
      for (let i=0;i<ids.length;i+=100) {
        const r=await supabase.from('tracked_order_shipments').select('*').in('order_id',ids.slice(i,i+100)).order('created_at');
        if (r.error) throw r.error;
        for (const row of r.data||[]) (shipmentMap.get(String(row.order_id))||[]).push({ ...row, tracking_url: carrierTrackingUrl(row.carrier || detectCarrierFromTracking(row.tracking_number || ''), row.tracking_number || '') });
      }
    } catch (_) { /* item-level migration is optional until installed */ }
    return (orders || []).map(o => ({
      ...o,
      email_counts: counts.get(o.id) || { total:0 },
      has_linked_email: Number(counts.get(o.id)?.total || 0) > 0,
      items: itemMap.get(String(o.id)) || [],
      shipments: shipmentMap.get(String(o.id)) || [],
      tracking_url: carrierTrackingUrl(o.carrier || detectCarrierFromTracking(o.tracking_number || ''), o.tracking_number || '')
    }));
  }

  app.get('/orders/bootstrap', auth, async (req, res) => {
    // FAST READ-ONLY BOOTSTRAP: opening Order Tracker must never trigger mailbox scans or
    // rebuild tracked orders. Background/webhook workers keep tracked_orders current.
    const warnings = [];
    let states = [];
    try {
      const stateResult = await supabase.from('imap_scan_accounts')
        .select('email,provider,last_scan_at,last_success_at,last_error,scanned_through_at,is_enabled')
        .eq('user_id', req.user_id).eq('is_enabled', true).order('email').limit(100);
      if (stateResult.error) warnings.push(`Mailbox status: ${stateResult.error.message}`);
      else states = stateResult.data || [];
    } catch (error) { warnings.push(`Mailbox status: ${error.message}`); }

    let importedCount = 0;
    try {
      // Count only; do not send hundreds of imported credentials/status rows to the tracker page.
      const r = await supabase.from('imported_mail_accounts').select('id', { count:'exact', head:true })
        .eq('is_enabled', true).eq('is_placeholder', false)
        .or(`matched_user_id.eq.${req.user_id},imported_by_user_id.eq.${req.user_id}`);
      if (!r.error) importedCount = Number(r.count || 0);
    } catch (_) {}

    const accounts = states.map(state => ({ ...state, connected:true, credential_ready:true }));
    let orders = [];
    try {
      let result = await supabase.from('tracked_orders').select('*, tracked_order_events(*)')
        .eq('user_id', req.user_id).order('order_date', { ascending:false }).limit(1000);
      if (result.error) result = await supabase.from('tracked_orders').select('*')
        .eq('user_id', req.user_id).order('order_date', { ascending:false }).limit(1000);
      if (result.error) throw result.error;
      orders = await decorateTrackedOrdersWithEmails(req.user_id, result.data || []);
    } catch (error) { warnings.push(`Tracked orders: ${error.message}`); }

    const summary = orders.reduce((a,o) => { a.total += Number(o.total || 0); a[o.status] = (a[o.status]||0)+1; return a; }, { total:0 });
    summary.success_rate = orders.length ? Math.round(((summary.confirmed || 0) + (summary.processing || 0) + (summary.shipped || 0) + (summary.delivered || 0)) / orders.length * 1000) / 10 : 0;
    return res.json({
      accounts,
      connected_count: Math.max(states.length, importedCount),
      orders,
      summary,
      warnings,
      partial: warnings.length > 0,
      background_scanning: process.env.IMAP_ORDER_TRACKER_ENABLED !== 'false',
      scan_interval_ms: SCAN_INTERVAL_MS,
      aycd: { configured: req.role === 'super_admin', mode: 'local_unified_imap_bridge' },
      is_super_admin: req.role === 'super_admin'
    });
  });


  function bridgeHash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
  }
  async function getBridgeBySecret(secret) {
    const hash = bridgeHash(secret);
    const { data, error } = await supabase.from('aycd_bridge_devices').select('*').eq('device_secret_hash', hash).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function loadAycdRecipientMap(userId) {
    const map = new Map();
    const { data: profiles, error: pe } = await supabase.from('profiles').select('id,user_id').eq('user_id', userId);
    if (pe) throw pe;
    const profileIds = (profiles || []).map(p => p.id);
    const profileById = new Map((profiles || []).map(p => [String(p.id), p]));
    const add = row => {
      const email = lower(row?.login_email || row?.email);
      const profile = profileById.get(String(row?.profile_id));
      if (email && profile && !map.has(email)) map.set(email, { profile_id: profile.id, email });
    };
    if (profileIds.length) {
      try {
        for (let i = 0; i < profileIds.length; i += 75) {
          const r = await supabase
            .from('profile_store_credentials')
            .select('profile_id,login_email,use_aycd_inbox')
            .in('profile_id', profileIds.slice(i, i + 75))
            .eq('use_aycd_inbox', true);
          if (r.error) throw r.error;
          for (const row of r.data || []) add(row);
        }
      } catch (_) {}
      // AYCD linkage is explicit. Legacy account rows are not included unless
      // the corresponding store credential has use_aycd_inbox enabled.
    }
    return map;
  }

  function aycdMessageRecipients(item = {}) {
    const out = new Set();
    const add = value => {
      if (!value) return;
      if (Array.isArray(value)) return value.forEach(add);
      for (const match of String(value).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)) out.add(lower(match[0]));
    };
    add(item.recipients); add(item.to); add(item.cc); add(item.deliveredTo); add(item.mailboxEmail);
    return [...out];
  }

  async function ingestAycdMessages(userId, messages) {
    const recipientMap = await loadAycdRecipientMap(userId);
    const fallbackAccount = {
      user_id: userId,
      profile_id: null,
      email: 'inbox@aycd.me',
      ingestion_source: 'aycd',
      provider: { name: 'aycd-unified-imap', host: '127.0.0.1', port: 0, secure: false }
    };
    // Do NOT synchronize the entire service-order history for every bridge upload chunk.
    // A large AYCD history import can send thousands of chunks; running syncServiceOrders()
    // before every one caused Render requests to exceed the proxy timeout and return 520.
    // saveParsedMessage() already synchronizes a specific platform order on demand when an
    // order-related email actually needs it. This keeps bulk email ingestion fast.
    let checked = 0, matched = 0, ignored = 0, linkedProfiles = 0;
    const results = [];
    for (const item of (Array.isArray(messages) ? messages : [])) {
      checked += 1;
      try {
        const directMailbox = lower(item.mailboxEmail);
        const linked = (directMailbox ? recipientMap.get(directMailbox) : null) || aycdMessageRecipients(item).map(email => recipientMap.get(email)).find(Boolean);
        const account = directMailbox
          ? { ...fallbackAccount, profile_id: linked?.profile_id || null, email: directMailbox, provider: { ...fallbackAccount.provider, name: 'aycd-direct-account' } }
          : (linked ? { ...fallbackAccount, profile_id: linked.profile_id, email: linked.email } : fallbackAccount);
        if (linked) linkedProfiles += 1;
        const parsed = {
          subject: clean(item.subject), from: { text: clean(item.from) },
          to: { text: clean(item.to) }, cc: { text: clean(item.cc) },
          text: clean(item.text), html: clean(item.html),
          date: item.date ? new Date(item.date) : new Date(),
          messageId: clean(item.messageId) || `aycd:${clean(item.uid) || checked}`
        };
        const result = await saveParsedMessage(supabase, account, parsed, item.uid || checked, adjustUserCredits, confirmPendingAmazonCheckout);
        if (result?.saved) matched += 1; else ignored += 1;
        results.push({ ...(result || { ignored: true }), source_email: account.email, profile_id: account.profile_id });
      } catch (error) { results.push({ error: error.message }); }
    }
    try { await upsertScanState(supabase, fallbackAccount, { is_enabled: true, last_scan_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error: null }); } catch (_) {}
    return { checked, matched, ignored, linked_profiles: linkedProfiles, results };
  }

  app.post('/orders/aycd/pair/start', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can pair AYCD.' });
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await supabase.from('aycd_bridge_devices').delete().eq('user_id', req.user_id).eq('is_paired', false);
      const { error } = await supabase.from('aycd_bridge_devices').insert({ user_id: req.user_id, pair_code_hash: bridgeHash(code), pair_expires_at: expires, is_paired: false, status: 'waiting' });
      if (error) throw error;
      res.json({ code, expires_at: expires });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/orders/aycd/bridge/claim', async (req, res) => {
    try {
      const codeHash = bridgeHash(req.body?.code);
      const { data: row, error } = await supabase.from('aycd_bridge_devices').select('*').eq('pair_code_hash', codeHash).eq('is_paired', false).maybeSingle();
      if (error) throw error;
      if (!row || !row.pair_expires_at || new Date(row.pair_expires_at) < new Date()) return res.status(400).json({ error: 'Pairing code is invalid or expired.' });
      const secret = crypto.randomBytes(32).toString('hex');
      const { data: updated, error: ue } = await supabase.from('aycd_bridge_devices').update({
        device_secret_hash: bridgeHash(secret), device_name: clean(req.body?.device_name || 'AYCD laptop').slice(0,120), is_paired: true,
        status: 'online', last_seen_at: new Date().toISOString(), pair_code_hash: null, pair_expires_at: null
      }).eq('id', row.id).select().single();
      if (ue) throw ue;
      res.json({ success: true, device_id: updated.id, secret });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });


  app.get('/orders/aycd/bridge/accounts', async (req, res) => {
    try {
      const secret = String(req.headers['x-aycd-bridge-secret'] || '');
      const row = await getBridgeBySecret(secret);
      if (!row) return res.status(401).json({ error: 'Bridge is not paired.' });

      const accounts = new Map();
      const add = (email, priority = 50, source = 'history') => {
        email = lower(email);
        if (!email || email === 'inbox@aycd.me' || !email.includes('@')) return;
        const existing = accounts.get(email);
        if (!existing || priority < existing.priority) accounts.set(email, { email, priority, source });
      };

      // Explicit AYCD profile credentials are highest priority because these accounts
      // are actively used for order verification.
      const { data: profiles } = await supabase.from('profiles').select('id').eq('user_id', row.user_id);
      const profileIds = (profiles || []).map(p => p.id);
      for (let i = 0; i < profileIds.length; i += 75) {
        try {
          const r = await supabase.from('profile_store_credentials')
            .select('login_email,use_aycd_inbox')
            .in('profile_id', profileIds.slice(i, i + 75))
            .eq('use_aycd_inbox', true);
          for (const item of r.data || []) add(item.login_email, 1, 'profile');
        } catch (_) {}
      }

      // Historical AYCD recipients let the bridge recover and directly scan accounts
      // that are exposed in AYCD but are not currently attached to a saved profile.
      try {
        let from = 0;
        while (true) {
          const r = await supabase.from('email_messages')
            .select('mailbox_email')
            .eq('user_id', row.user_id)
            .eq('source_type', 'aycd')
            .range(from, from + 999);
          if (r.error) throw r.error;
          for (const item of r.data || []) add(item.mailbox_email, 20, 'history');
          if (!r.data || r.data.length < 1000) break;
          from += 1000;
        }
      } catch (_) {}

      res.json({ success: true, accounts: [...accounts.values()].sort((a,b) => a.priority-b.priority || a.email.localeCompare(b.email)) });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/orders/aycd/bridge/poll', async (req, res) => {
    try {
      const secret = String(req.headers['x-aycd-bridge-secret'] || '');
      const row = await getBridgeBySecret(secret);
      if (!row) return res.status(401).json({ error: 'Bridge is not paired.' });
      const now = new Date().toISOString();
      await supabase.from('aycd_bridge_devices').update({ status: 'online', last_seen_at: now }).eq('id', row.id);
      res.json({ command: row.pending_command || null, command_id: row.command_id || null, payload: row.command_payload || null });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/orders/aycd/bridge/result', async (req, res) => {
    try {
      const secret = String(req.headers['x-aycd-bridge-secret'] || '');
      const row = await getBridgeBySecret(secret);
      if (!row) return res.status(401).json({ error: 'Bridge is not paired.' });
      if (req.body?.command_id && row.command_id && req.body.command_id !== row.command_id) {
        return res.status(409).json({ error: 'This AYCD scan command is no longer active.' });
      }

      const final = req.body?.final !== false;
      let chunkSummary = { checked: 0, matched: 0, ignored: 0 };
      if (req.body?.success && Array.isArray(req.body?.messages)) {
        chunkSummary = await ingestAycdMessages(row.user_id, req.body.messages);
      }

      const previous = (Number(req.body?.chunk_index || 0) > 0 && row.last_result && !row.last_result.error)
        ? row.last_result : { checked: 0, matched: 0, ignored: 0, linked_profiles: 0, chunks_received: 0 };
      const aggregate = {
        checked: Number(previous.checked || 0) + Number(chunkSummary.checked || 0),
        matched: Number(previous.matched || 0) + Number(chunkSummary.matched || 0),
        ignored: Number(previous.ignored || 0) + Number(chunkSummary.ignored || 0),
        linked_profiles: Number(previous.linked_profiles || 0) + Number(chunkSummary.linked_profiles || 0),
        progress: req.body?.scan_progress || previous.progress || null,
        chunks_received: Number(previous.chunks_received || 0) + 1,
        chunks_total: Number(req.body?.chunk_count || 1)
      };

      const update = {
        status: req.body?.success ? (final ? 'online' : 'uploading') : 'error',
        last_seen_at: new Date().toISOString(),
        last_error: req.body?.success ? null : clean(req.body?.error || 'AYCD scan failed').slice(0,1000),
        last_result: req.body?.success ? aggregate : { error: req.body?.error || null, checked: Number(req.body?.checked || 0) }
      };
      if (final || !req.body?.success) {
        update.pending_command = null;
        update.command_payload = null;
        update.command_id = null;
        if (req.body?.success) update.last_scan_at = new Date().toISOString();
      }
      await supabase.from('aycd_bridge_devices').update(update).eq('id', row.id);
      res.json({ success: true, summary: aggregate, final });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/orders/aycd/device-status', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD.' });
    const { data, error } = await supabase.from('aycd_bridge_devices').select('*').eq('user_id', req.user_id).eq('is_paired', true).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const online = !!(data?.last_seen_at && Date.now() - new Date(data.last_seen_at).getTime() < 30000);
    res.json({ paired: !!data, online, device: data ? { id:data.id, name:data.device_name, status:data.status, last_seen_at:data.last_seen_at, last_scan_at:data.last_scan_at, last_error:data.last_error, pending_command:data.pending_command, last_result:data.last_result } : null });
  });

  app.post('/orders/aycd/scan-request', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD.' });
    const { data, error } = await supabase.from('aycd_bridge_devices').select('*').eq('user_id', req.user_id).eq('is_paired', true).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(400).json({ error: 'Pair the AYCD laptop first.' });
    const commandId = crypto.randomUUID();
    const { error: ue } = await supabase.from('aycd_bridge_devices').update({ pending_command:'scan', command_id:commandId, command_payload:{ lookbackDays:Number(req.body?.lookbackDays || 240) }, status:'scan_requested' }).eq('id', data.id);
    if (ue) return res.status(500).json({ error: ue.message });
    res.json({ success:true, command_id:commandId });
  });

  app.get('/orders/aycd-status', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD Unified Inbox.' });
    res.json({ configured: true, mode: 'local_unified_imap_bridge', requires_local_helper: true });
  });

  // The AYCD IMAP server shown in Inbox binds to 127.0.0.1. Render cannot reach that loopback
  // address, so the bundled local helper scans AYCD on the laptop and submits parsed messages here.
  app.post('/orders/aycd-bridge-ingest', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error: 'Only the super admin can use AYCD Unified Inbox.' });
    try { res.json({ success: true, ...(await ingestAycdMessages(req.user_id, req.body?.messages || [])) }); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post('/orders/reconcile-retailer-emails', auth, async (req, res) => {
    try {
      // Reprocess the already-indexed retailer archive across ALL of this user's connected
      // mailboxes. This intentionally ignores the webhook's previously guessed purchase email.
      const maxMessages=Math.max(50,Math.min(5000,Number(req.body?.max_messages||2500)));
      const archiveColumns='id,user_id,mailbox_email,source_type,subject,from_text,to_text,cc_text,body_text,body_html,snippet,received_at,message_id,imap_uid,store,linked_order_id,email_type,order_number';
      // Target can still use the normal classified archive path.
      const targetArchiveRows = await fetchRecentEmailArchiveByStore(
        supabase, req.user_id, 'target', archiveColumns, Math.min(maxMessages, 1500)
      );

      // Supreme reconciliation must search across every connected mailbox, not the purchase email
      // guessed from the webhook/profile. First scan only lightweight email metadata in the date
      // span of the Supreme checkouts, identify Supreme by sender/subject, then hydrate ONLY those
      // matching rows in small primary-key batches. This avoids both statement_timeout and the old
      // LIMIT 1000 bug that could completely miss Supreme mail on high-volume inbox accounts.
      const serviceOrdersForSupreme = await loadServiceOrders(supabase, req.user_id);
      // First search the Gmail/app-password mailboxes saved directly in Profile Builder. These are
      // not AYCD-imported accounts, so an archive-only reconciliation can legitimately see zero
      // Supreme rows even though the messages exist in Gmail.
      let supremeLive = { profile_mailboxes:0, owned_profiles:0, credential_rows:0, mailboxes_checked:0, messages_found:0, messages_saved:0, failures:0 };
      try {
        supremeLive = await discoverSupremeFromProfileBuilderMailboxes(
          supabase, req.user_id, serviceOrdersForSupreme, adjustUserCredits, confirmPendingAmazonCheckout,
          { includeImported: req.role === 'super_admin' }
        );
      } catch (e) {
        console.warn('[SUPREME PROFILE BUILDER DISCOVERY]', e.message || e);
        supremeLive = { ...supremeLive, failures:(supremeLive.failures||0)+1, debug:[`Supreme live discovery threw before completion: ${e.message || e}`] };
      }

      let supremeDiscovery = { rows: [], metadata_scanned: 0, candidates_found: 0, windows: 0 };
      try {
        supremeDiscovery = await fetchSupremeArchiveCandidatesForOrders(
          supabase, req.user_id, serviceOrdersForSupreme, archiveColumns
        );
      } catch (e) {
        console.warn('[SUPREME METADATA DISCOVERY]', e.message || e);
      }

      // Also retain already-classified Supreme rows as a fallback for very old orders outside the
      // active checkout windows. These rows are fetched by PK batches and therefore stay cheap.
      let supremeArchiveRows = [];
      try {
        supremeArchiveRows = await fetchRecentEmailArchiveByStore(
          supabase, req.user_id, 'supreme', archiveColumns, Math.min(maxMessages, 1500)
        );
      } catch (e) { console.warn('[SUPREME CLASSIFIED ARCHIVE]', e.message || e); }

      const merged = new Map();
      for (const email of [...targetArchiveRows, ...supremeArchiveRows, ...(supremeDiscovery.rows || [])]) {
        merged.set(String(email.id||email.message_id), email);
      }
      let checked=0,matched=0,ignored=0,failed=0;
      const retailerEmails=[...merged.values()].filter(email=>{
        const text=archivedRetailerReadableText(email);
        return ['target','supreme'].includes(lower(email.store)||detectStore(email.from_text||'',email.subject||'',text));
      }).sort((a,b)=>new Date(a.received_at||0)-new Date(b.received_at||0));
      let supremeRebuild = null;
      try { supremeRebuild = await rebuildSupremeBatchAssignments(supabase, req.user_id, retailerEmails); }
      catch (e) { console.warn('[SUPREME BATCH REBUILD]', e.message || e); supremeRebuild = { error:e.message || String(e) }; }
      // The targeted repair below performs the live OAuth2/IMAP lookup first. Do not start the
      // broad background scan before it, because that could occupy the historical-repair guard
      // at the exact moment the user asks to repair a damaged order. A normal scan is queued after.
      if (req.role === 'super_admin') {
        try {
          const bridge = await supabase.from('aycd_bridge_devices').select('id,pending_command').eq('user_id',req.user_id).eq('is_paired',true).order('created_at',{ascending:false}).limit(1).maybeSingle();
          if (bridge.data?.id && !clean(bridge.data.pending_command)) {
            await supabase.from('aycd_bridge_devices').update({
              pending_command:'scan', command_id:crypto.randomUUID(),
              command_payload:{ lookbackDays:365, reason:'retailer_reconciliation' },
              status:'scan_requested', last_error:null
            }).eq('id',bridge.data.id);
          }
        } catch (_) {}
      }
      for(const email of retailerEmails){
        checked++;
        try{
          const account={ user_id:req.user_id, archive_user_id:req.user_id, profile_id:null, email:lower(email.mailbox_email), provider:providerForEmail(email.mailbox_email)||{name:'archive'}, ingestion_source:email.source_type||'archive_reconcile' };
          const parsed={ subject:email.subject||'', from:{text:email.from_text||''}, to:{text:email.to_text||''}, cc:{text:email.cc_text||''}, text:archivedRetailerReadableText(email), html:email.body_html||null, date:new Date(email.received_at||Date.now()), messageId:email.message_id };
          const result=await saveParsedMessage(supabase,account,parsed,email.imap_uid||0,adjustUserCredits,confirmPendingAmazonCheckout);
          if(result?.saved)matched++; else ignored++;
        }catch(e){ failed++; console.warn('[RECONCILE ARCHIVE]',email.id,e.message||e); }
      }
      // Prioritize orders whose archived Target event is visibly the broken preheader-only copy.
      // These may be much older than the newest 100 orders and therefore must be named explicitly.
      // Build the repair set from the full Target archive, not only the newest maxMessages window.
      // Also include canceled Target orders: a cancellation may apply only to a filler item while the
      // main item shipped/delivered, which is exactly the case manual reconciliation must re-check live.
      // Count an order as damaged only when its CURRENT linked Target archive still lacks any
      // readable/full message body. Older broken preheader-only rows are intentionally retained for
      // audit history, so simply seeing one bad historical row must not make the same order appear
      // damaged forever after a later live IMAP repair saved a good MIME copy.
      const targetRowsForDamage = [];
      for (const email of retailerEmails) if (lower(email.store) === 'target' && email.linked_order_id) targetRowsForDamage.push(email);
      try {
        const allTarget = await fetchAllSupabaseRows(() => supabase.from('email_messages')
          .select('id,linked_order_id,store,body_text,body_html,snippet,subject,email_type,received_at')
          .eq('user_id', req.user_id).eq('store','target').not('linked_order_id','is',null), 250);
        targetRowsForDamage.push(...allTarget);
      } catch (e) { console.warn('[RECONCILE FULL TARGET DAMAGE QUERY]', e.message || e); }

      const targetByOrder = new Map();
      for (const email of targetRowsForDamage) {
        const id = String(email.linked_order_id || '');
        if (!id) continue;
        if (!targetByOrder.has(id)) targetByOrder.set(id, []);
        targetByOrder.get(id).push(email);
      }
      const damagedSet = new Set();
      for (const [orderId, rows] of targetByOrder.entries()) {
        const hasBroken = rows.some(archivedTargetBodyNeedsRepair);
        const hasReadable = rows.some(row => !archivedTargetBodyNeedsRepair(row) && archivedRetailerReadableText(row).length >= 180);
        if (hasBroken && !hasReadable) damagedSet.add(orderId);
      }

      // Do NOT blanket-prioritize every legitimately canceled Target order. Canceled rows are only
      // repair candidates when they are still unresolved/missing retailer evidence. Once item-level
      // reconciliation has a readable confirmation/cancellation/shipment history, it is fixed and
      // should disappear from the damaged count on subsequent scans.
      try {
        const canceled = await fetchAllSupabaseRows(() => supabase.from('tracked_orders')
          .select('id,reconciliation_status,reconciliation_note').eq('user_id',req.user_id).eq('store','target').eq('status','canceled'));
        for (const order of canceled) {
          const rs = lower(order.reconciliation_status || '');
          if (order.id && ['pending','main_item_missing',''].includes(rs) && !targetByOrder.has(String(order.id))) damagedSet.add(String(order.id));
        }
      } catch (e) { console.warn('[RECONCILE CANCELED TARGET QUERY]', e.message || e); }
      const damagedLinkedOrderIds = [...damagedSet];
      let repair = null;
      try {
        const requested = Math.max(Number(req.body?.repair_orders || 100), damagedLinkedOrderIds.length);
        repair = await runHistoricalOrderEmailRepair(supabase, req.user_id, adjustUserCredits, confirmPendingAmazonCheckout, {
          maxOrders: Math.min(500, requested), forceLinked: true, priorityOrderIds: damagedLinkedOrderIds,
          // A manual repair is allowed to run beside the scheduled background repair. All writes
          // are keyed/upserted by message/order identity, so this avoids a false skip safely.
          allowConcurrent: true
        });
      } catch (repairError) {
        console.warn('[RECONCILE TARGETED REPAIR]', repairError.message || repairError);
      }
      // Now queue the ordinary catch-up scan for anything that was not part of the targeted set.
      try { startUserScanJob(supabase,req.user_id,adjustUserCredits,confirmPendingAmazonCheckout); } catch (_) {}
      res.json({success:true,checked,matched,ignored,failed,supreme_rebuild:supremeRebuild,supreme_live:supremeLive,supreme_debug:[...(supremeLive?.debug||[]), ...serviceOrdersForSupreme.map((o,i)=>`Service order ${i+1}: id=${o.id} site=${o.site||'-'} metadata.site=${o.metadata?.site||'-'} payload site/store=${extractNamedPayloadValue(o.raw_payload||{},['site','store'])||'-'} normalized=${normalizeStoreKey(o.site || o.metadata?.site || extractNamedPayloadValue(o.raw_payload||{},['site','store']))||'-'}`)],supreme_discovery:{metadata_scanned:supremeDiscovery?.metadata_scanned||0,candidates_found:supremeDiscovery?.candidates_found||0,windows:supremeDiscovery?.windows||0},damaged_target_orders:damagedLinkedOrderIds.length,repair,message:`Rebuilt ${supremeRebuild?.assigned||0} Supreme confirmation assignment(s), discovered ${supremeDiscovery?.candidates_found||0} Supreme email(s) across all connected mailbox archives, reprocessed ${checked} Target/Supreme retailer emails, then performed a direct live OAuth2/IMAP repair for ${damagedLinkedOrderIds.length} damaged Target order(s).`});
    } catch(error){ res.status(500).json({error:error.message}); }
  });

  app.post('/orders/check-tracking', auth, async (req,res)=>{
    try {
      const result=await checkEasyPostDelivered(supabase, req.user_id);
      res.json({success:true,...result});
    } catch(e){res.status(500).json({error:e.message||String(e)});}
  });

  app.post('/orders/scan/start', auth, async (req, res) => {
    try {
      const job = startUserScanJob(supabase, req.user_id, adjustUserCredits, confirmPendingAmazonCheckout);
      res.status(job.status === 'running' ? 202 : 200).json({ success: true, job: scanJobView(job) });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/orders/scan-progress', auth, async (req, res) => {
    const job = userScanJobs.get(String(req.user_id));
    res.json({ job: scanJobView(job) });
  });

  app.post('/orders/scan', auth, async (req, res) => {
    try { res.json({ success: true, ...(await scanAll(supabase, req.user_id, adjustUserCredits, null, confirmPendingAmazonCheckout)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/orders/repair-historical-emails', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    try {
      // This is deliberately a targeted IMAP search by recovered checkout email + retailer
      // order number. It does NOT reset mailbox checkpoints or re-download every message.
      const maxOrders = Math.max(1, Math.min(100, Number(req.body?.max_orders || 50)));
      const result = await runHistoricalOrderEmailRepair(supabase, null, adjustUserCredits, confirmPendingAmazonCheckout, { maxOrders });
      res.json({ success:true, ...result });
    } catch (e) { res.status(500).json({ error:e.message }); }
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
    // Read only. Email scanning and service-order synchronization happen in background workers.
    let q = supabase.from('tracked_orders').select('*, tracked_order_events(*)')
      .eq('user_id', req.user_id).order('order_date', { ascending:false }).limit(1000);
    if (req.query.status) q = q.eq('status', clean(req.query.status));
    if (req.query.year) {
      const y = Number(req.query.year);
      q = q.gte('order_date', `${y}-01-01T00:00:00Z`).lt('order_date', `${y+1}-01-01T00:00:00Z`);
    }
    let { data, error } = await q;
    if (error && /relationship|schema cache/i.test(String(error.message || ''))) {
      q = supabase.from('tracked_orders').select('*').eq('user_id', req.user_id).order('order_date', { ascending:false }).limit(1000);
      if (req.query.status) q = q.eq('status', clean(req.query.status));
      if (req.query.year) { const y=Number(req.query.year); q=q.gte('order_date',`${y}-01-01T00:00:00Z`).lt('order_date',`${y+1}-01-01T00:00:00Z`); }
      ({data,error}=await q);
    }
    if (error) return res.status(500).json({ error:error.message });
    const orders = await decorateTrackedOrdersWithEmails(req.user_id, data || []);
    const summary = orders.reduce((a,o) => { a.total += Number(o.total || 0); a[o.status]=(a[o.status]||0)+1; return a; }, {total:0});
    summary.success_rate = orders.length ? Math.round(((summary.confirmed || 0)+(summary.processing || 0)+(summary.shipped || 0)+(summary.delivered || 0))/orders.length*1000)/10 : 0;
    res.json({ orders, summary, background_scanning: process.env.IMAP_ORDER_TRACKER_ENABLED !== 'false' });
  });


  app.patch('/orders/tracked/:id', auth, async (req, res) => {
    const allowed = ['status','credits_spent','product_summary','total','subtotal','tax','shipping','tracking_number','carrier'];
    const patch = {}; for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('tracked_orders').update(patch).eq('id', req.params.id).eq('user_id', req.user_id).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // A manual status correction must immediately propagate to Investment Value too.
    // Canceled/refunded orders are kept for audit/order-history purposes, but are not
    // part of the user's live collection or portfolio totals.
    if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
      const inactive = ['canceled','refunded'].includes(lower(data.status));
      const investmentPatch = {
        is_active: !inactive,
        canceled_at: inactive ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      await supabase.from('investment_products')
        .update(investmentPatch)
        .eq('user_id', req.user_id)
        .eq('order_id', data.id);
    }

    res.json({ order: data });
  });

  app.delete('/orders/tracked/:id', auth, async (req, res) => {
    const { error } = await supabase.from('tracked_orders').delete().eq('id', req.params.id).eq('user_id', req.user_id);
    if (error) return res.status(500).json({ error: error.message }); res.json({ success: true });
  });


  app.get('/orders/emails/:id', auth, async (req, res) => {
    const { data: order, error: orderError } = await supabase.from('tracked_orders').select('*').eq('id', req.params.id).eq('user_id', req.user_id).maybeSingle();
    if (orderError || !order) return res.status(404).send('Order not found');
    const requestedType = lower(req.query.type || 'all');
    const allowedTypes = new Set(['all','confirmed','processing','shipped','delivered','canceled','refunded']);
    const type = allowedTypes.has(requestedType) ? requestedType : 'all';
    let emails = [];
    try {
      const { data, error } = await supabase.from('tracked_order_emails')
        .select('event_type,event_at,email_messages(*)')
        .eq('order_id', order.id)
        .order('event_at', { ascending:true });
      if (!error) {
        emails = (data || []).map(row => ({ ...(row.email_messages || {}), event_type: row.event_type, event_at: row.event_at }))
          .filter(e => e.id);
      }
    } catch (_) {}
    if (!emails.length) {
      try {
        const { data } = await supabase.from('email_messages').select('*').eq('linked_order_id', order.id).order('received_at', { ascending:true });
        emails = data || [];
      } catch (_) {}
    }
    if (type !== 'all') emails = emails.filter(e => lower(e.event_type || e.email_type) === type);

    // Old records created before full email-body storage may only have the confirmation body on
    // tracked_orders. Keep that available rather than showing an empty page.
    if (!emails.length && (type === 'all' || type === 'confirmed') && (order.receipt_html || order.receipt_text)) {
      emails = [{
        subject: order.raw_subject || `${order.store} order confirmation`,
        received_at: order.order_date,
        email_type: 'confirmed', event_type: 'confirmed', mailbox_email: order.source_email,
        body_html: order.receipt_html, body_text: order.receipt_text,
        snippet: order.receipt_text
      }];
    }

    const labelMap = { confirmed:'Confirmed receipt', processing:'Processing update', shipped:'Shipping / tracking confirmation', delivered:'Delivered confirmation', canceled:'Cancellation', refunded:'Refund confirmation', all:'All order emails' };
    const cards = emails.map((e, i) => {
      const eventType = lower(e.event_type || e.email_type || 'unknown');
      const body = e.body_html || (e.body_text ? `<pre>${htmlEscape(e.body_text)}</pre>` : `<pre>${htmlEscape(e.snippet || 'Full body was not stored for this older message. Re-scanning this mailbox will backfill it.')}</pre>`);
      return `<section class="email-card"><div class="email-meta"><span class="email-type email-${htmlEscape(eventType)}">${htmlEscape(labelMap[eventType] || eventType)}</span><h2>${htmlEscape(e.subject || 'Order email')}</h2><div><b>Mailbox:</b> ${htmlEscape(e.mailbox_email || order.source_email || '')}</div><div><b>Received:</b> ${htmlEscape(e.received_at || e.event_at || '')}</div></div><div class="email-body">${body}</div></section>`;
    }).join('');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(labelMap[type])} — ${htmlEscape(order.order_number)}</title><style>body{font-family:Arial,sans-serif;max-width:980px;margin:28px auto;padding:18px;color:#111827;background:#f3f6fb}.top{position:sticky;top:0;background:#f3f6fb;padding:8px 0 14px;z-index:3}.email-card{background:white;border:1px solid #dbe3ef;border-radius:16px;padding:18px;margin:14px 0}.email-meta{border-bottom:1px solid #e5e7eb;padding-bottom:12px;margin-bottom:16px}.email-meta h2{margin:8px 0}.email-type{display:inline-block;padding:5px 9px;border-radius:999px;background:#e2e8f0;font-weight:700;font-size:12px}.email-confirmed{background:#dbeafe}.email-shipped{background:#1e3a8a;color:white}.email-delivered{background:#dcfce7}.email-canceled,.email-refunded{background:#fee2e2}.email-body{overflow-wrap:anywhere}.email-body img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media print{.top{display:none}.email-card{break-inside:avoid}}</style></head><body><div class="top"><button onclick="print()">Print / Save as PDF</button> <b>${htmlEscape(order.store.toUpperCase())} · ${htmlEscape(order.order_number)}</b> — ${htmlEscape(labelMap[type])} (${emails.length})</div>${cards || '<section class="email-card">No matching email has been linked to this order yet.</section>'}</body></html>`);
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

  // Super-admin Email Center: lightweight AYCD/direct-IMAP metadata, manual linking, and retention cleanup.
  app.get('/admin/email-center', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(10, Math.min(200, Number(req.query.limit || 75)));
    const from = (page - 1) * limit, to = from + limit - 1;
    let q = supabase.from('email_messages').select('*', { count:'exact' }).eq('user_id', req.user_id);
    // Hidden mailboxes remain indexed and continue updating orders, but are excluded from the Email Center view.
    try {
      const { data: hiddenRows } = await supabase.from('email_center_hidden_mailboxes').select('mailbox_email').eq('user_id', req.user_id).eq('is_hidden', true);
      const hidden = (hiddenRows || []).map(r => lower(r.mailbox_email)).filter(Boolean);
      if (hidden.length) {
        const encoded = `(${hidden.map(v => `"${String(v).replace(/"/g,'')}"`).join(',')})`;
        q = q.not('mailbox_email', 'in', encoded);
      }
    } catch (_) {}
    if (req.query.type && req.query.type !== 'all') q = q.eq('email_type', clean(req.query.type));
    if (req.query.store && req.query.store !== 'all') q = q.eq('store', clean(req.query.store));
    if (req.query.mailbox && req.query.mailbox !== 'all') q = q.eq('mailbox_email', lower(req.query.mailbox));
    if (req.query.source && req.query.source !== 'all') q = q.eq('source_type', clean(req.query.source));
    if (req.query.linked === 'yes') q = q.not('linked_order_id','is',null);
    if (req.query.linked === 'no') q = q.is('linked_order_id',null);
    const term = clean(req.query.q);
    if (term) q = q.or(`subject.ilike.%${term.replace(/[,%]/g,'')}%,from_text.ilike.%${term.replace(/[,%]/g,'')}%,mailbox_email.ilike.%${term.replace(/[,%]/g,'')}%,order_number.ilike.%${term.replace(/[,%]/g,'')}%,snippet.ilike.%${term.replace(/[,%]/g,'')}%`);
    const { data, error, count } = await q.order('received_at',{ascending:false}).range(from,to);
    if (error) return res.status(500).json({error:error.message});
    // Supabase returns at most 1,000 rows per request by default. The Email Center can
    // contain 10k+ AYCD messages, so build summary counts in paged reads instead of
    // silently stopping at 1,000.
    const summary={total:0,linked:0,kept:0};
    for(let offset=0;;offset+=1000){
      const sr=await supabase.from('email_messages').select('email_type,linked_order_id,keep_forever').eq('user_id',req.user_id).range(offset,offset+999);
      if(sr.error) return res.status(500).json({error:sr.error.message});
      for(const e of sr.data||[]){summary.total++;summary[e.email_type]=(summary[e.email_type]||0)+1;if(e.linked_order_id)summary.linked++;if(e.keep_forever)summary.kept++;}
      if(!sr.data || sr.data.length<1000) break;
    }
    res.json({emails:data||[],count:count||0,page,limit,summary});
  });

  app.get('/admin/email-center/mailboxes', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    try{
      const rows=[];
      for(let offset=0;;offset+=1000){
        const r=await supabase.from('email_messages').select('mailbox_email,source_type,received_at').eq('user_id',req.user_id).range(offset,offset+999);
        if(r.error) throw r.error;
        rows.push(...(r.data||[]));
        if(!r.data || r.data.length<1000) break;
      }
      let hiddenRows=[];
      try{const r=await supabase.from('email_center_hidden_mailboxes').select('mailbox_email,is_hidden').eq('user_id',req.user_id);hiddenRows=r.data||[];}catch(_){}
      const hidden=new Set(hiddenRows.filter(r=>r.is_hidden).map(r=>lower(r.mailbox_email)));
      const map=new Map();
      for(const row of rows||[]){
        const email=lower(row.mailbox_email)||'inbox@aycd.me';
        const source=clean(row.source_type)||'legacy';
        const key=`${source}:${email}`;
        const current=map.get(key)||{mailbox_email:email,source_type:source,count:0,last_received_at:null,hidden:hidden.has(email)};
        current.count++;
        if(!current.last_received_at || String(row.received_at||'')>String(current.last_received_at||'')) current.last_received_at=row.received_at;
        map.set(key,current);
      }
      // Include configured direct IMAP accounts even if they have no indexed messages yet.
      try{
        const accounts=await loadScanAccounts(supabase,req.user_id);
        for(const account of accounts||[]){
          const email=lower(account.email); if(!email) continue;
          const key=`direct_imap:${email}`;
          if(!map.has(key)) map.set(key,{mailbox_email:email,source_type:'direct_imap',count:0,last_received_at:null,hidden:hidden.has(email)});
        }
      }catch(_){}
      const aycdKey='aycd:inbox@aycd.me';
      if(!map.has(aycdKey)) map.set(aycdKey,{mailbox_email:'inbox@aycd.me',source_type:'aycd',count:0,last_received_at:null,hidden:hidden.has('inbox@aycd.me')});
      const mailboxes=[...map.values()].sort((a,b)=>String(a.source_type).localeCompare(String(b.source_type))||String(a.mailbox_email).localeCompare(String(b.mailbox_email)));
      res.json({mailboxes});
    }catch(error){res.status(500).json({error:error.message});}
  });

  app.get('/admin/email-center/orders', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const term=clean(req.query.q); let q=supabase.from('tracked_orders').select('id,store,order_number,status,product_summary,source_email,order_date').eq('user_id',req.user_id);
    if(term) q=q.or(`order_number.ilike.%${term.replace(/[,%]/g,'')}%,product_summary.ilike.%${term.replace(/[,%]/g,'')}%,source_email.ilike.%${term.replace(/[,%]/g,'')}%`);
    const {data,error}=await q.order('order_date',{ascending:false}).limit(100); if(error)return res.status(500).json({error:error.message}); res.json({orders:data||[]});
  });

  app.post('/admin/email-center/:id/link', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {data:email,error:ee}=await supabase.from('email_messages').select('*').eq('id',req.params.id).eq('user_id',req.user_id).maybeSingle();
    if(ee||!email)return res.status(404).json({error:ee?.message||'Email not found'});
    const {data:order,error:oe}=await supabase.from('tracked_orders').select('*').eq('id',req.body?.order_id).eq('user_id',req.user_id).maybeSingle();
    if(oe||!order)return res.status(404).json({error:oe?.message||'Order not found'});
    const status=['confirmed','processing','shipped','delivered','canceled','refunded'].includes(email.email_type)?email.email_type:order.status;
    const patch={linked_order_id:order.id,is_order_related:true,keep_forever:true,order_number:email.order_number||order.order_number,updated_at:new Date().toISOString()};
    await supabase.from('email_messages').update(patch).eq('id',email.id);
    if(status!==order.status) await supabase.from('tracked_orders').update({status,last_status_at:email.received_at||new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',order.id);
    res.json({success:true,status});
  });

  app.post('/admin/email-center/:id/unlink', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {error}=await supabase.from('email_messages').update({linked_order_id:null,updated_at:new Date().toISOString()}).eq('id',req.params.id).eq('user_id',req.user_id);
    if(error)return res.status(500).json({error:error.message});res.json({success:true});
  });

  app.post('/admin/email-center/cleanup', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const days=Math.max(0,Math.min(3650,Number(req.body?.older_than_days||30)));
    const cutoff=new Date(Date.now()-days*86400000).toISOString();
    let q=supabase.from('email_messages').delete({count:'exact'}).eq('user_id',req.user_id).eq('keep_forever',false).is('linked_order_id',null);
    if(days>0) q=q.lt('received_at',cutoff);
    const {error,count}=await q; if(error)return res.status(500).json({error:error.message});res.json({success:true,deleted:count||0});
  });


  app.get('/admin/email-center/maintenance', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    try{
      const {data:messages,error}=await supabase.from('email_messages').select('mailbox_email,is_order_related,keep_forever,linked_order_id').eq('user_id',req.user_id);
      if(error) throw error;
      let hiddenRows=[];
      try{const r=await supabase.from('email_center_hidden_mailboxes').select('mailbox_email,is_hidden').eq('user_id',req.user_id);hiddenRows=r.data||[];}catch(_){ }
      const hiddenSet=new Set(hiddenRows.filter(r=>r.is_hidden).map(r=>lower(r.mailbox_email)));
      const byMailbox=new Map();
      let total=0,orderRelated=0,temporary=0,linked=0;
      for(const m of messages||[]){
        total++;
        if(m.is_order_related||m.keep_forever) orderRelated++; else temporary++;
        if(m.linked_order_id) linked++;
        const key=lower(m.mailbox_email)||'aycd unified inbox';
        const row=byMailbox.get(key)||{mailbox_email:key,count:0,order_related:0,temporary:0,hidden:hiddenSet.has(key)};
        row.count++; if(m.is_order_related||m.keep_forever) row.order_related++; else row.temporary++;
        byMailbox.set(key,row);
      }
      let bridge=null;
      try{const r=await supabase.from('aycd_bridge_devices').select('id,device_name,status,last_seen_at,last_scan_at,last_error,pending_command').eq('user_id',req.user_id).eq('is_paired',true).order('created_at',{ascending:false}).limit(1).maybeSingle();bridge=r.data||null;}catch(_){ }
      res.json({summary:{total,order_related:orderRelated,temporary,linked},mailboxes:[...byMailbox.values()].sort((a,b)=>b.count-a.count),bridge});
    }catch(error){res.status(500).json({error:error.message});}
  });

  app.post('/admin/email-center/clear-all', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {error,count}=await supabase.from('email_messages').delete({count:'exact'}).eq('user_id',req.user_id);
    if(error)return res.status(500).json({error:error.message});
    res.json({success:true,deleted:count||0});
  });

  app.post('/admin/email-center/clear-non-order', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {error,count}=await supabase.from('email_messages').delete({count:'exact'}).eq('user_id',req.user_id).eq('is_order_related',false).eq('keep_forever',false).is('linked_order_id',null);
    if(error)return res.status(500).json({error:error.message});
    res.json({success:true,deleted:count||0});
  });

  app.post('/admin/email-center/mailbox-visibility', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const mailbox=lower(req.body?.mailbox_email);
    if(!mailbox)return res.status(400).json({error:'Mailbox email is required.'});
    const row={user_id:req.user_id,mailbox_email:mailbox,is_hidden:!!req.body?.hidden,updated_at:new Date().toISOString()};
    const {error}=await supabase.from('email_center_hidden_mailboxes').upsert(row,{onConflict:'user_id,mailbox_email'});
    if(error)return res.status(500).json({error:error.message});
    res.json({success:true,mailbox_email:mailbox,hidden:row.is_hidden});
  });

  app.post('/admin/email-center/reset-aycd', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {data,error}=await supabase.from('aycd_bridge_devices').select('*').eq('user_id',req.user_id).eq('is_paired',true).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if(error)return res.status(500).json({error:error.message});
    if(!data)return res.status(400).json({error:'No paired AYCD bridge was found.'});
    const commandId=crypto.randomUUID();
    const {error:ue}=await supabase.from('aycd_bridge_devices').update({pending_command:'reset_checkpoint',command_id:commandId,command_payload:{requested_at:new Date().toISOString()},status:'reset_requested',last_error:null}).eq('id',data.id);
    if(ue)return res.status(500).json({error:ue.message});
    res.json({success:true,command_id:commandId,message:'Reset requested. Keep the local AYCD bridge open until it confirms the checkpoint was cleared.'});
  });

  app.post('/admin/email-center/backfill-order-events', auth, async (req,res)=>{
    if(req.role!=='super_admin') return res.status(403).json({error:'Super admin only.'});
    const {data:events,error}=await supabase.from('tracked_order_events').select('*,tracked_orders(store,order_number)').eq('user_id',req.user_id).order('event_at',{ascending:true});
    if(error)return res.status(500).json({error:error.message}); let saved=0;
    for(const e of events||[]){const row={user_id:req.user_id,message_id:e.message_id||`event:${e.id}`,mailbox_email:lower(e.source_email),from_text:'',to_text:lower(e.source_email),subject:clean(e.subject),received_at:e.event_at,email_type:e.status||'unknown',store:e.tracked_orders?.store||'unknown',order_number:e.tracked_orders?.order_number||null,snippet:clean(e.body_excerpt).slice(0,600),linked_order_id:e.order_id,is_order_related:true,keep_forever:true,updated_at:new Date().toISOString()};const r=await supabase.from('email_messages').upsert(row,{onConflict:'user_id,message_id'});if(!r.error)saved++;}
    res.json({success:true,saved});
  });

  app.get('/investment', auth, async (req, res) => {
    // Keep canceled/refunded purchases in the database for audit/history, but never
    // return them as part of the active investment collection. Legacy/manual rows
    // may have is_active=NULL, so NULL is treated as active for compatibility.
    const { data, error } = await supabase.from('investment_products').select('*').eq('user_id', req.user_id).or('is_active.is.null,is_active.eq.true').order('created_at', { ascending:false });
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
    setTimeout(() => scanAll(supabase, null, adjustUserCredits, null, confirmPendingAmazonCheckout).catch(e => console.error('Initial IMAP order scan failed:', e.message)), 30000);
    setInterval(() => scanAll(supabase, null, adjustUserCredits, null, confirmPendingAmazonCheckout).catch(e => console.error('Scheduled IMAP order scan failed:', e.message)), SCAN_INTERVAL_MS);

    // Slowly repair historical orders whose checkout email was recovered after their normal
    // IMAP checkpoint had already moved past the old message. The repair searches only for the
    // exact retailer order number inside the exact recovered mailbox, so it is inexpensive and
    // does not force a full mailbox-history reset.
    setTimeout(() => runHistoricalOrderEmailRepair(supabase, null, adjustUserCredits, confirmPendingAmazonCheckout, { maxOrders:10 })
      .catch(e => console.error('Initial historical order-email repair failed:', e.message)), 90000);
    setInterval(() => runHistoricalOrderEmailRepair(supabase, null, adjustUserCredits, confirmPendingAmazonCheckout, { maxOrders:10 })
      .catch(e => console.error('Scheduled historical order-email repair failed:', e.message)), Math.max(15 * 60 * 1000, SCAN_INTERVAL_MS * 2));
  }
  if (clean(process.env.EASYPOST_API_KEY)) {
    setTimeout(() => checkEasyPostDelivered(supabase).catch(e => console.error('Initial tracking verification failed:', e.message)), 60000);
    setInterval(() => checkEasyPostDelivered(supabase).catch(e => console.error('Scheduled tracking verification failed:', e.message)), Math.max(15 * 60 * 1000, Number(process.env.TRACKING_SCAN_INTERVAL_MS || 30 * 60 * 1000)));
  }
}

module.exports = { registerOrderTracker, scanAll, notifyCheckoutForOrderTracker };
