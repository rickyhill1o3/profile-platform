const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  deriveRaffleStatus,
  chooseRaffleWinner,
  isActiveMember,
  isUserEligibleForRaffle,
  publicRaffleView,
  normalizeRafflePayload
} = require('../storefront-raffles');

const now = new Date('2026-09-16T12:00:00.000Z');
const hour = 60 * 60 * 1000;

assert.equal(deriveRaffleStatus({ starts_at: new Date(now.getTime() + hour), ends_at: new Date(now.getTime() + (2 * hour)) }, now), 'scheduled');
assert.equal(deriveRaffleStatus({ starts_at: new Date(now.getTime() - hour), ends_at: new Date(now.getTime() + hour) }, now), 'live');
assert.equal(deriveRaffleStatus({ starts_at: new Date(now.getTime() - (2 * hour)), ends_at: new Date(now.getTime() - hour) }, now), 'closed');
assert.equal(deriveRaffleStatus({ winner_user_id: 'u1', claim_expires_at: new Date(now.getTime() + hour) }, now), 'winner_selected');
assert.equal(deriveRaffleStatus({ winner_user_id: 'u1', claim_expires_at: new Date(now.getTime() - hour) }, now), 'claim_expired');
assert.equal(deriveRaffleStatus({ status: 'paid' }, now), 'paid');
assert.equal(deriveRaffleStatus({ status: 'fulfilled' }, now), 'fulfilled');
assert.equal(deriveRaffleStatus({ status: 'drawing' }, now), 'drawing');
assert.equal(deriveRaffleStatus({ status: 'canceled' }, now), 'canceled');

const activeMember = { id: 'u1', role: 'user', revoked: false, email: 'member@example.com', owner_admin_id: 'group-a' };
assert.equal(isActiveMember(activeMember), true);
assert.equal(isActiveMember({ ...activeMember, revoked: true }), false);
assert.equal(isActiveMember({ ...activeMember, role: 'admin' }), false);
assert.equal(isUserEligibleForRaffle(activeMember, { audience_type: 'all_members' }), true);
assert.equal(isUserEligibleForRaffle(activeMember, { audience_type: 'admin_group' }, ['group-a']), true);
assert.equal(isUserEligibleForRaffle(activeMember, { audience_type: 'admin_group' }, ['group-b']), false);

const entries = [
  { id: 'expired', winner_status: 'expired' },
  { id: 'eligible-a', winner_status: 'entered' },
  { id: 'eligible-b', winner_status: 'entered' }
];
assert.equal(chooseRaffleWinner(entries, () => 0).id, 'eligible-a', 'expired winners must be excluded from redraws');
assert.equal(chooseRaffleWinner([], () => 0), null);

const winnerRaffle = {
  id: 'r1', title: '30th Anniversary ETB', retail_price_cents: 7000, shipping_price_cents: 895,
  starts_at: new Date(now.getTime() - hour).toISOString(), ends_at: new Date(now.getTime() - 1000).toISOString(),
  winner_user_id: 'winner-user', winner_entry_id: 'entry-1', claim_expires_at: new Date(Date.now() + hour).toISOString(),
  entries: [
    { id: 'entry-1', user_id: 'winner-user', entered_at: now.toISOString(), winner_status: 'selected' },
    { id: 'entry-2', user_id: 'other-user', entered_at: now.toISOString(), winner_status: 'entered' }
  ]
};
const winnerView = publicRaffleView(winnerRaffle, 'winner-user');
const otherView = publicRaffleView(winnerRaffle, 'other-user');
assert.equal(winnerView.viewer_is_winner, true);
assert.equal(winnerView.can_checkout, true);
assert.ok(winnerView.claim_expires_at, 'winner sees private claim deadline');
assert.equal(otherView.viewer_is_winner, false);
assert.equal(otherView.can_checkout, false);
assert.equal(otherView.claim_expires_at, null, 'non-winner does not receive private checkout state');
assert.equal(otherView.winner_purchase_status, null);

const runtimeNow = new Date();
const liveManualRaffle = {
  id: 'manual-r1', title: 'Manual entry raffle', retail_price_cents: 7000, shipping_price_cents: 0,
  starts_at: new Date(runtimeNow.getTime() - hour).toISOString(), ends_at: new Date(runtimeNow.getTime() + hour).toISOString(),
  entries: [{ id: 'manual-entry', user_id: 'entered-user', entered_at: runtimeNow.toISOString(), winner_status: 'entered' }]
};
const enteredView = publicRaffleView(liveManualRaffle, 'entered-user', true);
const eligibleView = publicRaffleView(liveManualRaffle, 'eligible-user', true);
assert.equal(enteredView.entered, true);
assert.equal(enteredView.can_enter, false);
assert.equal(eligibleView.entered, false);
assert.equal(eligibleView.can_enter, true);
assert.equal(eligibleView.entry_count, 1, 'entry count must count deliberate entries, not all eligible accounts');

const payload = normalizeRafflePayload({
  linked_storefront_product_id: 'product-1',
  title: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box',
  audience_type: 'all_members', fulfillment_mode: 'purchase',
  retail_price: '70.00', shipping_price: '8.95', market_value_low: '150', market_value_high: '170',
  starts_at: '2026-09-16T12:00:00.000Z', ends_at: '2026-09-18T12:00:00.000Z',
  winner_claim_hours: 24, hide_linked_product: true
});
assert.equal(payload.retail_price_cents, 7000);
assert.equal(payload.shipping_price_cents, 895);
assert.equal(payload.market_value_low_cents, 15000);
assert.equal(payload.market_value_high_cents, 17000);
assert.equal(payload.hide_linked_product, true);
assert.equal(payload.audience_type, 'all_members');
assert.equal(payload.fulfillment_mode, 'purchase');

const freePayload = normalizeRafflePayload({
  linked_storefront_product_id: 'product-2', title: 'Knock Out Pack',
  audience_type: 'admin_group', audience_admin_id: 'apex-admin', fulfillment_mode: 'free',
  retail_price: 99, shipping_price: 10,
  starts_at: '2026-09-16T12:00:00.000Z', ends_at: '2026-09-18T12:00:00.000Z'
});
assert.equal(freePayload.retail_price_cents, 0);
assert.equal(freePayload.shipping_price_cents, 0);
assert.equal(freePayload.audience_admin_id, 'apex-admin');

assert.throws(() => normalizeRafflePayload({
  linked_storefront_product_id: 'product-1', title: 'Invalid', retail_price: 70, shipping_price: 0,
  starts_at: '2026-09-18T12:00:00.000Z', ends_at: '2026-09-16T12:00:00.000Z'
}), /end time/i);

const root = path.join(__dirname, '..', '..');
const shopRoutes = fs.readFileSync(path.join(root, 'backend', 'shop-routes.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'frontend', 'admin-store.html'), 'utf8');
const raffleHtml = fs.readFileSync(path.join(root, 'frontend', 'raffle.html'), 'utf8');
const raffleJs = fs.readFileSync(path.join(root, 'frontend', 'raffle.js'), 'utf8');
const publicHomeHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const publicShopHtml = fs.readFileSync(path.join(root, 'frontend', 'shop.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'backend', 'sql', 'STOREFRONT_RAFFLES.sql'), 'utf8');

assert.ok(shopRoutes.includes("registerStorefrontRaffleRoutes"));
assert.ok(shopRoutes.includes("reserved for an active raffle"));
assert.ok(server.includes("raffle_winner_purchase"));
assert.ok(!fs.readFileSync(path.join(root, 'backend', 'storefront-raffles.js'), 'utf8').includes('Math.random'));
assert.ok(adminHtml.includes('data-store-pane="raffles"'));
assert.ok(adminHtml.includes('value="70.00"'));
assert.ok(adminHtml.includes('48-hour'));
assert.ok(adminHtml.includes('One admin group only'));
assert.ok(adminHtml.includes('Automatic at the exact end time'));
assert.ok(raffleHtml.includes('Manual entry required'));
assert.ok(raffleHtml.includes('not available to public shop visitors'));
assert.ok(raffleJs.includes('/enter'));
assert.ok(raffleJs.includes('Enter raffle'));
assert.ok(!raffleJs.includes('automatically included'));
assert.ok(!publicHomeHtml.includes('href="raffle.html"'));
assert.ok(!publicShopHtml.includes('href="raffle.html"'));
assert.ok(migration.includes('unique (raffle_id, user_id)'));
assert.ok(migration.includes('winner_entry_id'));
assert.ok(migration.includes("audience_type in ('all_members', 'admin_group')"));
assert.ok(migration.includes("fulfillment_mode in ('purchase', 'free')"));
assert.ok(migration.includes('guard_storefront_raffle_manual_entry'));
assert.ok(migration.includes('entries_locked_at'));
assert.ok(!fs.readFileSync(path.join(root, 'backend', 'storefront-raffles.js'), 'utf8').includes("app.get('/public/store/raffles'"));
assert.ok(fs.readFileSync(path.join(root, 'backend', 'storefront-raffles.js'), 'utf8').includes('setInterval'));

console.log('storefront raffle tests passed');
