'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  browserlessEndpoint,
  endpointWithBrowserOptions,
  localChromiumLaunchOptions
} = require('../target-browser-price');

const prior = process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT;
process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT = 'wss://production.example.test?token=test-token';
assert.strictEqual(browserlessEndpoint(), process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT);
const endpoint = endpointWithBrowserOptions(browserlessEndpoint());
assert.match(endpoint, /stealth=true/);
assert.match(endpoint, /headless=true/);
assert.match(endpoint, /blockAds=true/);
assert.match(endpoint, /timeout=60000/);
if (prior === undefined) delete process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT;
else process.env.TARGET_PRICE_BROWSERLESS_ENDPOINT = prior;

const launchOptions = localChromiumLaunchOptions();
assert.strictEqual(launchOptions.headless, true);
assert.ok(launchOptions.args.includes('--no-sandbox'));
assert.ok(launchOptions.args.includes('--disable-dev-shm-usage'));
assert.ok(launchOptions.args.includes('--disable-blink-features=AutomationControlled'));

const source = fs.readFileSync(path.join(__dirname, '..', 'target-browser-price.js'), 'utf8');
assert.match(source, /https:\/\/www\.target\.com\/p\/-\/A-/);
assert.match(source, /data-test="module-product-detail-price-v2"/);
assert.match(source, /data-test="price-cdui"/);
assert.match(source, /target_rendered_product_page/);
assert.match(source, /target_rendered_redsky_response/);
assert.match(source, /redsky_aggregations\\\/v1\\\/web\\\/pdp_client_v1/);
assert.match(source, /One rendered Target navigation at a time/);
assert.match(source, /chromium\.launch\(localChromiumLaunchOptions\(\)\)/);
assert.match(source, /context\.close\(\)/);
assert.match(source, /scheduleBrowserClose\(\)/);

console.log('Target browser-rendered price tests passed.');
