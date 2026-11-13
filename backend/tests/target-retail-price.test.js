'use strict';

const assert = require('assert');
const {
  parseRetailMoney,
  findPriceInStructuredData,
  extractTargetRetailPrice
} = require('../target-retail-price');

assert.strictEqual(parseRetailMoney('$1,249.99'), 1249.99);
assert.strictEqual(parseRetailMoney('not a price'), null);

const direct = extractTargetRetailPrice({
  sku: '1012944745',
  offerPrice: '29.99',
  html: '<script>{"tcin":"1012944745","current_retail":99.99}</script>'
});
assert.deepStrictEqual(direct, { price: 29.99, source: 'json_ld_offer' });

const embedded = extractTargetRetailPrice({
  sku: '1012944745',
  html: '<script type="application/json">{"product":{"tcin":"1012944745","price":{"current_retail":34.99}}}</script>'
});
assert.deepStrictEqual(embedded, { price: 34.99, source: 'target_embedded_json' });

const formatted = extractTargetRetailPrice({
  sku: '1012944748',
  html: '<script type="application/json">{"product":{"tcin":"1012944748","formatted_current_price":"$44.99"}}</script>'
});
assert.deepStrictEqual(formatted, { price: 44.99, source: 'target_embedded_json' });

const unrelatedProduct = {
  products: [
    { tcin: 'OTHER-SKU', current_retail: 4.99 },
    { tcin: '1012944745', title: 'Wanted product without a saved price' }
  ]
};
assert.strictEqual(findPriceInStructuredData(unrelatedProduct, '1012944745'), null, 'a price from a different embedded product must never be used');
assert.strictEqual(extractTargetRetailPrice({
  sku: '1012944745',
  html: `<script type="application/json">${JSON.stringify(unrelatedProduct)}</script>`
}).price, null);

assert.deepStrictEqual(extractTargetRetailPrice({ sku: '1012944745', html: '<html>No product data</html>' }), { price: null, source: 'not_found' });

console.log('Target retail price tests passed.');
