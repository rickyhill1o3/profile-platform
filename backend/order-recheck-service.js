const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');

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

function normalizeOrderPayload(order) {
  const payload = order?.raw_payload && typeof order.raw_payload === 'object' ? order.raw_payload : {};
  return {
    orderNumber: text(order?.external_order_id || getDiscordField(payload, 'Order ID') || payload.external_order_id || payload.order_id || payload.order_number),
    productName: text(order?.product_name || getDiscordField(payload, 'Product') || payload.product_name || payload.product),
    sku: text(order?.sku || getDiscordField(payload, 'SKU') || payload.sku),
    accountEmail: text(getDiscordField(payload, 'Account') || payload.account_email || payload.account || payload.email || order?.user_email),
    proxy: text(order?.proxy || payload.proxy || getDiscordField(payload, 'Proxy')),
    site: lc(order?.source || getDiscordField(payload, 'Site') || payload.site || payload.source)
  };
}

function parseProxy(proxyRaw) {
  const value = text(proxyRaw).replace(/^\|\|/, '').replace(/\|\|$/, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || /^socks/i.test(value)) return { server: value };
  const parts = value.split(':');
  if (parts.length >= 4) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts.slice(3).join(':') };
  }
  if (parts.length >= 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return null;
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
      artifacts.push({ type: 'log', label: 'Log', url: publicDebugPath(file) });
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

async function getTargetOtpFromImap({ email, appPassword, sinceMs = Date.now() - 10 * 60 * 1000, timeoutMs = 90000, log = () => {} }) {
  if (!email || !appPassword) return '';
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

async function findCredentialsForOrder({ supabase, order, normalized }) {
  const accountEmail = lc(normalized.accountEmail);
  let profiles = [];
  if (order?.user_id) {
    const { data } = await supabase.from('profiles').select('id,user_id,profile_name,account_type').eq('user_id', order.user_id).limit(100);
    profiles = data || [];
  }
  const profileIds = profiles.map((p) => p.id).filter(Boolean);
  const candidates = [];
  if (profileIds.length) {
    const { data } = await supabase.from('profile_store_credentials').select('*').in('profile_id', profileIds);
    (data || []).forEach((row) => candidates.push({ ...row, source: 'profile_store_credentials' }));
    const { data: accs } = await supabase.from('accounts').select('*').in('profile_id', profileIds);
    (accs || []).forEach((row) => candidates.push({ ...row, store: row.provider || 'target', source: 'accounts' }));
  }
  if (accountEmail) {
    const { data } = await supabase.from('profile_store_credentials').select('*').ilike('login_email', accountEmail).limit(10);
    (data || []).forEach((row) => candidates.push({ ...row, source: 'profile_store_credentials_email' }));
    const { data: accs } = await supabase.from('accounts').select('*').ilike('login_email', accountEmail).limit(10);
    (accs || []).forEach((row) => candidates.push({ ...row, store: row.provider || 'target', source: 'accounts_email' }));
  }
  const target = candidates.find((c) => lc(c.store || c.provider).includes('target') && (accountEmail ? lc(c.login_email) === accountEmail : c.login_email))
    || candidates.find((c) => c.login_email && c.login_password)
    || null;
  if (!target) return null;
  return { loginEmail: text(target.login_email), loginPassword: text(target.login_password), gmailAppPassword: text(target.gmail_app_password), source: target.source };
}

async function launchBrowser({ normalized, debug, log }) {
  const endpoint = text(process.env.BROWSERLESS_WS_ENDPOINT || process.env.BROWSERLESS_CDP_ENDPOINT || process.env.PLAYWRIGHT_WS_ENDPOINT);
  if (endpoint) {
    log('Connecting to Browserless / remote Chromium endpoint.');
    const browser = await chromium.connectOverCDP(endpoint);
    return { browser, remote: true };
  }
  const headed = String(process.env.ORDER_RECHECK_HEADLESS || '').toLowerCase() === 'false';
  const proxy = parseProxy(normalized.proxy);
  const launchOptions = {
    headless: !headed,
    slowMo: Number(process.env.ORDER_RECHECK_SLOWMO_MS || (headed ? 250 : 0)),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  };
  if (proxy) launchOptions.proxy = proxy;
  log(`Launching local Chromium. headless=${launchOptions.headless}`);
  return { browser: await chromium.launch(launchOptions), remote: false };
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
  if (!emailInput) throw new Error('Target email field did not appear. Check debug screenshots.');
  await emailInput.fill(credentials.loginEmail);
  await debug.shot(page, 'email-filled');
  await clickByText(page, [/continue/i, /next/i, /sign in/i]);
  await page.waitForTimeout(3000);
  await debug.shot(page, 'after-email-submit');

  let passInput = await firstVisible(page, ['input[type="password"]', 'input[name="password"]', 'input[id*="password"]'], 15000);
  if (!passInput) {
    const bodyNow = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
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
  return { orderFound, skuFound, nameFound, itemFound: skuFound || nameFound, pageTextSample: pageText.slice(0, 1200) };
}

async function recheckTargetOrder({ supabase, order, currentUser, helpers }) {
  const normalized = normalizeOrderPayload(order);
  const debug = makeDebug(normalized.orderNumber || order.id);
  const logs = [];
  const log = (line) => { logs.push(`[${new Date().toISOString()}] ${line}`); console.log('[order-recheck]', line); };
  let browser;
  try {
    log(`Rechecking order ${normalized.orderNumber || order.id}`);
    const credentials = await findCredentialsForOrder({ supabase, order, normalized });
    if (!credentials?.loginEmail || !credentials?.loginPassword) throw new Error('No Target login credentials found for this order/profile. Make sure the matching profile has Target login email/password saved.');
    if (!credentials.gmailAppPassword) log('No Gmail app password saved; OTP automation may fail if Target asks for a code.');
    const launched = await launchBrowser({ normalized, debug, log });
    browser = launched.browser;
    const sessionPath = path.join(SESSION_ROOT, `${safeName(credentials.loginEmail)}-target.json`);
    ensureDir(SESSION_ROOT);
    const contextOptions = {
      viewport: { width: 1365, height: 900 },
      userAgent: process.env.ORDER_RECHECK_USER_AGENT || undefined,
      recordVideo: launched.remote ? undefined : { dir: debug.dir, size: { width: 1365, height: 900 } }
    };
    if (fs.existsSync(sessionPath)) contextOptions.storageState = sessionPath;
    const context = await browser.newContext(contextOptions);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => null);
    const page = await context.newPage();
    await loginTargetIfNeeded({ page, credentials, debug, log });
    await context.storageState({ path: sessionPath }).catch(() => null);
    const check = await verifyTargetOrder({ page, normalized, debug, log });
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
    await context.tracing.stop({ path: tracePath }).catch(() => null);
    if (fs.existsSync(tracePath)) debug.artifacts.push({ type: 'trace', label: 'Playwright Trace', url: publicDebugPath(tracePath) });
    await context.close().catch(() => null);
    const videos = fs.readdirSync(debug.dir).filter((f) => f.endsWith('.webm'));
    videos.forEach((file) => debug.artifacts.push({ type: 'video', label: 'Browser Video', url: publicDebugPath(path.join(debug.dir, file)) }));
    debug.writeLog(logs);
    return { ok: true, ...check, refunded, refundAmount, message: check.itemFound ? 'Expected Target item was found on the order.' : (refunded ? `Expected item was missing. Refunded ${refundAmount} credits.` : 'Expected item was missing. No credits were refunded because this order had no charged credits.'), artifacts: debug.artifacts };
  } catch (err) {
    log(`ERROR: ${err.message || err}`);
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
