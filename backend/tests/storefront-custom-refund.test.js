const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  allocateCustomRefundCents,
  parseCustomRefundAmountCents
} = require('../storefront-custom-refund');

assert.equal(parseCustomRefundAmountCents('5'), 500);
assert.equal(parseCustomRefundAmountCents('7.00'), 700);
assert.equal(parseCustomRefundAmountCents('$10.25'), 1025);
assert.equal(parseCustomRefundAmountCents(''), null);
assert.equal(parseCustomRefundAmountCents(null), null);
assert.equal(Number.isNaN(parseCustomRefundAmountCents('0')), true);
assert.equal(Number.isNaN(parseCustomRefundAmountCents('-5')), true);
assert.equal(Number.isNaN(parseCustomRefundAmountCents('5.999')), true);

const sales = [
  { id: 'sale-1', total_cents: 400, metadata: { refunded_amount_cents: 100 } },
  { id: 'sale-2', total_cents: 1000, metadata: {} }
];
const allocations = allocateCustomRefundCents(sales, 500);
assert.deepEqual(allocations.map((row) => [row.sale.id, row.amount]), [
  ['sale-1', 300],
  ['sale-2', 200]
]);
assert.equal(sales[0].metadata.refunded_amount_cents, 100, 'allocation must not mutate sale metadata');

const root = path.join(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(root, 'backend', 'shop-routes.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'frontend', 'admin-store.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'frontend', 'admin-store.html'), 'utf8');

assert.match(adminHtml, /id="storeRefundCustomAmount"/);
assert.match(adminHtml, /Custom refund amount \(no item refund\)/);
assert.match(adminJs, /custom_refund_amount:/);
assert.match(adminJs, /No item quantities or inventory will be changed/);
assert.match(routes, /refund_mode:\s*customAmountMode \? 'custom_amount'/);
assert.match(routes, /if \(customAmountMode\) \{[\s\S]*allocateCustomRefundCents/);
assert.match(routes, /custom_amount:\s*true/);

console.log('storefront custom refund tests passed');
