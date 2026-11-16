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
assert.match(tracker, /loadImportedScanAccounts[\s\S]*loadTargetExtraMailboxAssignmentMap/);
assert.match(tracker, /effectiveUserId = extraScanOwner\?\.user_id \|\| row\.matched_user_id/);
assert.match(tracker, /archive_user_id: row\.imported_by_user_id/);
assert.match(tracker, /auth_method === 'oauth2'[\s\S]*refreshImportedAccessToken/);
assert.match(tracker, /scanImportedAccount[\s\S]*saveParsedMessage\(supabase,account,parsed,msg\.uid/);
assert.match(tracker, /dynamicAccounts = await loadImportedScanAccounts\(supabase, null\)/);
assert.match(tracker, /TARGET_EXTRA_OAUTH_REPLAY_VERSION/);
assert.match(tracker, /matched_user_id:currentExtraOwner\.user_id/);
assert.match(tracker, /targetExtraReplayNeeded[\s\S]*__target_extra_oauth_replay/);
assert.match(tracker, /!targetExtraReplayNeeded && !sitewideReplayNeeded && !options\.force/);
assert.match(tracker, /Automatic history replay started/);
assert.match(tracker, /__retailer_history_replay/);
assert.match(tracker, /Full OAuth history replay started/);
assert.match(tracker, /a\.is_target_extra_account \|\| pendingEmails\.has\(a\.email\)/);
assert.match(tracker, /!a\.is_target_extra_account && !pendingEmails\.has\(a\.email\)/);

assert.match(tracker, /findTargetExtraServiceOrderGlobally/);
assert.match(tracker, /\.eq\('source_email', mailbox\)/);
assert.match(tracker, /store === 'target' && account\.is_target_extra_account/);
assert.match(tracker, /sharedMailboxOrder \? serviceOrder\.user_id : account\.user_id/);
assert.match(tracker, /mirrorTargetExtraEmailToOrderOwner/);
assert.match(tracker, /archiveTargetExtraMap\.get\(mailboxEmail\)/);

// Cancellation replays are safe: the original checkout owner is credited, and the ledger is
// checked before any second replay can issue another refund.
assert.match(tracker, /\.eq\('user_id',orderOwnerUserId\)[\s\S]*\.eq\('reason','imap_order_canceled_refund'\)/);
assert.match(tracker, /if \(!ledgerAlreadyRefunded\)[\s\S]*userId: orderOwnerUserId/);

console.log('Target extra-account order-tracker tests passed.');
