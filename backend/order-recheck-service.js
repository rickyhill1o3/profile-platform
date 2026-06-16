process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function loadImapFlow() {
  try {
    return require('imapflow').ImapFlow;
  } catch (err) {
    throw new Error('IMAP package is not installed on the server. Render did not install imapflow. Redeploy with a clean build cache or run: npm install imapflow --package-lock=false');
  }
}

const DEBUG_ROOT = path.join(__dirname, 'order-recheck-debug');
const SESSION_ROOT = path.join(__dirname, 'order-recheck-sessions');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function safeName(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown'; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function text(v) { return String(v || '').trim(); }
function lc(v) { return text(v).toLowerCase(); }

function getDiscordField(payload, name) {
  const embeds = Array.isArray(payload?.embeds) ? payload.embeds : [];
  for (const embed of embeds) {
    const fields = Array.isArray(embed?.fields) ? embed.fields : [];
    const found = fields.find((f) => lc(f?.name) === lc(name));
    if (found) return text(found.value).replace(/^\|\|/, '').replace(/\|\|$/, '').trim();
  }
  return '';
}

function stripDiscordSpoiler(value) {
  return text(value).replace(/^\|\|/, '').replace(/\|\|$/, '').trim();
}

function payloadToString(payload) {
  try { return JSON.stringify(payload || {}); } catch (_) { return ''; }
}

function extractEmailPasswordFromString(value) {
  const raw = stripDiscordSpoiler(value);
  if (!raw) return null;
  // Most bot webhooks show account as email:password. Passwords may contain punctuation,
  // so only split on the first separator after a valid email address.
  const match = raw.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*(?::|\||,|\s+)\s*([^\s|,]+(?:[^\n\r|,]*[^\s|,])?)/i);
  if (!match) return null;
  return { email: text(match[1]), password: text(match[2]).replace(/^\|\|/, '').replace(/\|\|$/, '').trim() };
}

function normalizeOrderPayload(order) {
  const payload = order?.raw_payload && typeof order.raw_payload === 'object' ? order.raw_payload : {};
  const accountRaw = stripDiscordSpoiler(getDiscordField(payload, 'Account') || payload.account_email || payload.account || payload.email || order?.user_email);
  const accountPair = extractEmailPasswordFromString(accountRaw) || extractEmailPasswordFromString(payloadToString(payload));

  return {
    orderNumber: text(order?.external_order_id || getDiscordField(payload, 'Order ID') || payload.external_order_id || payload.order_id || payload.order_number),
    productName: text(order?.product_name || getDiscordField(payload, 'Product') || payload.product_name || payload.product),
    sku: text(order?.sku || getDiscordField(payload, 'SKU') || payload.sku),
    expectedQuantity: Number(order?.quantity || getDiscordField(payload, 'Quantity') || payload.quantity || 0) || 0,
    accountEmail: text((accountPair && accountPair.email) || accountRaw),
    accountPassword: text((accountPair && accountPair.password) || payload.account_password || payload.password || getDiscordField(payload, 'Password')),
    proxy: stripDiscordSpoiler(order?.proxy || payload.proxy || getDiscordField(payload, 'Proxy')),
    site: lc(order?.source || getDiscordField(payload, 'Site') || payload.site || payload.source),
    rawAccount: accountRaw
  };
}

function parseProxy(proxyRaw) {
  const value = text(proxyRaw).replace(/^\|\|/, '').replace(/\|\|$/, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || /^socks/i.test(value)) {
    try {
      const u = new URL(value);
      return {
        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || '')
      };
    } catch (_) {
      return { server: value };
    }
  }
  const parts = value.split(':');
  if (parts.length >= 4) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts.slice(3).join(':') };
  }
  if (parts.length >= 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return null;
}

function proxyServerForChrome(proxy) {
  if (!proxy?.server) return '';
  // Chrome's --proxy-server flag wants scheme://host:port, without auth.
  try {
    const u = new URL(proxy.server);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch (_) {
    return proxy.server;
  }
}

function browserlessExternalProxyParam(proxy) {
  if (!proxy?.server) return '';
  try {
    const u = new URL(proxy.server);
    const user = proxy.username ? encodeURIComponent(proxy.username) : '';
    const pass = proxy.password ? encodeURIComponent(proxy.password) : '';
    const auth = user ? `${user}:${pass}@` : '';
    return `${u.protocol}//${auth}${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch (_) {
    return proxy.server;
  }
}

function browserlessEndpointWithLaunchOptions(endpoint, normalized, proxy, log = () => {}) {
  const base = text(endpoint);
  if (!base) return base;

  const args = [
    '--window-size=1280,800',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=en-US'
  ];

  // Browserless hosted BaaS v2 does not reliably honor --proxy-server inside
  // launch.args for external authenticated proxies. Use Browserless' documented
  // externalProxyServer query parameter so Browserless routes the session before
  // the first navigation. Credentials are embedded in that parameter.
  const externalProxyServer = browserlessExternalProxyParam(proxy);
  if (externalProxyServer) {
    log(`Browserless externalProxyServer will use order proxy: ${proxy.server}${proxy.username ? ' with auth' : ''}`);
  } else {
    log('No order proxy found for Browserless launch; Target may see the Browserless datacenter IP.');
  }

  const launch = {
    headless: String(process.env.ORDER_RECHECK_HEADLESS || 'true').toLowerCase() !== 'false',
    args
  };

  const rawBrowserlessTimeout =
    process.env.ORDER_RECHECK_BROWSERLESS_TIMEOUT_MS ||
    process.env.ORDER_RECHECK_TIMEOUT_MS ||
    process.env.ORDER_RECHECK_TOTAL_TIMEOUT_MS ||
    '60000';
  let browserlessTimeout = Number.parseInt(String(rawBrowserlessTimeout), 10);
  if (!Number.isFinite(browserlessTimeout) || browserlessTimeout < 1) browserlessTimeout = 60000;
  if (browserlessTimeout > 60000) browserlessTimeout = 60000;
  log(`Browserless connect timeout parameter: ${browserlessTimeout}`);

  const url = new URL(base);
  // Preserve the user's token from BROWSERLESS_CDP_ENDPOINT, but remove stale
  // params from previous deploys that caused Browserless 400 responses.
  const keepToken = url.searchParams.get('token');
  url.search = '';
  if (keepToken) url.searchParams.set('token', keepToken);
  url.searchParams.set('timeout', String(browserlessTimeout));
  url.searchParams.set('launch', JSON.stringify(launch));
  if (externalProxyServer) url.searchParams.set('externalProxyServer', externalProxyServer);
  return url.toString();
}

async function attachProxyAuthIfNeeded(page, proxy, log = () => {}) {
  if (!proxy?.username || !proxy?.password) return;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Fetch.enable', { handleAuthRequests: true });
    client.on('Fetch.authRequired', async (event) => {
      try {
        await client.send('Fetch.continueWithAuth', {
          requestId: event.requestId,
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: proxy.username,
            password: proxy.password
          }
        });
      } catch (_) {}
    });
    client.on('Fetch.requestPaused', async (event) => {
      try { await client.send('Fetch.continueRequest', { requestId: event.requestId }); } catch (_) {}
    });
    log('Proxy authentication handler attached for this browser page.');
  } catch (err) {
    log(`Could not attach proxy authentication handler: ${err.message || err}`);
  }
}

function publicDebugPath(abs) {
  const rel = path.relative(DEBUG_ROOT, abs).replace(/\\/g, '/');
  return `/admin/order-recheck-debug/${rel}`;
}

function makeDebug(orderNumber) {
  ensureDir(DEBUG_ROOT);
  const runId = `${Date.now()}-${safeName(orderNumber)}`;
  const dir = ensureDir(path.join(DEBUG_ROOT, runId));
  const artifacts = [];
  let step = 0;
  return {
    runId,
    dir,
    artifacts,
    async shot(page, label) {
      step += 1;
      const file = path.join(dir, `${String(step).padStart(2, '0')}-${safeName(label)}.png`);
      try { await page.screenshot({ path: file, fullPage: true }); artifacts.push({ type: 'screenshot', label, url: publicDebugPath(file) }); } catch (_) {}
    },
    async html(page, label) {
      const file = path.join(dir, `${String(step).padStart(2, '0')}-${safeName(label)}.html`);
      try { fs.writeFileSync(file, await page.content(), 'utf8'); artifacts.push({ type: 'html', label, url: publicDebugPath(file) }); } catch (_) {}
    },
    writeLog(lines) {
      const file = path.join(dir, 'log.txt');
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      const url = publicDebugPath(file);
      if (!artifacts.some((a) => a.url === url)) artifacts.push({ type: 'log', label: 'Log', url });
    },
    appendLog(line) {
      const file = path.join(dir, 'log.txt');
      fs.appendFileSync(file, line + '\n', 'utf8');
      const url = publicDebugPath(file);
      if (!artifacts.some((a) => a.url === url)) artifacts.push({ type: 'log', label: 'Live Log', url });
    }
  };
}

async function firstVisible(page, selectors, timeout = 3000) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch (_) {}
  }
  return null;
}

async function clickByText(page, patterns, timeout = 1500) {
  for (const pattern of patterns) {
    try {
      const loc = page.getByText(pattern, { exact: false }).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout: 5000 });
      return true;
    } catch (_) {}
  }
  return false;
}

async function getTargetOtpFromImap({ email, appPassword, sinceMs = Date.now() - 10 * 60 * 1000, timeoutMs = Number(process.env.ORDER_RECHECK_OTP_TIMEOUT_MS || 60000), log = () => {} }) {
  if (!email || !appPassword) return '';
  const ImapFlow = loadImapFlow();
  const password = String(appPassword).replace(/\s+/g, '');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let client;
    try {
      client = new ImapFlow({ host: process.env.ORDER_RECHECK_IMAP_HOST || 'imap.gmail.com', port: Number(process.env.ORDER_RECHECK_IMAP_PORT || 993), secure: true, auth: { user: email, pass: password }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since = new Date(sinceMs);
        const uids = await client.search({ since });
        const recent = (uids || []).slice(-20).reverse();
        for (const uid of recent) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true });
          const from = (msg?.envelope?.from || []).map((x) => `${x.name || ''} ${x.address || ''}`).join(' ').toLowerCase();
          const subject = String(msg?.envelope?.subject || '').toLowerCase();
          const raw = msg?.source ? msg.source.toString('utf8') : '';
          const hay = `${from}\n${subject}\n${raw}`;
          if (!/target|verification|security|code|passcode/i.test(hay)) continue;
          const matches = [...hay.matchAll(/(?:code|passcode|verification code|security code)?\D\b(\d{6})\b/gi)].map((m) => m[1]);
          if (matches.length) return matches[0];
        }
      } finally { lock.release(); }
      await client.logout();
    } catch (err) {
      log(`IMAP OTP poll error: ${err.message || err}`);
      try { if (client) await client.logout(); } catch (_) {}
    }
    await sleep(5000);
  }
  return '';
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && text(row[key])) return text(row[key]);
  }
  return '';
}

function rowToCredential(row, source = 'unknown') {
  if (!row) return null;
  const loginEmail = pickValue(row, [
    'login_email', 'account_login_email', 'target_login_email', 'email', 'username', 'account_email'
  ]);
  const loginPassword = pickValue(row, [
    'login_password', 'account_login_password', 'target_login_password', 'password', 'account_password'
  ]);
  const gmailAppPassword = pickValue(row, [
    'gmail_app_password', 'imap_password', 'gmail_imap_password', 'imap_app_password', 'app_password'
  ]);
  const store = pickValue(row, ['store', 'provider', 'account_type', 'site']);
  if (!loginEmail && !loginPassword && !gmailAppPassword) return null;
  return { loginEmail, loginPassword, gmailAppPassword, store, source, profileId: text(row.profile_id || row.profileId || row.id || ''), accountId: text(row.account_id || row.accountId || row.id || ''), userId: text(row.user_id || row.userId || ''), raw: row };
}

function credentialMatchesTarget(cred, accountEmail) {
  if (!cred) return false;
  const store = lc(cred.store || '');
  const storeOk = !store || store.includes('target') || store.includes('general') || store.includes('stellar') || store.includes('shikari') || store.includes('bot');
  const emailOk = !accountEmail || lc(cred.loginEmail) === lc(accountEmail);
  return storeOk && emailOk && cred.loginEmail && cred.loginPassword;
}

async function safeSelect(supabase, table, select, apply) {
  try {
    let q = supabase.from(table).select(select);
    q = apply(q);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch (_) {
    return [];
  }
}

async function findCredentialsForOrder({ supabase, order, normalized, log = () => {} }) {
  const accountEmail = lc(normalized.accountEmail);
  const candidates = [];

  // Highest priority: bot webhook account field like email:password.
  if (normalized.accountEmail && normalized.accountPassword) {
    candidates.push({
      loginEmail: normalized.accountEmail,
      loginPassword: normalized.accountPassword,
      gmailAppPassword: '',
      store: 'target',
      source: 'discord_webhook_account_password',
      profileId: text(order?.profile_id || order?.profileId || ''),
      accountId: text(order?.account_id || order?.accountId || '')
    });
  }

  let profiles = [];
  if (order?.user_id) {
    profiles = await safeSelect(supabase, 'profiles', '*', (q) => q.eq('user_id', order.user_id).limit(200));
    for (const p of profiles) {
      const c = rowToCredential(p, 'profiles_row');
      if (c) candidates.push(c);
      // Some dashboards save account data as JSON.
      for (const key of ['accounts', 'store_credentials', 'credentials']) {
        const value = p[key];
        if (Array.isArray(value)) value.forEach((row) => { const c2 = rowToCredential(row, `profiles.${key}`); if (c2) candidates.push(c2); });
        else if (value && typeof value === 'object') Object.entries(value).forEach(([store, row]) => { const c2 = rowToCredential({ ...(row || {}), store }, `profiles.${key}.${store}`); if (c2) candidates.push(c2); });
      }
    }
  }

  const profileIds = profiles.map((p) => p.id).filter(Boolean);
  if (profileIds.length) {
    (await safeSelect(supabase, 'profile_store_credentials', '*', (q) => q.in('profile_id', profileIds))).forEach((row) => {
      const c = rowToCredential(row, 'profile_store_credentials');
      if (c) candidates.push(c);
    });
    (await safeSelect(supabase, 'accounts', '*', (q) => q.in('profile_id', profileIds))).forEach((row) => {
      const c = rowToCredential(row, 'accounts_by_profile_id');
      if (c) candidates.push(c);
    });
  }

  if (order?.user_id) {
    // Some schemas attach accounts directly to user_id instead of profile_id.
    (await safeSelect(supabase, 'accounts', '*', (q) => q.eq('user_id', order.user_id).limit(200))).forEach((row) => {
      const c = rowToCredential(row, 'accounts_by_user_id');
      if (c) candidates.push(c);
    });
  }

  if (accountEmail) {
    // These may fail if the column does not exist; safeSelect intentionally ignores that.
    (await safeSelect(supabase, 'profile_store_credentials', '*', (q) => q.ilike('login_email', accountEmail).limit(20))).forEach((row) => {
      const c = rowToCredential(row, 'profile_store_credentials_by_email');
      if (c) candidates.push(c);
    });
    (await safeSelect(supabase, 'accounts', '*', (q) => q.ilike('login_email', accountEmail).limit(20))).forEach((row) => {
      const c = rowToCredential(row, 'accounts_by_login_email');
      if (c) candidates.push(c);
    });
  }

  const target =
    candidates.find((c) => credentialMatchesTarget(c, accountEmail)) ||
    candidates.find((c) => c.loginEmail && c.loginPassword && (!accountEmail || lc(c.loginEmail) === accountEmail)) ||
    candidates.find((c) => c.loginEmail && c.loginPassword) ||
    null;

  if (target) {
    // If Target account came from webhook but IMAP is saved on the dashboard profile, merge it in.
    if (!target.gmailAppPassword) {
      const imapSource = candidates.find((c) => c.gmailAppPassword && (!accountEmail || lc(c.loginEmail) === accountEmail));
      if (imapSource) target.gmailAppPassword = imapSource.gmailAppPassword;
    }
    log(`Using Target credentials from ${target.source}: ${target.loginEmail}`);
    return {
      loginEmail: text(target.loginEmail),
      loginPassword: text(target.loginPassword),
      gmailAppPassword: text(target.gmailAppPassword),
      source: target.source,
      profileId: text(target.profileId || order?.profile_id || order?.profileId || ''),
      accountId: text(target.accountId || order?.account_id || order?.accountId || '')
    };
  }

  log(`No credentials found. normalized.accountEmail=${normalized.accountEmail || '-'} profileCount=${profiles.length} candidates=${candidates.length}`);
  return null;
}


async function pickFallbackProxyFromPool({ supabase, log = () => {} }) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('target_recheck_proxies')
      .select('*')
      .eq('active', true)
      .order('failure_count', { ascending: true })
      .order('last_success_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    const row = data[0];
    const proxy = row.proxy || (row.host && row.port ? `${row.host}:${row.port}${row.username ? ':' + row.username + ':' + (row.password || '') : ''}` : '');
    if (!proxy) return null;
    log(`Using fallback proxy from target_recheck_proxies: ${row.host || proxy.split(':')[0]}:${row.port || proxy.split(':')[1]}`);
    return { proxy, proxyPoolId: row.id };
  } catch (err) {
    log(`Proxy pool lookup failed: ${err.message || err}`);
    return null;
  }
}

async function markProxyPoolResult({ supabase, proxyPoolId, ok, errorText = '', log = () => {} }) {
  if (!supabase || !proxyPoolId) return;
  try {
    if (ok) {
      await supabase.from('target_recheck_proxies').update({
        last_success_at: new Date().toISOString(),
        failure_count: 0,
        last_error: null,
        active: true,
        updated_at: new Date().toISOString()
      }).eq('id', proxyPoolId);
      return;
    }
    const { data } = await supabase.from('target_recheck_proxies').select('failure_count').eq('id', proxyPoolId).maybeSingle();
    const nextCount = Number(data?.failure_count || 0) + 1;
    await supabase.from('target_recheck_proxies').update({
      last_failure_at: new Date().toISOString(),
      failure_count: nextCount,
      last_error: String(errorText || '').slice(0, 500),
      active: nextCount < Number(process.env.ORDER_RECHECK_PROXY_MAX_FAILURES || 3),
      updated_at: new Date().toISOString()
    }).eq('id', proxyPoolId);
    log(`Marked proxy pool failure count=${nextCount}${nextCount >= Number(process.env.ORDER_RECHECK_PROXY_MAX_FAILURES || 3) ? ' and disabled proxy' : ''}.`);
  } catch (err) {
    log(`Proxy pool update failed: ${err.message || err}`);
  }
}

async function launchBrowser({ normalized, debug, log }) {
  const browserMode = String(process.env.ORDER_RECHECK_BROWSER_MODE || '').trim().toLowerCase();
  const forceLocal = browserMode === 'local' || String(process.env.ORDER_RECHECK_FORCE_LOCAL_CHROMIUM || '').toLowerCase() === 'true';
  const endpoint = forceLocal ? '' : text(process.env.BROWSERLESS_WS_ENDPOINT || process.env.BROWSERLESS_CDP_ENDPOINT || process.env.PLAYWRIGHT_WS_ENDPOINT);
  const proxy = parseProxy(normalized.proxy);

  if (forceLocal) {
    log('ORDER_RECHECK_BROWSER_MODE=local / ORDER_RECHECK_FORCE_LOCAL_CHROMIUM=true detected. Ignoring Browserless env and launching local Chromium.');
  }

  if (endpoint) {
    const endpointWithLaunch = browserlessEndpointWithLaunchOptions(endpoint, normalized, proxy, log);
    log('Connecting to Browserless / remote Chromium endpoint.');
    if (proxy?.username) log(`Order proxy authentication will be applied for proxy user: ${proxy.username}`);
    const browser = await chromium.connectOverCDP(endpointWithLaunch);
    return { browser, remote: true, proxy };
  }

  const headed = String(process.env.ORDER_RECHECK_HEADLESS || '').toLowerCase() === 'false';
  const launchOptions = {
    headless: !headed,
    slowMo: Number(process.env.ORDER_RECHECK_SLOWMO_MS || (headed ? 250 : 0)),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--hide-scrollbars'
    ]
  };
  if (proxy) {
    launchOptions.proxy = proxy;
    log(`Local Chromium will use order proxy: ${proxy.server}${proxy.username ? ' with auth' : ''}`);
  } else {
    log('No order proxy found for local Chromium; Target may see Render datacenter IP.');
  }

  log(`Launching local Chromium. headless=${launchOptions.headless}`);
  try {
    return { browser: await chromium.launch(launchOptions), remote: false, proxy };
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/Executable doesn't exist|Please run.*playwright install|browserType\.launch/i.test(msg)) {
      throw new Error(
        'Chromium is not installed on this Render instance. Either set BROWSERLESS_CDP_ENDPOINT / BROWSERLESS_WS_ENDPOINT for Browserless mode, or use Render build command `npm install` with this package postinstall, or the included postinstall should install Chromium into node_modules; redeploy with Clear Build Cache. Original error: ' + msg.slice(0, 800)
      );
    }
    throw err;
  }
}

function sessionKeyForOrder({ order, normalized, credentials }) {
  const profilePart = safeName(credentials.profileId || order?.profile_id || order?.profileId || 'no_profile');
  const accountPart = safeName(credentials.accountId || normalized.accountEmail || credentials.loginEmail || 'no_account');
  const userPart = safeName(order?.user_id || credentials.userId || 'no_user');
  return `${userPart}__${profilePart}__${accountPart}__target`;
}

async function loadStoredTargetSession({ supabase, sessionKey, filePath, log = () => {} }) {
  try {
    const { data, error } = await supabase.from('target_login_sessions').select('storage_state').eq('session_key', sessionKey).maybeSingle();
    if (!error && data?.storage_state) {
      log(`Loaded Target login session from Supabase key ${sessionKey}.`);
      return typeof data.storage_state === 'string' ? JSON.parse(data.storage_state) : data.storage_state;
    }
  } catch (_) {}
  try {
    if (fs.existsSync(filePath)) {
      log(`Loaded Target login session from local file key ${sessionKey}.`);
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

async function saveStoredTargetSession({ supabase, sessionKey, storageState, credentials, order, filePath, log = () => {} }) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(storageState), 'utf8');
    log(`Saved Target login session to local file key ${sessionKey}.`);
  } catch (err) {
    log(`Could not save local Target login session: ${err.message || err}`);
  }
  try {
    await supabase.from('target_login_sessions').upsert({
      session_key: sessionKey,
      user_id: order?.user_id || null,
      profile_id: credentials.profileId || order?.profile_id || null,
      account_id: credentials.accountId || order?.account_id || null,
      login_email: credentials.loginEmail || null,
      store: 'target',
      storage_state: storageState,
      updated_at: new Date().toISOString()
    }, { onConflict: 'session_key' });
    log(`Saved Target login session to Supabase key ${sessionKey}.`);
  } catch (_) {
    // Optional table may not exist yet. Local file fallback still works until redeploy.
  }
}


async function loginTargetIfNeeded({ page, credentials, debug, log }) {
  await page.goto('https://www.target.com/orders', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await debug.shot(page, 'orders-page');
  const body = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  if (/purchase history|orders|order details/i.test(body) && !/sign in|email or mobile phone/i.test(body)) {
    log('Already appears logged in.');
    return;
  }
  await clickByText(page, [/sign in/i, /sign in or create account/i]).catch(() => null);
  await page.waitForTimeout(1500);
  await debug.shot(page, 'signin-opened');

  const emailInput = await firstVisible(page, ['input[type="email"]', 'input[name="username"]', 'input[name="email"]', 'input[id*="username"]', 'input[id*="email"]', 'input[type="text"]'], 8000);
  if (!emailInput) {
    const bodyNow = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/accessDenied-CheckVPN|CheckVPN|VPN|access denied/i.test(bodyNow)) {
      throw new Error(`Target blocked the browser/proxy before the email field. Page text: ${bodyNow.slice(0, 700)}`);
    }
    throw new Error('Target email field did not appear. Check debug screenshots.');
  }
  await emailInput.fill(credentials.loginEmail);
  await debug.shot(page, 'email-filled');
  await clickByText(page, [/continue/i, /next/i, /sign in/i]);
  await page.waitForTimeout(3000);
  await debug.shot(page, 'after-email-submit');

  let passInput = await firstVisible(page, ['input[type="password"]', 'input[name="password"]', 'input[id*="password"]'], 12000);
  if (!passInput) {
    const bodyNow = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/something went wrong|try again later|blocked|verify you are human|captcha/i.test(bodyNow)) {
      throw new Error(`Target blocked or changed the login flow before password. This is usually proxy/browser-fingerprint related. Use Browserless live mode or a cleaner proxy. Page text: ${bodyNow.slice(0, 700)}`);
    }
    throw new Error(`Target password field did not appear. Page text: ${bodyNow.slice(0, 700)}`);
  }
  await passInput.fill(credentials.loginPassword);
  await debug.shot(page, 'password-filled');
  await clickByText(page, [/sign in/i, /continue/i]);
  await page.waitForTimeout(5000);
  await debug.shot(page, 'after-password-submit');

  const otpField = await firstVisible(page, ['input[name*="code"]', 'input[id*="code"]', 'input[autocomplete="one-time-code"]', 'input[type="tel"]'], 5000);
  if (otpField) {
    log('OTP field detected. Polling IMAP.');
    const otp = await getTargetOtpFromImap({ email: credentials.loginEmail, appPassword: credentials.gmailAppPassword, log });
    if (!otp) throw new Error('Target requested OTP, but no OTP was found through IMAP. Verify Gmail app password / IMAP access.');
    await otpField.fill(otp);
    await debug.shot(page, 'otp-filled');
    await clickByText(page, [/verify/i, /continue/i, /submit/i]);
    await page.waitForTimeout(5000);
    await debug.shot(page, 'after-otp-submit');
  }
}

async function verifyTargetOrder({ page, normalized, debug, log }) {
  const orderNumber = normalized.orderNumber;
  const expectedSku = normalized.sku;
  const expectedName = normalized.productName;
  if (!orderNumber) throw new Error('Missing order number on this order record/raw payload.');
  const urls = [
    `https://www.target.com/orders/${encodeURIComponent(orderNumber)}`,
    `https://www.target.com/orders?searchTerm=${encodeURIComponent(orderNumber)}`,
    'https://www.target.com/orders'
  ];
  let pageText = '';
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => log(`goto failed ${url}: ${err.message}`));
    await page.waitForTimeout(5000);
    await debug.shot(page, `order-check-${safeName(url)}`);
    pageText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    if (pageText.includes(orderNumber) || (expectedSku && pageText.includes(expectedSku)) || (expectedName && lc(pageText).includes(lc(expectedName).slice(0, 20)))) break;
  }
  await debug.html(page, 'final-page');
  const textLower = lc(pageText);
  const skuFound = !!expectedSku && pageText.includes(expectedSku);
  const nameNeedle = lc(expectedName).replace(/\s+/g, ' ').slice(0, 80);
  const nameFound = !!nameNeedle && textLower.includes(nameNeedle.slice(0, Math.min(nameNeedle.length, 35)));
  const orderFound = !!orderNumber && pageText.includes(orderNumber);
  const expectedQuantity = Number(normalized.expectedQuantity || 0) || 0;
  let quantityFound = null;
  let quantityMatches = null;
  if (expectedQuantity > 0 && (skuFound || nameFound)) {
    const anchor = expectedSku && pageText.includes(expectedSku) ? expectedSku : (expectedName || '').slice(0, 40);
    const idx = anchor ? lc(pageText).indexOf(lc(anchor)) : -1;
    const nearby = idx >= 0 ? pageText.slice(Math.max(0, idx - 800), idx + 1600) : pageText;
    const qtyPatterns = [
      /qty\s*[:#-]?\s*(\d+)/i,
      /quantity\s*[:#-]?\s*(\d+)/i,
      /\b(\d+)\s+items?\b/i
    ];
    for (const pat of qtyPatterns) {
      const m = nearby.match(pat);
      if (m) { quantityFound = Number(m[1]); break; }
    }
    quantityMatches = quantityFound === null ? null : quantityFound === expectedQuantity;
  }
  return { orderFound, skuFound, nameFound, itemFound: skuFound || nameFound, expectedQuantity, quantityFound, quantityMatches, pageTextSample: pageText.slice(0, 1200) };
}

async function recheckTargetOrder({ supabase, order, currentUser, helpers }) {
  const normalized = normalizeOrderPayload(order);
  const debug = makeDebug(normalized.orderNumber || order.id);
  const logs = [];
  const log = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    logs.push(stamped);
    try { debug.appendLog(stamped); } catch (_) {}
    console.log('[order-recheck]', line);
  };
  let browser;
  let context;
  let proxyPoolId = '';
  try {
    log(`Rechecking order ${normalized.orderNumber || order.id}`);
    if (!normalized.proxy) {
      const fallbackProxy = await pickFallbackProxyFromPool({ supabase, log });
      if (fallbackProxy?.proxy) {
        normalized.proxy = fallbackProxy.proxy;
        proxyPoolId = fallbackProxy.proxyPoolId || '';
      }
    }
    const credentials = await findCredentialsForOrder({ supabase, order, normalized, log });
    if (!credentials?.loginEmail || !credentials?.loginPassword) throw new Error('No Target login credentials found for this order/profile. Make sure the matching profile has Target login email/password saved.');
    if (!credentials.gmailAppPassword) log('No Gmail app password saved; OTP automation may fail if Target asks for a code.');
    const launched = await launchBrowser({ normalized, debug, log });
    browser = launched.browser;
    const sessionKey = sessionKeyForOrder({ order, normalized, credentials });
    const sessionPath = path.join(SESSION_ROOT, `${sessionKey}.json`);
    ensureDir(SESSION_ROOT);
    const shouldRecordVideo = String(process.env.ORDER_RECHECK_RECORD_VIDEO || '').toLowerCase() === 'true';
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent: process.env.ORDER_RECHECK_USER_AGENT || undefined,
      // Video recording uses a lot of memory on Render Starter. Keep it opt-in.
      recordVideo: shouldRecordVideo && !launched.remote ? { dir: debug.dir, size: { width: 1280, height: 800 } } : undefined
    };
    const storedSession = await loadStoredTargetSession({ supabase, sessionKey, filePath: sessionPath, log });
    if (storedSession) contextOptions.storageState = storedSession;
    context = await browser.newContext(contextOptions);
    const shouldTrace = String(process.env.ORDER_RECHECK_TRACE || '').toLowerCase() === 'true';
    if (shouldTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => null);
    const page = await context.newPage();
    await attachProxyAuthIfNeeded(page, launched.proxy, log);
    page.setDefaultTimeout(Number(process.env.ORDER_RECHECK_STEP_TIMEOUT_MS || 20000));
    page.setDefaultNavigationTimeout(Number(process.env.ORDER_RECHECK_NAV_TIMEOUT_MS || 45000));

    // Keep Render memory low. Target's text/order pages do not require images/fonts/media.
    if (String(process.env.ORDER_RECHECK_BLOCK_HEAVY_ASSETS || 'true').toLowerCase() !== 'false') {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) return route.abort().catch(() => null);
        return route.continue().catch(() => null);
      }).catch(() => null);
    }
    log('Starting Target login/session check.');
    await loginTargetIfNeeded({ page, credentials, debug, log });
    log('Target login/session check completed.');
    const storageState = await context.storageState().catch(() => null);
    if (storageState) await saveStoredTargetSession({ supabase, sessionKey, storageState, credentials, order, filePath: sessionPath, log });
    log('Starting Target order item/quantity verification.');
    const check = await verifyTargetOrder({ page, normalized, debug, log });
    log(`Order verification result: itemFound=${check.itemFound}, expectedQty=${check.expectedQuantity}, detectedQty=${check.quantityFound ?? 'not detected'}, quantityMatches=${check.quantityMatches}`);
    if (proxyPoolId) await markProxyPoolResult({ supabase, proxyPoolId, ok: true, log });
    let refunded = false;
    let refundAmount = 0;
    if (!check.itemFound) {
      refundAmount = Number(order.credits_charged || 0) || 0;
      if (refundAmount > 0 && helpers?.adjustUserCredits) {
        await helpers.adjustUserCredits({ userId: order.user_id, delta: refundAmount, reason: 'order_recheck_item_missing_refund', note: `Auto-refund: expected item missing from Target order ${normalized.orderNumber}`, metadata: { order_id: order.id, external_order_id: normalized.orderNumber, expected_sku: normalized.sku, expected_product: normalized.productName }, createdBy: currentUser.id, orderId: order.id });
        await supabase.from('orders').update({ status: `${order.status || 'success'}_item_missing_refunded`, metadata: { ...(order.metadata || {}), order_recheck: { checked_at: new Date().toISOString(), item_found: false, refund_amount: refundAmount, artifacts: debug.artifacts } } }).eq('id', order.id);
        refunded = true;
      }
    } else {
      await supabase.from('orders').update({ metadata: { ...(order.metadata || {}), order_recheck: { checked_at: new Date().toISOString(), item_found: true, artifacts: debug.artifacts } } }).eq('id', order.id);
    }
    const tracePath = path.join(debug.dir, 'trace.zip');
    if (shouldTrace) await context.tracing.stop({ path: tracePath }).catch(() => null);
    if (fs.existsSync(tracePath)) debug.artifacts.push({ type: 'trace', label: 'Playwright Trace', url: publicDebugPath(tracePath) });
    await context.close().catch(() => null);
    const videos = fs.readdirSync(debug.dir).filter((f) => f.endsWith('.webm'));
    videos.forEach((file) => debug.artifacts.push({ type: 'video', label: 'Browser Video', url: publicDebugPath(path.join(debug.dir, file)) }));
    debug.writeLog(logs);
    return { ok: true, ...check, refunded, refundAmount, message: check.itemFound ? (`Expected Target item was found on the order.` + (check.expectedQuantity ? ` Expected qty: ${check.expectedQuantity}. Detected qty: ${check.quantityFound ?? 'not detected'}.` : '') + (check.quantityMatches === false ? ' Quantity mismatch detected, but no refund was issued because credits are charged per checkout, not per quantity.' : '')) : (refunded ? `Expected item was missing. Refunded ${refundAmount} credits.` : 'Expected item was missing. No credits were refunded because this order had no charged credits.'), artifacts: debug.artifacts };
  } catch (err) {
    log(`ERROR: ${err.message || err}`);
    if (proxyPoolId) await markProxyPoolResult({ supabase, proxyPoolId, ok: false, errorText: err.message || err, log });
    try {
      if (context) {
        const tracePath = path.join(debug.dir, 'trace-error.zip');
        if (shouldTrace) await context.tracing.stop({ path: tracePath }).catch(() => null);
        if (fs.existsSync(tracePath)) debug.artifacts.push({ type: 'trace', label: 'Playwright Error Trace', url: publicDebugPath(tracePath) });
        await context.close().catch(() => null);
      }
    } catch (_) {}
    try {
      const videos = fs.readdirSync(debug.dir).filter((f) => f.endsWith('.webm'));
      videos.forEach((file) => {
        const url = publicDebugPath(path.join(debug.dir, file));
        if (!debug.artifacts.some((a) => a.url === url)) debug.artifacts.push({ type: 'video', label: 'Browser Error Video', url });
      });
    } catch (_) {}
    debug.writeLog(logs);
    try { if (browser) await browser.close(); } catch (_) {}
    err.artifacts = debug.artifacts;
    err.debugRunId = debug.runId;
    throw err;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
}

module.exports = { DEBUG_ROOT, normalizeOrderPayload, recheckTargetOrder };
