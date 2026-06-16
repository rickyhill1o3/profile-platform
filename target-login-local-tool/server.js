require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 7777);
const SESSION_DIR = path.resolve(__dirname, process.env.TARGET_SESSION_DIR || './sessions');
const LOG_DIR = path.resolve(__dirname, process.env.TARGET_LOG_DIR || './logs');
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function safeKey(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 180);
}

function parseProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const p = value.split(':');
  if (p.length < 2) throw new Error('Proxy must be ip:port or ip:port:user:pass');
  const [host, port, username, ...rest] = p;
  const password = rest.join(':') || undefined;
  return {
    server: `http://${host}:${port}`,
    username: username || undefined,
    password: password || undefined,
    display: `${host}:${port}${username ? ':***:***' : ''}`
  };
}

function logWriter(name) {
  const file = path.join(LOG_DIR, `${Date.now()}-${safeKey(name)}.txt`);
  const write = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(file, line);
    console.log(line.trim());
  };
  return { file, write };
}

async function launchPersistent({ email, proxyRaw, headless = false, log }) {
  const sessionKey = safeKey(email);
  if (!sessionKey) throw new Error('Email/account is required');
  const userDataDir = path.join(SESSION_DIR, sessionKey);
  fs.mkdirSync(userDataDir, { recursive: true });
  const proxy = parseProxy(proxyRaw || process.env.TARGET_PROXY || '');
  const launchOptions = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--start-maximized'
    ]
  };
  if (proxy) launchOptions.proxy = { server: proxy.server, username: proxy.username, password: proxy.password };
  log(`Launching Chrome for ${email}${proxy ? ` through proxy ${proxy.display}` : ''}. headless=${headless}`);
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  return { context, sessionKey, userDataDir };
}

app.post('/api/capture-session', async (req, res) => {
  const { email, proxy, startUrl } = req.body || {};
  const { file, write } = logWriter(`capture-${email}`);
  let context;
  try {
    ({ context } = await launchPersistent({ email, proxyRaw: proxy, headless: false, log: write }));
    const page = context.pages()[0] || await context.newPage();
    const url = startUrl || 'https://www.target.com/orders';
    write(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    write('Browser is open. Complete Target login manually. Then return to this app and click Save Session.');
    global.currentCapture = { context, email, file };
    res.json({ ok: true, message: 'Chrome opened. Login manually, then click Save Session.', log: `/logs/${path.basename(file)}` });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    write(`ERROR: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: err.message, log: `/logs/${path.basename(file)}` });
  }
});


app.post('/api/capture-existing-chrome', async (req, res) => {
  const { email, cdpUrl } = req.body || {};
  const { file, write } = logWriter(`existing-chrome-${email}`);
  let browser;
  try {
    if (!email) throw new Error('Email/account is required');
    const endpoint = cdpUrl || 'http://127.0.0.1:9222';
    write(`Connecting to existing Chrome over CDP: ${endpoint}`);
    write('Chrome must be started with --remote-debugging-port=9222 first.');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Connected to Chrome, but no browser context was found. Open a normal Chrome tab first.');
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    const currentUrl = page.url();
    write(`Connected. Current tab URL: ${currentUrl}`);
    write('If you are not logged into Target yet, login manually in the existing Chrome window. Then return here and click Save Session After Login.');
    global.currentCapture = { context, browser, email, file, existingChrome: true };
    res.json({ ok: true, message: 'Connected to existing Chrome. Login manually if needed, then click Save Session After Login.', log: `/logs/${path.basename(file)}` });
  } catch (err) {
    write(`ERROR: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: err.message, log: `/logs/${path.basename(file)}` });
  }
});

app.post('/api/save-session', async (req, res) => {
  const current = global.currentCapture;
  if (!current) return res.status(400).json({ ok: false, error: 'No active capture browser. Click Capture Session first.' });
  const { context, email, file } = current;
  const write = (msg) => fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  try {
    const statePath = path.join(SESSION_DIR, `${safeKey(email)}.storageState.json`);
    await context.storageState({ path: statePath });
    write(`Saved storage state: ${statePath}`);
    if (current.existingChrome && current.browser) {
      await current.browser.close().catch(() => {});
    } else {
      await context.close();
    }
    global.currentCapture = null;
    res.json({ ok: true, message: 'Session saved.', statePath, log: `/logs/${path.basename(file)}` });
  } catch (err) {
    write(`ERROR saving session: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: err.message, log: `/logs/${path.basename(file)}` });
  }
});

app.post('/api/check-order', async (req, res) => {
  const { email, proxy, orderId, expectedName, expectedSku } = req.body || {};
  const { file, write } = logWriter(`check-${email}-${orderId}`);
  let context;
  try {
    ({ context } = await launchPersistent({ email, proxyRaw: proxy, headless: String(process.env.TARGET_HEADLESS).toLowerCase() === 'true', log: write }));
    const page = context.pages()[0] || await context.newPage();
    const url = 'https://www.target.com/orders';
    write(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
    const body = await page.textContent('body').catch(() => '');
    const foundOrder = orderId ? body.includes(String(orderId)) : false;
    const foundName = expectedName ? body.toLowerCase().includes(String(expectedName).toLowerCase()) : null;
    const foundSku = expectedSku ? body.includes(String(expectedSku)) : null;
    write(`foundOrder=${foundOrder} foundName=${foundName} foundSku=${foundSku}`);
    await context.close();
    res.json({ ok: true, foundOrder, foundName, foundSku, log: `/logs/${path.basename(file)}` });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    write(`ERROR: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: err.message, log: `/logs/${path.basename(file)}` });
  }
});

app.use('/logs', express.static(LOG_DIR));
app.listen(PORT, () => console.log(`Target local login tool running: http://localhost:${PORT}`));
