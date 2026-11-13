'use strict';

const { parseRetailMoney } = require('./target-retail-price');

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
    return require('playwright-core').chromium;
  } catch (_) {
    try {
      return require('playwright').chromium;
    } catch (error) {
      throw new Error('Playwright is not installed. Add playwright-core to the backend dependencies and redeploy.');
    }
  }
}

async function getBrowser() {
  const endpoint = browserlessEndpoint();
  if (!endpoint) {
    throw new Error('Browser-rendered Target pricing is not configured. Set BROWSERLESS_CDP_ENDPOINT (or TARGET_PRICE_BROWSERLESS_ENDPOINT) on Render.');
  }
  if (!browserPromise) {
    browserPromise = loadChromium().connectOverCDP(endpointWithBrowserOptions(endpoint)).catch((error) => {
      browserPromise = null;
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
  const context = contexts[0] || await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1365, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
  });
  const page = await context.newPage();
  const directUrl = `https://www.target.com/p/-/A-${encodeURIComponent(cleanSku)}`;
  const timeout = Math.max(10000, Math.min(60000, Number(process.env.TARGET_PRICE_PAGE_TIMEOUT_MS || 45000)));
  try {
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout });
    const priceSelectors = [
      '[data-test="module-product-detail-price-v2"]',
      '[data-test="price-cdui"]',
      '[data-test="product-price"]'
    ];
    await page.waitForFunction((selectors) => selectors.some((selector) => {
      const element = document.querySelector(selector);
      return element && /\$\s*[0-9]/.test(element.textContent || '');
    }), priceSelectors, { timeout });

    const pageData = await page.evaluate(({ selectors, expectedSku }) => {
      const matchedPrice = selectors
        .map((selector) => ({ selector, element: document.querySelector(selector) }))
        .find((entry) => entry.element && /\$\s*[0-9]/.test(entry.element.textContent || ''));
      const title = String(document.title || document.querySelector('h1')?.textContent || '').trim();
      const bodyText = String(document.body?.innerText || '').slice(0, 5000);
      return {
        title,
        bodyText,
        priceText: String(matchedPrice?.element?.textContent || '').trim(),
        priceSelector: matchedPrice?.selector || '',
        finalUrl: location.href,
        hasExpectedSku: document.documentElement.innerHTML.includes(expectedSku)
      };
    }, { selectors: priceSelectors, expectedSku: cleanSku });

    if (isTargetBlockPage(pageData.title, pageData.bodyText)) {
      throw new Error('Target blocked the browser-rendered product page. Check the Browserless proxy/session settings.');
    }
    if (!pageData.hasExpectedSku && !pageData.finalUrl.includes(`A-${cleanSku}`)) {
      throw new Error('Target redirected away from the requested product page.');
    }
    const price = parseRetailMoney(pageData.priceText);
    if (!(price > 0)) throw new Error('The rendered Target product page did not show a retail price.');
    return {
      sku: cleanSku,
      price,
      source: 'target_rendered_product_page',
      product_url: pageData.finalUrl || directUrl,
      title: pageData.title.replace(/\s*:\s*Target\s*$/i, '').trim(),
      selector: pageData.priceSelector || priceSelectors[0]
    };
  } finally {
    await page.close().catch(() => null);
    scheduleBrowserClose();
  }
}

async function scrapeTargetRenderedProductPrice(sku) {
  // One rendered Target navigation at a time keeps Browserless stable and avoids triggering
  // Target's request throttling during a full-catalog rescan.
  const task = serialQueue.then(() => scrapeTargetPriceUnlocked(sku));
  serialQueue = task.catch(() => null);
  return task;
}

module.exports = {
  browserlessEndpoint,
  endpointWithBrowserOptions,
  scrapeTargetRenderedProductPrice
};
