const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    normalizePokemonComparisonSkus,
    buildPokemonSkuGroupDefinitions,
    groupPokemonUsersByComparedSkus
} = require('../pokemon-sku-user-groups');

const skus = ['10-10438-112', '10-10446-120', '10-10439-109'];

assert.deepStrictEqual(
    normalizePokemonComparisonSkus([' 10-10438-112 ', '10\u201110446\u2011120', '10-10438-112']),
    ['10-10438-112', '10-10446-120'],
    'SKUs should be trimmed, dash-normalized, uppercased, and de-duplicated'
);

assert.deepStrictEqual(
    buildPokemonSkuGroupDefinitions(skus).map((group) => group.id),
    ['0-1-2', '0-1', '0-2', '1-2', '0', '1', '2'],
    'three SKUs should produce all three, each two-product pair, and each single-product group'
);

const groups = groupPokemonUsersByComparedSkus([
    { user_id: 'etb-only', catalog_products: { sku: '10-10438-112' } },
    { user_id: 'all-three', catalog_products: { sku: '10-10438-112' } },
    { user_id: 'all-three', catalog_products: { sku: '10-10446-120' } },
    { user_id: 'all-three', catalog_products: { sku: '10-10439-109' } },
    { user_id: 'etb-box', catalog_products: { sku: '10-10438-112' } },
    { user_id: 'etb-box', catalog_products: { sku: '10-10446-120' } },
    { user_id: 'box-bundle', catalog_products: { sku: '10-10446-120,10-10439-109' } },
    { user_id: 'box-bundle', catalog_products: { sku: '10-10446-120' } },
    { user_id: 'ignored', catalog_products: { sku: 'SOME-OTHER-SKU' } }
], skus);

const byId = new Map(groups.map((group) => [group.id, group.user_ids]));
assert.deepStrictEqual(byId.get('0-1-2'), ['all-three']);
assert.deepStrictEqual(byId.get('0-1'), ['etb-box']);
assert.deepStrictEqual(byId.get('1-2'), ['box-bundle']);
assert.deepStrictEqual(byId.get('0'), ['etb-only']);
assert.strictEqual(groups.reduce((sum, group) => sum + group.user_ids.length, 0), 4, 'each matching user should appear in exactly one similarity group');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'product-catalog-routes.js'), 'utf8');
assert.match(routeSource, /app\.get\('\/admin\/product-selections\/pokemon-sku-groups'/, 'the admin comparison endpoint must be registered');
assert.match(routeSource, /loadActiveProductSelectionUserIds\(supabase, 'pokemon', scopedUserIds\)/, 'the comparison must use active Pokémon Center store status');
assert.match(routeSource, /filterRowsToActiveUsers\(selectionRows, activeUserIds\)/, 'paused users must be excluded from the comparison');

console.log('pokemon sku user group tests passed');
