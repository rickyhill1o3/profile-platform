'use strict';

// The install/start hooks put Chromium inside node_modules so Render includes it in
// the deployed build. This must be set before Playwright is required.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const fs = require('fs');
const {
  parseRetailMoney,
  extractTargetRedskyProduct
} = require('./target-retail-price');

let browserPromise = null;
let browserIdleTimer = null;
let serialQueue = Promise.resolve();

function browserlessEndpoint() {
  return String(
    process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT ||
    process.env.BROWSERLESS_CDP_ENDPOINT ||
    process.env.BROWSERLESS_WS_ENDPOINT ||
    process.env.PLAYWRIGHT_WS_ENDPOINT ||
    ''
  ).trim();
}

function endpointWithBrowserOptions(endpoint) {
  if (!endpoint) return '';
  const separator = endpoint.includes('?') ? '&' : '?';
  const timeout = Math.max(10000, Math.min(60000, Number(process.env.TARGET_PRICE_BROWSER_TIMEOUT_MS || 60000)));
  return `${endpoint}${separator}stealth=true&headless=true&blockAds=true&timeout=${timeout}`;
}

function loadChromium() {
  try {
    return require('playwright').chromium;
  } catch (_) {
    try {
      return require('playwright-core').chromium;
    } catch (error) {
      throw new Error('Playwright is not installed. Run npm install in the backend and redeploy.');
    }
  }
}

function localChromiumLaunchOptions() {
  const options = {
    headless: true,
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
  const executablePath = [
    String(process.env.TARGET_PRICE_CHROMIUM_EXECUTABLE || '').trim(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (executablePath) options.executablePath = executablePath;
  return options;
}

async function getBrowser() {
  const endpoint = browserlessEndpoint();
  if (!browserPromise) {
    const chromium = loadChromium();
    const openBrowser = endpoint
      ? chromium.connectOverCDP(endpointWithBrowserOptions(endpoint))
      : chromium.launch(localChromiumLaunchOptions());
    browserPromise = openBrowser.catch((error) => {
      browserPromise = null;
      if (!endpoint && /executable|browser.*not found|does not exist/i.test(String(error?.message || error))) {
        throw new Error('Local Chromium is not installed in the Render build. Clear the Render build cache and redeploy so the backend prestart step can download Chromium.');
      }
      throw error;
    });
  }
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

function scheduleBrowserClose() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  const idleMs = Math.max(5000, Math.min(120000, Number(process.env.TARGET_PRICE_BROWSER_IDLE_MS || 30000)));
  browserIdleTimer = setTimeout(async () => {
    const pendingBrowser = browserPromise;
    browserPromise = null;
    browserIdleTimer = null;
    if (!pendingBrowser) return;
    try {
      const browser = await pendingBrowser;
      await browser.close();
    } catch (_) {}
  }, idleMs);
  if (typeof browserIdleTimer.unref === 'function') browserIdleTimer.unref();
}

function isTargetBlockPage(title, bodyText) {
  return /access denied|verify you are human|unusual traffic|checking your browser|automated quer/i.test(`${title}\n${bodyText}`);
}

async function scrapeTargetPriceUnlocked(sku) {
  const cleanSku = String(sku || '').trim();
  if (!cleanSku) throw new Error('Target SKU is required.');
  const browser = await getBrowser();
  const contexts = browser.contexts();
  const existingContext = contexts[0] || null;
  const context = existingContext || await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1365, height: 900 },
    userAgent: String(process.env.TARGET_PRICE_USER_AGENT || '').trim() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const directUrl = `https://www.target.com/p/-/A-${encodeURIComponent(cleanSku)}`;
  const timeout = Math.max(10000, Math.min(60000, Number(process.env.TARGET_PRICE_PAGE_TIMEOUT_MS || 45000)));
  const priceSelectors = [
    '[data-test="module-product-detail-price-v2"]',
    '[data-test="price-cdui"]',
    '[data-test="product-price"]',
    '[itemprop="price"]',
    'meta[property="product:price:amount"]'
  ];
  let renderedRedskyProduct = null;
  let resolveRenderedRedsky;
  const renderedRedskySignal = new Promise((resolve) => { resolveRenderedRedsky = resolve; });
  page.on('response', (response) => {
    if (renderedRedskyProduct || !/redsky_aggregations\/v1\/web\/pdp_client_v1/i.test(response.url())) return;
    response.json().then((payload) => {
      const product = extractTargetRedskyProduct(payload, cleanSku);
      if (!(Number(product?.price) > 0)) return;
      renderedRedskyProduct = product;
      resolveRenderedRedsky({ type: 'redsky', product });
    }).catch(() => null);
  });
  try {
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout });
    const domPriceSignal = page.waitForFunction((selectors) => selectors.some((selector) => {
      const element = document.querySelector(selector);
      const value = element?.getAttribute?.('content') || element?.textContent || '';
      return /\$?\s*[0-9]+(?:\.[0-9]{1,2})?/.test(value);
    }), priceSelectors, { timeout })
      .then(() => ({ type: 'dom' }))
      .catch((error) => ({ type: 'dom_error', error }));
    const ready = await Promise.race([domPriceSignal, renderedRedskySignal]);

    const pageData = await page.evaluate(({ selectors, expectedSku }) => {
      const matchedPrice = selectors
        .map((selector) => ({ selector, element: document.querySelector(selector) }))
        .find((entry) => {
          const value = entry.element?.getAttribute?.('content') || entry.element?.textContent || '';
          return /\$?\s*[0-9]+(?:\.[0-9]{1,2})?/.test(value);
        });
      const title = String(document.querySelector('h1')?.textContent || document.title || '').trim();
      const bodyText = String(document.body?.innerText || '').slice(0, 5000);
      return {
        title,
        bodyText,
        priceText: String(matchedPrice?.element?.getAttribute?.('content') || matchedPrice?.element?.textContent || '').trim(),
        priceSelector: matchedPrice?.selector || '',
        finalUrl: location.href,
        hasExpectedSku: document.documentElement.innerHTML.includes(expectedSku)
      };
    }, { selectors: priceSelectors, expectedSku: cleanSku });

    if (!renderedRedskyProduct && ready?.type === 'redsky') renderedRedskyProduct = ready.product;

    const hasExactRenderedRedskyPrice = Number(renderedRedskyProduct?.price) > 0;
    if (isTargetBlockPage(pageData.title, pageData.bodyText) && !hasExactRenderedRedskyPrice) {
      throw new Error('Target blocked the browser-rendered product page. Try the rescan again later or configure an optional Browserless proxy session.');
    }
    if (!pageData.hasExpectedSku && !pageData.finalUrl.includes(`A-${cleanSku}`) && !hasExactRenderedRedskyPrice) {
      throw new Error('Target redirected away from the requested product page.');
    }
    const domPrice = parseRetailMoney(pageData.priceText);
    const price = domPrice || (Number(renderedRedskyProduct?.price) > 0 ? Number(renderedRedskyProduct.price) : null);
    if (!(price > 0)) throw new Error('The rendered Target product page did not show a retail price.');
    return {
      sku: cleanSku,
      price,
      source: domPrice ? 'target_rendered_product_page' : 'target_rendered_redsky_response',
      product_url: pageData.finalUrl || directUrl,
      title: String(renderedRedskyProduct?.title || pageData.title).replace(/\s*:\s*Target\s*$/i, '').trim(),
      brand: String(renderedRedskyProduct?.brand || '').trim(),
      image: String(renderedRedskyProduct?.image || '').trim(),
      selector: domPrice ? (pageData.priceSelector || priceSelectors[0]) : 'redsky:pdp_client_v1'
    };
  } finally {
    await page.close().catch(() => null);
    if (!existingContext) await context.close().catch(() => null);
    scheduleBrowserClose();
  }
}

async function scrapeTargetRenderedProductPrice(sku) {
  // One rendered Target navigation at a time keeps Render memory stable and avoids
  // triggering Target's request throttling during a full-catalog rescan.
  const task = serialQueue.then(() => scrapeTargetPriceUnlocked(sku));
  serialQueue = task.catch(() => null);
  return task;
}

module.exports = {
  browserlessEndpoint,
  endpointWithBrowserOptions,
  localChromiumLaunchOptions,
  scrapeTargetRenderedProductPrice
};
