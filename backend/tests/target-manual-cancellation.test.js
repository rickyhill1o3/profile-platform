'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    parseRetailEmail,
    targetCancellationItemMatches
} = require('../retailer-reconciliation');

const subject = "You've successfully canceled items from your order ending in 0707.";
const text = [
    'Your items have been canceled',
    'Hi Reid,',
    'As you requested, we have canceled the items below from your order #912003956000707.',
    'Canceled items',
    'Pokémon Trading Card Game: Mega Forces Tin - Dragonite ex',
    'Qty: 2',
    'Help',
    'Returns'
].join('\n');

const parsed = parseRetailEmail('target', 'canceled', subject, text);
assert.strictEqual(parsed.order_number, '912003956000707', 'the full Target order number in the body must override the last-four subject wording');
assert.strictEqual(parsed.cancellation_scope, 'item', 'the manual cancellation template is an item cancellation, not an unsafe blanket order cancellation');
assert.strictEqual(parsed.items.length, 1, 'the canceled product row must be parsed');
assert.strictEqual(parsed.items[0].quantity, 2, 'the canceled quantity must be preserved');
assert.match(parsed.items[0].product_name, /Mega Forces Tin - Dragonite ex/i);

assert.strictEqual(targetCancellationItemMatches({
    product_name: 'Pokémon Trading Card Game: Mega Forces Tin - Dragonite ex',
    sku: '101042374'
}, parsed.items, parsed.cancellation_text), true, 'the linked manual cancellation must match the webhook main item');
assert.strictEqual(targetCancellationItemMatches({
    product_name: 'Shipping threshold filler item',
    sku: 'FILLER-1'
}, parsed.items, parsed.cancellation_text), false, 'an unrelated filler must not be canceled or refunded');

const projectRoot = path.resolve(__dirname, '..', '..');
const trackerSource = fs.readFileSync(path.join(projectRoot, 'backend', 'order-tracker.js'), 'utf8');
assert.match(
    trackerSource,
    /manual-cancellation template[\s\S]*?matchingMainRows[\s\S]*?status:'canceled'/,
    'every duplicate main alias matched by a manual Target cancellation must be moved out of confirmed status'
);
assert.match(
    trackerSource,
    /repairLinkedTargetCancellationStatuses/,
    'older linked cancellations must be replayed automatically by the background tracker'
);

console.log('target manual cancellation tests passed');
