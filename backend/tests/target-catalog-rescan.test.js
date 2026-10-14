'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildTargetCatalogRefreshPatch, usableTargetTitle } = require('../target-catalog-refresh');

const existing = {
    id: 'product-1',
    sku: '1012944767',
    product_name: 'Star Trek Bundle',
    brand: 'Target',
    image_url: '',
    product_url: 'https://www.target.com/p/-/A-1012944767',
    default_max_price: 125,
    credit_cost: 2,
    metadata: { manually_added: true }
};
const lookup = {
    sku: existing.sku,
    product_name: 'Magic The Gathering | Star Trek Draft Night',
    brand: 'Magic: The Gathering',
    image_url: 'https://target.scene7.com/is/image/Target/GUEST-test',
    product_url: 'https://www.target.com/p/magic-the-gathering-star-trek-draft-night/-/A-1012944767',
    default_max_price: 139.99,
    metadata: { source: 'target_direct_product' }
};

const refreshed = buildTargetCatalogRefreshPatch(existing, lookup, '2026-10-14T19:30:00.000Z');
assert.deepStrictEqual(refreshed.changedFields, ['name', 'image', 'url', 'price', 'brand']);
assert.strictEqual(refreshed.patch.product_name, lookup.product_name);
assert.strictEqual(refreshed.patch.default_max_price, 139.99);
assert.strictEqual(refreshed.patch.image_url, lookup.image_url);
assert.strictEqual(refreshed.patch.brand, lookup.brand);
assert.strictEqual(refreshed.patch.credit_cost, undefined, 'a Target refresh must never overwrite the saved credit cost');
assert.strictEqual(refreshed.patch.metadata.manually_added, true, 'existing metadata must be preserved');

const missingLookup = buildTargetCatalogRefreshPatch(existing, {
    sku: existing.sku,
    product_name: existing.sku,
    image_url: '',
    product_url: '',
    default_max_price: null,
    brand: 'Target',
    metadata: { lookup_failed: true }
});
assert.strictEqual(missingLookup.lookupUsable, false);
assert.deepStrictEqual(missingLookup.patch, {}, 'unusable Target results must not erase saved fields');

const alreadyCurrent = buildTargetCatalogRefreshPatch({ ...existing, ...lookup }, lookup);
assert.strictEqual(alreadyCurrent.lookupUsable, true);
assert.deepStrictEqual(alreadyCurrent.patch, {}, 'an unchanged Target result must not write to the database');
assert.strictEqual(usableTargetTitle('Target : Expect More. Pay Less.', existing.sku), '');
assert.strictEqual(usableTargetTitle('Access Denied', existing.sku), '');

const projectRoot = path.resolve(__dirname, '..', '..');
const routesSource = fs.readFileSync(path.join(projectRoot, 'backend', 'product-catalog-routes.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');

assert.match(routesSource, /refreshTargetCatalogProduct\(supabase, sku\)/, 'entered existing Target SKUs must be rescanned');
assert.match(routesSource, /app\.post\('\/admin\/catalog-products\/rescan-target-batch'/, 'the catalog must expose a resumable batch rescan route');
assert.match(routesSource, /status:\s*'skipped_grouped'/, 'grouped multi-SKU products must be preserved instead of being overwritten by one item');
assert.match(serverSource, /const preferTargetCatalog = next\.site === 'target' && !!next\.sku/);
assert.match(serverSource, /next\.title = preferTargetCatalog \? \(catalog\.title \|\| next\.title\)/, 'Target monitor alerts must prefer the official catalog title');
assert.match(frontendSource, /targetCatalogRescanOffset/, 'the browser must keep a checkpoint so a stopped full rescan can resume');
assert.match(adminHtml, /Rescan all Target catalog products/);
assert.match(adminHtml, /Credit cost is never changed/);

console.log('Target catalog rescan tests passed');
