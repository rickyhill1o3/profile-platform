const assert = require('assert');
const sharp = require('sharp');
const {
  checkoutEventIsSuccessful,
  buildReleaseRecapSummary,
  buildReleaseRecapGif,
  buildReleaseRecapCaption
} = require('../release-success-recap');

function checkout({ id, site = 'target', sku, product, quantity = 1, price = null, status = 'processed' }) {
  return {
    id,
    site,
    sku,
    product_name: product,
    type: 'checkout',
    webhook_type: 'checkout',
    status,
    created_at: `2026-11-13T0${id}:00:00.000Z`,
    parsed_items: [{ site, sku, product_name: product, quantity, price }],
    payload: { embeds: [{ title: 'Successful Checkout' }] }
  };
}

async function run() {
  const shikariNoPrice = checkout({ id: '1', site: 'target', sku: '101', product: 'Mega Evolution Elite Trainer Box', quantity: 2 });
  const catalogFallback = checkout({ id: '2', site: 'target', sku: '202', product: 'Celebration Binder Collection', quantity: 3 });
  const unresolved = checkout({ id: '3', site: 'target', sku: '303', product: 'Unknown Release Product' });
  const canceled = checkout({ id: '4', site: 'target', sku: '202', product: 'Celebration Binder Collection', quantity: 2 });
  const declined = checkout({ id: '5', site: 'target', sku: '202', product: 'Celebration Binder Collection', status: 'payment declined' });

  assert.strictEqual(checkoutEventIsSuccessful(shikariNoPrice), true);
  assert.strictEqual(checkoutEventIsSuccessful(declined), false);

  const summary = buildReleaseRecapSummary({
    events: [shikariNoPrice, catalogFallback, unresolved, canceled, declined],
    catalogRows: [
      { site: 'target', sku: '101', product_name: 'Mega Evolution Elite Trainer Box', default_max_price: 24.99 },
      { site: 'target', sku: '202', product_name: 'Celebration Binder Collection', default_max_price: 14.99 }
    ],
    trackedTotalsByEventId: new Map([
      ['1', { total: 53.35, status: 'confirmed' }],
      ['4', { total: 32.48, status: 'canceled' }]
    ]),
    from: '2026-11-13T00:00:00.000Z',
    to: '2026-11-14T00:00:00.000Z'
  });

  assert.strictEqual(summary.checkout_count, 4, 'declined events must be excluded');
  assert.strictEqual(summary.retailer_confirmed_checkout_count, 1);
  assert.strictEqual(summary.retailer_confirmed_spend, 53.35, 'the IMAP/order-tracker total must override product-only pricing');
  assert.strictEqual(summary.catalog_estimated_checkout_count, 1);
  assert.strictEqual(summary.catalog_estimated_spend, 44.97);
  assert.strictEqual(summary.unresolved_checkout_count, 1);
  assert.strictEqual(summary.canceled_checkout_count, 1);
  assert.strictEqual(summary.total_spend, 98.32);

  const caption = buildReleaseRecapCaption(summary, 'https://cdn.example.com/release.gif');
  assert.strictEqual(caption, 'https://cdn.example.com/release.gif', 'the manual share value should contain only the animation link');
  assert.ok(!caption.includes('customer@example.com'));

  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(
  serverSource,
  /name\.endsWith\('\.json'\) && name !== alertCacheName/,
  'the outage announcement-target cache must not be replayed as a tokenless checkout webhook'
);
  assert.match(serverSource, /sendAnnouncementFileToAllWebhooks\(animation,/);
  assert.doesNotMatch(serverSource, /function releaseRecapEmbed\(/);
  assert.doesNotMatch(serverSource, /sendAnnouncementToAllWebhooks\(webhookCaption/);

  const gifSummary = {
    ...summary,
    unresolved_checkout_count: 0,
    products: [summary.products[0]],
    unique_product_count: 1
  };
  const gif = await buildReleaseRecapGif(gifSummary);
  assert.strictEqual(gif.subarray(0, 4).toString('ascii'), 'GIF8');
  const metadata = await sharp(gif, { animated: true }).metadata();
  assert.ok(Number(metadata.pages || 0) >= 2, 'recap GIF should contain an overview frame and a product frame');

  console.log('Release success recap tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
