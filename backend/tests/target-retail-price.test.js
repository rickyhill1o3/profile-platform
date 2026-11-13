'use strict';

const assert = require('assert');
const {
  parseRetailMoney,
  findPriceInStructuredData,
  extractTargetRetailPrice,
  extractTargetRedskyKey,
  extractTargetRedskyProduct
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

assert.strictEqual(
  extractTargetRedskyKey('<script>fetch("https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcin=1012944745")</script>'),
  '9f36aeafbe60771e321a7cc95a78140772ab3e96'
);
const redsky = extractTargetRedskyProduct({
  data: {
    product: {
      tcin: '1012944745',
      price: { current_retail: 29.99, formatted_current_price: '$29.99' },
      item: {
        product_description: { title: 'Mega Forces Tin - Darkrai ex' },
        primary_brand: { name: 'Pokémon' },
        enrichment: { images: { primary_image_url: 'https://target.scene7.com/example.jpg' } }
      }
    }
  }
}, '1012944745');
assert.strictEqual(redsky.price, 29.99);
assert.strictEqual(redsky.title, 'Mega Forces Tin - Darkrai ex');
assert.strictEqual(extractTargetRedskyProduct({ data: { product: { tcin: 'WRONG', price: { current_retail: 1 } } } }, '1012944745'), null);

console.log('Target retail price tests passed.');
