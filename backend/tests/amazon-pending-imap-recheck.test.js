const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const tracker = fs.readFileSync(path.join(root, 'backend', 'order-tracker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');
const trackerUi = fs.readFileSync(path.join(root, 'frontend', 'order-tracker.js'), 'utf8');

assert.match(tracker, /post\('\/orders\/amazon-pending-recheck\/start'/, 'missing manual Amazon IMAP start route');
assert.match(tracker, /get\('\/orders\/amazon-pending-recheck\/status'/, 'missing Amazon IMAP job status route');
assert.match(tracker, /onlyMailboxEmails:\[group\.email\]/, 'recheck must scan only the checkout mailbox');
assert.match(tracker, /replaySinceAt,\s*force:true,\s*concurrency:1/, 'recheck must replay the checkout time window serially');
assert.match(tracker, /markAmazonGhostCandidates:false/, 'manual recheck must not turn an unmatched checkout into a ghost');
assert.match(tracker, /setInterval\(runAmazonPendingSweep, AMAZON_PENDING_RECHECK_INTERVAL_MS\)/, 'recent pending Amazon orders must retry automatically');
assert.match(tracker, /amazon_imap_recheck_last_at/, 'automatic retries need a durable per-order cooldown');
assert.match(tracker, /amazonManualRecheckPriority/, 'manual Amazon rechecks need process-wide priority over background email work');
assert.match(tracker, /manual_amazon_recheck_priority/, 'background email work must yield at a safe mailbox boundary');
assert.match(tracker, /\[AMAZON IMAP RECHECK\] Manual request/, 'manual Amazon rechecks need an immediate Render log entry');
assert.match(server, /order_id: order\?\.id \|\| null/, 'webhook rows must expose their source order for targeted IMAP rechecks');
assert.match(admin, />Check Amazon IMAP<\/button>/, 'pending Amazon webhook rows need a manual IMAP button');
assert.match(admin, /Waiting for email worker/, 'the manual button must explain when it is waiting behind background IMAP work');
assert.match(admin, /<th>Time \(Eastern\)<\/th>/, 'webhook table must label its timezone');
assert.match(trackerUi, /Recheck all pending Amazon IMAP/, 'Order Tracker needs the all-pending safety-net button');

const functionSource = admin.match(/function parseWebhookUtcTimestamp[\s\S]*?(?=\nasync function recheckAmazonWebhookImap)/)?.[0];
assert.ok(functionSource, 'could not isolate Eastern-time formatter');
const context = { Intl, Date, Number, String };
vm.createContext(context);
vm.runInContext(`${functionSource}; this.__formatted = formatWebhookEasternTime('2026-11-14T18:36:56');`, context);
assert.match(context.__formatted, /1:36:56 PM EST/, `expected 18:36 UTC to display as 1:36 PM EST, got ${context.__formatted}`);

console.log('Amazon pending IMAP recheck and Eastern webhook-time tests passed.');
