'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveAssignmentAtTime } = require('../target-extra-accounts');

const tracker = fs.readFileSync(path.resolve(__dirname, '..', 'order-tracker.js'), 'utf8');

const assignmentHistory = [
  { id:'old-assignment', user_id:'old-user', assigned_at:'2026-11-01T00:00:00Z', released_at:'2026-11-08T00:00:00Z' },
  { id:'new-assignment', user_id:'new-user', assigned_at:'2026-11-08T00:00:00Z', released_at:null }
];
assert.strictEqual(resolveAssignmentAtTime(assignmentHistory, '2026-11-05T12:00:00Z').user_id, 'old-user');
assert.strictEqual(resolveAssignmentAtTime(assignmentHistory, '2026-11-10T12:00:00Z').user_id, 'new-user');

assert.match(tracker, /loadTargetExtraMailboxAssignmentMap/);
assert.match(tracker, /target_extra_accounts[\s\S]*target_extra_account_assignments/);
assert.match(tracker, /resolveTargetExtraMailboxOwner\(entry, eventAt/);
assert.match(tracker, /loadAycdRecipientMap[\s\S]*loadTargetExtraMailboxAssignmentMap/);
assert.match(tracker, /source = 'history'[\s\S]*target_extra_account/);
assert.match(tracker, /archive_user_id:\s*userId[\s\S]*is_target_extra_account/);

assert.match(tracker, /findTargetExtraServiceOrderGlobally/);
assert.match(tracker, /\.eq\('source_email', mailbox\)/);
assert.match(tracker, /store === 'target' && account\.is_target_extra_account/);
assert.match(tracker, /sharedMailboxOrder \? serviceOrder\.user_id : account\.user_id/);
assert.match(tracker, /mirrorTargetExtraEmailToOrderOwner/);

// Cancellation replays are safe: the original checkout owner is credited, and the ledger is
// checked before any second replay can issue another refund.
assert.match(tracker, /\.eq\('user_id',orderOwnerUserId\)[\s\S]*\.eq\('reason','imap_order_canceled_refund'\)/);
assert.match(tracker, /if \(!ledgerAlreadyRefunded\)[\s\S]*userId: orderOwnerUserId/);

const bridgeResultStart = tracker.indexOf("app.post('/orders/aycd/bridge/result'");
const bridgeResultEnd = tracker.indexOf("app.post('/orders/aycd/scan-now'", bridgeResultStart);
const bridgeResult = tracker.slice(bridgeResultStart, bridgeResultEnd > bridgeResultStart ? bridgeResultEnd : undefined);
assert.strictEqual((bridgeResult.match(/ingestAycdMessages\(row\.user_id, req\.body\.messages\)/g) || []).length, 1,
  'each AYCD upload chunk must be ingested only once');

console.log('Target extra-account order-tracker tests passed.');
