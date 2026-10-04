const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const backend = fs.readFileSync(path.join(root, 'backend', 'order-tracker.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'order-tracker.js'), 'utf8');

const bootstrapStart = backend.indexOf("app.get('/orders/bootstrap'");
const bootstrapEnd = backend.indexOf("app.get('/orders/email-database-export'", bootstrapStart);
assert(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart, 'bootstrap route must exist');
const bootstrap = backend.slice(bootstrapStart, bootstrapEnd);
assert.match(bootstrap, /fetchAllSupabaseRows/, 'connected mailbox inventory must be paginated');
assert.doesNotMatch(bootstrap, /limit\(100\)/, 'connected mailbox inventory must not stop at 100 rows');

const scanStart = backend.indexOf('async function scanAll(');
const scanEnd = backend.indexOf('function scanJobView', scanStart);
assert(scanStart >= 0 && scanEnd > scanStart, 'complete mailbox scanner must exist');
const scan = backend.slice(scanStart, scanEnd);
assert.match(scan, /Promise\.all\(Array\.from\(\{ length:Math\.min\(concurrency, batchEntries\.length\) \}/, 'full scan must use a bounded worker pool inside each memory-safe batch');
assert.match(scan, /failed:completeResults\.filter/, 'a failed mailbox must be reported without aborting other workers');
assert.match(scan, /archived:completeResults\.reduce/, 'full scan must report all archived messages, not only linked retailer messages');
assert.match(backend, /Mailbox scan exceeded/, 'each mailbox must have a hard deadline');
assert.match(backend, /result\?\.email_id\) archived/, 'recognized and unrecognized stored messages must contribute to archive counts');

const reconcileStart = backend.indexOf("app.post('/orders/reconcile-retailer-emails'");
const reconcileEnd = backend.indexOf("app.get('/orders/reconcile-retailer-emails/status'", reconcileStart);
const reconcile = backend.slice(reconcileStart, reconcileEnd);
assert.match(reconcile, /force:true/, 'manual reconciliation must force a current scan instead of accepting stale last-scan timestamps');
assert.match(reconcile, /drainBacklog:false/, 'manual reconciliation must make one low-memory pass per mailbox');
assert.match(reconcile, /maxPassesPerMailbox:1/, 'one click must not repeatedly hydrate the same large mailbox');
assert.doesNotMatch(reconcile, /startUserScanJob\(/, 'reconciliation must not immediately overlap itself with another all-mailbox scan');
assert.match(reconcile, /all_email_scan:allEmailScan|result\.all_email_scan = allEmailScan/, 'full scan totals must be returned to diagnostics');
assert.doesNotMatch(reconcile, /discoverPokemonCenterConfirmationsGlobally\(/, 'Pokemon Center must replay from the fresh archive instead of rescanning every mailbox');
assert.match(frontend, /All messages archived \(recognized and unrecognized\)/, 'admin diagnostics must report complete archive coverage');
assert.match(frontend, /Mailboxes with more messages saved for the next reconcile pass/, 'admin diagnostics must explain resumable mailbox backlog');

console.log('Full collected-email scan tests passed');
