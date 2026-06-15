'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let Imap = null;
try { Imap = require('imap'); } catch (_) {}

function clean(v) { return String(v || '').replace(/^\|\|/, '').replace(/\|\|$/, '').trim(); }
function norm(v) { return clean(v).toLowerCase(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeName(v) { return String(v || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120); }
function getField(raw, name) {
  const wanted = String(name || '').toLowerCase();
  const embeds = Array.isArray(raw?.embeds) ? raw.embeds : [];
  for (const embed of embeds) {
    for (const field of (Array.isArray(embed?.fields) ? embed.fields : [])) {
      if (String(field?.name || '').toLowerCase() === wanted) return clean(field?.value);
    }
  }
  return '';
}
function parseProxy(proxy) {
  const value = clean(proxy);
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length < 2) return null;
  const [host, port, username, ...rest] = parts;
  const password = rest.join(':');
  return {
    server: `http://${host}:${port}`,
    username: username || undefined,
    password: password || undefined
  };
}
function textHasExpectedItem(pageText, expectedSku, expectedProduct) {
  const text = norm(pageText);
  const sku = norm(expectedSku).replace(/[^a-z0-9]/g, '');
  const product = norm(expectedProduct);
  if (sku && text.replace(/[^a-z0-9]/g, '').includes(sku)) return true;
  if (product && product.length > 4 && text.includes(product)) return true;
  const productTokens = product.split(/\s+/).filter((w) => w.length >= 4 && !['colors','color','vary','with','the','and','for'].includes(w));
  if (productTokens.length >= 2) {
    const hits = productTokens.filter((t) => text.includes(t)).length;
    return hits >= Math.min(3, productTokens.length);
  }
  return false;
}
function maybeOtp(text) {
  const s = String(text || '');
  const patterns = [/(?:code|passcode|verification code|security code)[^0-9]{0,40}([0-9]{6})/i, /\b([0-9]{6})\b/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}
async function getText(page) {
  try { return await page.locator('body').innerText({ timeout: 4000 }); } catch (_) { return ''; }
}
async function firstVisible(page, selectors, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      try { if (await loc.isVisible({ timeout: 400 })) return loc; } catch (_) {}
    }
    await sleep(300);
  }
  return null;
}
function makeDebug(baseDir, orderId) {
  const stamp = `${Date.now()}-${safeName(orderId)}`;
  const dir = path.join(baseDir, 'admin-order-recheck-debug', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  return {
    dir,
    shots,
    rel(p) { return `/admin-order-recheck-debug/${stamp}/${path.basename(p)}`; },
    async shot(page, label) {
      const file = path.join(dir, `${String(shots.length + 1).padStart(2, '0')}-${safeName(label)}.png`);
      try { await page.screenshot({ path: file, fullPage: true }); shots.push(this.rel(file)); } catch (_) {}
    },
    write(name, body) {
      const file = path.join(dir, safeName(name));
      fs.writeFileSync(file, String(body || ''), 'utf8');
      shots.push(this.rel(file));
    }
  };
}

module.exports = function createOrderRechecker(deps) {
  const { app, express, auth, admin, supabase, getCurrentUser, getUserById, canManageTarget, adjustUserCredits, asWholeCredits } = deps;
  const staticRoot = path.join(__dirname, '..', 'frontend');
  app.use('/admin-order-recheck-debug', express.static(path.join(staticRoot, 'admin-order-recheck-debug')));

  async function findCredentials(order) {
    const raw = order.raw_payload || {};
    const accountEmail = clean(order.metadata?.account_email || raw.account_email || raw.email || getField(raw, 'Account'));
    const profileName = clean(order.metadata?.profile_name || raw.profile_name || getField(raw, 'Profile'));
    const store = 'target';

    let profile = null;
    if (accountEmail) {
      try {
        const { data } = await supabase.from('profile_store_credentials').select('*, profiles(*)').ilike('login_email', accountEmail).eq('store', store).order('created_at', { ascending: false }).limit(1);
        if (data?.[0]) return { profile: data[0].profiles, credential: data[0] };
      } catch (_) {}
      try {
        const { data } = await supabase.from('accounts').select('*, profiles(*)').ilike('login_email', accountEmail).order('created_at', { ascending: false }).limit(1);
        if (data?.[0]) return { profile: data[0].profiles, credential: data[0] };
      } catch (_) {}
    }
    if (profileName) {
      try {
        const { data } = await supabase.from('profiles').select('*').ilike('profile_name', profileName).order('created_at', { ascending: false }).limit(1);
        profile = data?.[0] || null;
        if (profile?.id) {
          const { data: creds } = await supabase.from('profile_store_credentials').select('*').eq('profile_id', profile.id).eq('store', store).limit(1);
          if (creds?.[0]) return { profile, credential: creds[0] };
          const { data: accts } = await supabase.from('accounts').select('*').eq('profile_id', profile.id).limit(1);
          if (accts?.[0]) return { profile, credential: accts[0] };
        }
      } catch (_) {}
    }
    return { profile, credential: null };
  }

  async function fetchOtpFromImap({ email, appPassword, sinceMs = 12 * 60 * 1000, debug }) {
    if (!email || !appPassword) return '';
    if (!Imap) throw new Error('IMAP OTP requested, but the imap package is not installed. Redeploy after npm install completes.');
    const host = process.env.IMAP_HOST || (email.toLowerCase().includes('@gmail.com') ? 'imap.gmail.com' : 'imap.gmail.com');
    const since = new Date(Date.now() - sinceMs);
    const sinceImap = since.toUTCString().replace(/, /, '-').replace(/ .*$/, '');

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, code) => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch (_) {}
        if (err) reject(err); else resolve(code || '');
      };
      const client = new Imap({
        user: email,
        password: appPassword,
        host,
        port: Number(process.env.IMAP_PORT || 993),
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 20000,
        authTimeout: 20000
      });
      const timer = setTimeout(() => finish(null, ''), 45000);
      client.once('ready', () => {
        client.openBox('INBOX', true, (openErr) => {
          if (openErr) { clearTimeout(timer); return finish(openErr); }
          client.search([['SINCE', sinceImap]], (searchErr, results) => {
            if (searchErr) { clearTimeout(timer); return finish(searchErr); }
            const ids = (results || []).slice(-25).reverse();
            if (!ids.length) { clearTimeout(timer); if (debug) debug.write('imap-no-messages.txt', `No recent IMAP messages for ${email}`); return finish(null, ''); }
            const fetcher = client.fetch(ids, { bodies: '', struct: false });
            let pendingText = [];
            fetcher.on('message', (msg) => {
              let chunks = [];
              msg.on('body', (stream) => {
                stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              });
              msg.once('end', () => pendingText.push(Buffer.concat(chunks).toString('utf8')));
            });
            fetcher.once('error', (err) => { clearTimeout(timer); finish(err); });
            fetcher.once('end', () => {
              clearTimeout(timer);
              for (const raw of pendingText) {
                if (!/target|verification|security|code|passcode|login|sign/i.test(raw)) continue;
                const code = maybeOtp(raw);
                if (code) return finish(null, code);
              }
              if (debug) debug.write('imap-no-code.txt', `No Target OTP code found for ${email}. Checked ${pendingText.length} recent emails.`);
              finish(null, '');
            });
          });
        });
      });
      client.once('error', (err) => { clearTimeout(timer); finish(err); });
      client.once('end', () => {});
      client.connect();
    });
  }

  async function enterOtpIfNeeded(page, credential, debug) {
    const otpInput = await firstVisible(page, [
      'input[name="verificationCode"]', 'input[name="otp"]', 'input[name="code"]', 'input[inputmode="numeric"]', 'input[type="tel"]'
    ], 7000);
    if (!otpInput) return false;
    await debug.shot(page, 'otp-requested');
    const email = clean(credential.login_email || credential.email);
    const appPassword = clean(credential.gmail_app_password || credential.imap_password || credential.app_password);
    const code = await fetchOtpFromImap({ email, appPassword, debug });
    if (!code) throw new Error('Target asked for an OTP, but no OTP was found in IMAP for this profile. Confirm the profile has a Gmail app password/IMAP password saved.');
    await otpInput.fill(code);
    const btn = await firstVisible(page, ['button:has-text("Verify")', 'button:has-text("Continue")', 'button:has-text("Submit")', 'button[type="submit"]'], 4000);
    if (btn) await btn.click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await sleep(3000);
    await debug.shot(page, 'after-otp');
    return true;
  }

  async function loginTarget(page, credential, debug) {
    const email = clean(credential.login_email || credential.email);
    const password = clean(credential.login_password || credential.password);
    if (!email || !password) throw new Error('Missing Target login email or password for this profile.');
    await page.goto('https://www.target.com/account/orders', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await debug.shot(page, 'orders-page');
    let body = await getText(page);
    if (/orders|purchases/i.test(body) && !/sign in|email or mobile phone/i.test(body)) return;

    const signIn = await firstVisible(page, ['button:has-text("Sign in")', 'a:has-text("Sign in")'], 5000);
    if (signIn) { await signIn.click().catch(() => {}); await sleep(1500); }
    await debug.shot(page, 'signin-page');

    const emailInput = await firstVisible(page, ['input[type="email"]', 'input[name="username"]', 'input[name="login"]', 'input[autocomplete="username"]'], 20000);
    if (!emailInput) throw new Error(`Target email field did not appear. Page text: ${(await getText(page)).slice(0, 700)}`);
    await emailInput.fill(email);
    const cont = await firstVisible(page, ['button:has-text("Continue")', 'button:has-text("Sign in")', 'button[type="submit"]'], 8000);
    if (cont) await cont.click(); else await page.keyboard.press('Enter');
    await sleep(4000);
    await debug.shot(page, 'after-email-submit');

    await enterOtpIfNeeded(page, credential, debug).catch((e) => { throw e; });
    const passInput = await firstVisible(page, ['input[type="password"]', 'input[name="password"]', 'input#password'], 25000);
    if (!passInput) {
      const text = await getText(page);
      debug.write('password-not-visible.txt', text.slice(0, 3000));
      throw new Error(`Target password field did not appear. This usually means Target showed a challenge, blocked the proxy, or changed the login page. Debug files: ${debug.shots.join(', ')}. Page text: ${text.slice(0, 500)}`);
    }
    await passInput.fill(password);
    const submit = await firstVisible(page, ['button:has-text("Sign in")', 'button:has-text("Log in")', 'button[type="submit"]'], 8000);
    if (submit) await submit.click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await sleep(4000);
    await debug.shot(page, 'after-password-submit');
    await enterOtpIfNeeded(page, credential, debug).catch((e) => { throw e; });
  }

  async function checkTargetOrder(order, credential) {
    const { chromium } = require('playwright');
    const debug = makeDebug(staticRoot, order.external_order_id || order.id);
    const raw = order.raw_payload || {};
    const expectedSku = clean(order.sku || getField(raw, 'SKU'));
    const expectedProduct = clean(order.product_name || getField(raw, 'Product'));
    const orderNumber = clean(order.external_order_id || getField(raw, 'Order ID') || raw.order_id || raw.order_number);
    const proxy = parseProxy(order.metadata?.proxy || raw.proxy || getField(raw, 'Proxy'));
    const stateDir = path.join(__dirname, '.target-sessions');
    fs.mkdirSync(stateDir, { recursive: true });
    const email = clean(credential.login_email || credential.email);
    const stateFile = path.join(stateDir, `${crypto.createHash('sha256').update(email || String(order.user_id)).digest('hex')}.json`);

    const browser = await chromium.launch({ headless: String(process.env.ORDER_RECHECK_HEADLESS || 'true') !== 'false', proxy: proxy || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let context;
    try {
      context = await browser.newContext({ storageState: fs.existsSync(stateFile) ? stateFile : undefined, recordVideo: { dir: debug.dir } });
    } catch (_) { context = await browser.newContext({ recordVideo: { dir: debug.dir } }); }
    const page = await context.newPage();
    try {
      await loginTarget(page, credential, debug);
      await context.storageState({ path: stateFile }).catch(() => {});
      const orderUrls = [
        `https://www.target.com/account/orders/${encodeURIComponent(orderNumber)}`,
        `https://www.target.com/account/orders?searchTerm=${encodeURIComponent(orderNumber)}`,
        'https://www.target.com/account/orders'
      ];
      let found = false;
      let finalText = '';
      for (const url of orderUrls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(5000);
        await debug.shot(page, `order-check-${orderUrls.indexOf(url) + 1}`);
        finalText = await getText(page);
        if (norm(finalText).includes(norm(orderNumber)) || textHasExpectedItem(finalText, expectedSku, expectedProduct)) {
          found = textHasExpectedItem(finalText, expectedSku, expectedProduct);
          if (found) break;
        }
      }
      debug.write('final-page-text.txt', finalText.slice(0, 10000));
      await context.close().catch(() => {});
      const videos = [];
      try {
        for (const f of fs.readdirSync(debug.dir)) if (/\.webm$/i.test(f)) videos.push(debug.rel(path.join(debug.dir, f)));
      } catch (_) {}
      return { itemFound: found, orderNumber, expectedSku, expectedProduct, debugFiles: [...debug.shots, ...videos] };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  app.post('/admin/orders/:id/recheck-order', auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const { data: order, error } = await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!order?.id) return res.status(404).json({ error: 'Order not found' });
      const targetUser = await getUserById(order.user_id);
      if (!(await canManageTarget(currentUser, targetUser))) return res.status(403).json({ error: 'You do not have access to this user.' });
      if (!String(order.site || '').toLowerCase().includes('target') && !String(order.source || '').toLowerCase().includes('target')) return res.status(400).json({ error: 'Automated order recheck is currently Target-only.' });
      const { credential } = await findCredentials(order);
      if (!credential) return res.status(400).json({ error: 'No Target login credentials found for this order/profile.' });
      const result = await checkTargetOrder(order, credential);
      let refunded = 0;
      if (!result.itemFound && Number(order.credits_charged || 0) > 0 && !String(order.status || '').includes('order_recheck_refunded')) {
        refunded = asWholeCredits(order.credits_charged, 0);
        await adjustUserCredits({
          userId: order.user_id,
          delta: refunded,
          reason: 'order_recheck_item_missing_refund',
          note: `Auto refund: Target order ${result.orderNumber} did not contain ${result.expectedSku || result.expectedProduct}`,
          metadata: { order_id: order.id, external_order_id: order.external_order_id, expected_sku: result.expectedSku, expected_product: result.expectedProduct, debug_files: result.debugFiles },
          createdBy: currentUser.id,
          orderId: order.id
        });
      }
      await supabase.from('orders').update({
        status: result.itemFound ? 'success_order_rechecked' : 'success_order_recheck_refunded',
        metadata: { ...(order.metadata || {}), order_recheck: { ...result, refunded_credits: refunded, checked_at: new Date().toISOString() } }
      }).eq('id', order.id);
      res.json({ success: true, ...result, refundedCredits: refunded });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || String(err) });
    }
  });
};
