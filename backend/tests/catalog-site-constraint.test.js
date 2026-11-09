'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const routesSource = fs.readFileSync(path.join(projectRoot, 'backend', 'product-catalog-routes.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(projectRoot, 'backend', 'sql', '2026-10-30-expand-catalog-product-sites.sql'), 'utf8');

assert.match(routesSource, /catalogSiteConstraintError\(site\)/, 'constraint failures must identify the selected store');
assert.doesNotMatch(routesSource, /Database constraint is blocking Sam's Club products/, 'the handler must not label every store as Sam\'s Club');
assert.match(routesSource, /2026-10-30-expand-catalog-product-sites\.sql/, 'the error must point to the unified catalog-site migration');

for (const site of ['amazon', 'target', 'walmart', 'samsclub', 'crunchyroll', 'pokemon', 'supreme', 'general']) {
    assert.match(migrationSource, new RegExp(`'${site}'`), `the database constraint must allow ${site}`);
}

assert.match(migrationSource, /product_catalogs_site_check/, 'the catalog-container constraint must be updated');
assert.match(migrationSource, /catalog_products_site_check/, 'the catalog-product constraint must be updated');

console.log('Catalog site constraint tests passed');
