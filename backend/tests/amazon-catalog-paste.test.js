const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { parseAmazonCatalogPaste } = require('../amazon-catalog-paste');

const sample = `
Pokémon TCG: 30th Celebration Poster Collection B0H77W4411
$22.00max

F1 Chrome3
Select all

2026 Topps Chrome Formula 1 - Factory Sealed - Mega Box B0HG1VWYJS
$70.00max
2025-26 Topps Chrome Updates NBA Basketball - Factory Sealed - Value Box B0H6GWQT7Y
$60.00max
2025-26 Topps Chrome Updates NBA Basketball - Factory Sealed - Mega Box B0H6GZLLNB
$80.00max

Mega Evolutions ME015
Select all
Mega Evolutions Booster Bundle B0FH5N9RH4
$40.00max
Pokemon TCG Mega Evolutions 1 Elite Trainer Box B0FH6KRSX8
$75.00max
Pokémon TCG: Mega Evolution Enhanced Booster Display Box B0FHPKXRYC
$210.00max
Pokémon Trading Card Game: Mega Evolution Booster Display B0FQFSYJWH
$210.00max
Pokémon TCG: Mega Charizard X ex Ultra-Premium Collection B0FPDLTVVV
$165.00max

Pokemon 151 1
Pokémon TCG: Scarlet &amp; Violet-151 Mini Tin B0HP3N8KKY
$30.00max

Electronics1
ASUS ROG Astral GeForce RTX 5090 B0DS2WQZ2M
$6,000.00max
`;

const parsed = parseAmazonCatalogPaste(sample);
assert.deepEqual(parsed.errors, []);
assert.equal(parsed.products.length, 11);
assert.deepEqual(parsed.categories, [
  { name: '30th Celebration', count: 1 },
  { name: 'F1 Chrome', count: 3 },
  { name: 'Mega Evolutions ME01', count: 5 },
  { name: 'Pokemon 151', count: 1 },
  { name: 'Electronics', count: 1 }
]);
assert.equal(parsed.products.find((row) => row.sku === 'B0HP3N8KKY').product_name, 'Pokémon TCG: Scarlet & Violet-151 Mini Tin');
assert.equal(parsed.products.find((row) => row.sku === 'B0DS2WQZ2M').default_max_price, 6000);

const duplicate = parseAmazonCatalogPaste(`Item One B0H77W4411\n$10.00max\nItem Two B0H77W4411\n$12.00max`);
assert.match(duplicate.errors.join(' '), /Duplicate ASIN: B0H77W4411/);

const missingPrice = parseAmazonCatalogPaste(`Item One B0H77W4411\nOther Category1`);
assert.match(missingPrice.errors.join(' '), /missing its maximum price/);

const root = path.join(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(root, 'backend', 'product-catalog-routes.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');

assert.match(routes, /\/admin\/catalog-products\/preview-amazon-replacement/);
assert.match(routes, /\/admin\/catalog-products\/replace-amazon/);
assert.match(routes, /user_product_preferences'[\s\S]*delete\(\)[\s\S]*catalog_product_id/);
assert.match(adminHtml, /id="amazonCatalogReplaceInput"/);
assert.match(adminHtml, /Clear and replace Amazon catalog/);
assert.match(adminJs, /confirmation:\s*'REPLACE AMAZON CATALOG'/);

console.log('amazon catalog paste replacement tests passed');
