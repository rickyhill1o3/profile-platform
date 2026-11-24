const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeTargetRaffleEmail,
  targetRaffleCheckoutLinkKey,
  buildTargetRaffleCheckoutLink,
  targetRaffleCheckoutLinkIsActiveAt,
  consumeTargetRaffleCheckoutLink,
  releaseTargetRaffleCheckoutLink
} = require('../target-raffle-checkout-links');

assert.strictEqual(normalizeTargetRaffleEmail(' Winner@Example.COM '), 'winner@example.com');
assert.strictEqual(targetRaffleCheckoutLinkKey('Winner@Example.COM'), 'target_raffle_checkout:winner@example.com');

const link = buildTargetRaffleCheckoutLink({
  accountEmail: 'Winner@Example.COM',
  userId: 'user-123',
  linkedBy: 'super-1',
  linkedAt: '2026-11-19T17:00:00.000Z'
});
assert.strictEqual(link.status, 'active');
assert.strictEqual(link.target_login_email, 'winner@example.com');
assert.strictEqual(targetRaffleCheckoutLinkIsActiveAt(link, '2026-11-19T16:59:59.000Z'), false,
  'an older webhook must not use a newly created link');
assert.strictEqual(targetRaffleCheckoutLinkIsActiveAt(link, '2026-11-19T17:00:01.000Z'), true);
assert.strictEqual(consumeTargetRaffleCheckoutLink(link, { userId: 'different-user' }), null);

const consumed = consumeTargetRaffleCheckoutLink(link, {
  userId: 'user-123',
  orderId: 'order-row-1',
  externalOrderId: 'target-order-1',
  consumedAt: '2026-11-19T17:01:00.000Z'
});
assert.strictEqual(consumed.status, 'consumed');
assert.strictEqual(consumed.consumed_order_id, 'order-row-1');
assert.strictEqual(consumed.consumed_external_order_id, 'target-order-1');
assert.strictEqual(targetRaffleCheckoutLinkIsActiveAt(consumed, '2026-11-19T17:02:00.000Z'), false);

const released = releaseTargetRaffleCheckoutLink(link, {
  releasedBy: 'super-1',
  releasedAt: '2026-11-19T17:03:00.000Z'
});
assert.strictEqual(released.status, 'released');
assert.strictEqual(released.released_by, 'super-1');

const root = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');

const finderStart = serverSource.indexOf('async function findUserForWebhook');
const finderEnd = serverSource.indexOf('async function', finderStart + 20);
const finderSource = serverSource.slice(finderStart, finderEnd);
assert.ok(finderSource.indexOf('findTargetRaffleCheckoutOwnerAt') >= 0);
assert.ok(finderSource.indexOf('findTargetRaffleCheckoutOwnerAt') < finderSource.indexOf('findTargetExtraAccountOwnerAt'),
  'the one-time raffle link must override normal extra-account ownership');
assert.match(serverSource, /target_raffle_checkout_link:\s*user\.target_raffle_checkout_link/);
assert.match(serverSource, /consumeTargetRaffleCheckoutLinkForOrder\(order\)/);
assert.match(serverSource, /\/admin\/target-raffle-checkout-links\/release/);
assert.match(serverSource, /app\.post\('\/admin\/target-raffle-checkout-links'/);
assert.match(adminSource, /Raffle Checkout Links/);
assert.match(adminSource, /id="targetRaffleAccountSelect"/);
assert.match(adminSource, /id="targetRaffleUserSelect"/);
assert.match(adminSource, /id="linkTargetRaffleCheckoutButton"/);
assert.match(adminSource, /script\.js\?v=20261124-astral-checkout-counts/);
assert.match(scriptSource, /The next successful Target checkout/);
assert.match(scriptSource, /target-raffle-checkout-links\/release/);
assert.match(scriptSource, /Recheck raffle user/);
assert.match(scriptSource, /use_raffle_link:\s*true/);
assert.match(serverSource, /const useRaffleLink = req\.body\?\.use_raffle_link === true/);
assert.match(serverSource, /No active raffle checkout link exists/);
assert.match(serverSource, /raffle_link_consumed:\s*raffleLinkConsumed/);

console.log('Target raffle checkout-link tests passed.');
