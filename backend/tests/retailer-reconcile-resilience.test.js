const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js'), 'utf8');

assert(backendSource.includes("app.get('/orders/reconcile-retailer-emails/status'"), 'bulk reconcile must expose a pollable status endpoint');
assert(backendSource.includes('retailerReconcileJobView(existingReconcile)'), 'a second click must reconnect to the running job');
assert(backendSource.includes("order_tracker_reconcile_job:${String(userId || '')}"), 'reconcile progress must use a durable per-user app_settings checkpoint');
assert(backendSource.includes('loadDurableRetailerReconcileJob'), 'a restarted server must load the saved reconciliation job');
assert(backendSource.includes('persistRetailerReconcileJob'), 'mailbox progress must be persisted while reconciliation is running');
assert(backendSource.includes('resumeCompletedKeys:Object.keys(checkpointResults)'), 'a resumed scan must skip mailboxes already completed by this run');
assert(backendSource.includes("req.role === 'super_admin' ? null : req.user_id"), 'super-admin Pokemon Center reconciliation must use the complete cross-user mailbox/archive scope');
assert(backendSource.includes("syncRetailerPaymentAlertsFromArchive(supabase, req.user_id, false)"), 'bulk reconcile must rebuild only the signed-in user\'s Target and Pokemon Center payment alerts');
assert(backendSource.includes("'Please update your payment soon'"), 'live reconciliation must search Target payment-warning subjects');
assert(backendSource.includes("stage:'payment_alerts'") || backendSource.includes("'payment_alerts', 55"), 'payment alert recovery must report progress');
assert(backendSource.includes('walmartOrdersNeedingRepair'), 'bulk reconcile must include Walmart order repair');
assert(backendSource.includes('targetOrdersMissingConfirmation'), 'bulk reconcile must include Target order repair');
assert(backendSource.includes('amazonOrdersMissingConfirmation'), 'bulk reconcile must include Amazon time-window repair');
assert(backendSource.includes('otherRetailerOrders'), 'bulk reconcile must reserve repair capacity for other supported retailers such as Macy\'s');
const reconcileStart = backendSource.indexOf("app.post('/orders/reconcile-retailer-emails'");
const reconcileEnd = backendSource.indexOf("app.get('/orders/reconcile-retailer-emails/status'", reconcileStart);
const reconcileRoute = backendSource.slice(reconcileStart, reconcileEnd);
assert.match(reconcileRoute, /fetchPokemonCenterArchiveCandidates\(\s*supabase, req\.role === 'super_admin' \? null : req\.user_id/, 'Pokemon Center archive replay must search every website user for super admin');
assert(reconcileRoute.includes('all_email_scan'), 'bulk reconcile must begin with the complete mailbox scan');
assert(reconcileRoute.includes('scanAll('), 'bulk reconcile must collect every connected mailbox before retailer replay');
assert(!reconcileRoute.includes('discoverPokemonCenterConfirmationsGlobally('), 'interactive reconcile must not repeat a blocking global Pokemon Center mailbox sweep');
assert(backendSource.includes('fetchSupremeArchiveCandidatesForOrders'), 'bulk reconcile must preserve Supreme recovery');
assert(backendSource.includes('FULL_EMAIL_SCAN_CONCURRENCY'), 'the complete mailbox scan must use bounded concurrency');
assert(backendSource.includes('stage_errors:reconcileJob.stage_errors.slice()'), 'recoverable retailer failures must be returned instead of aborting all stages');

assert(frontendSource.includes('const isRetailerReconcile='), 'frontend must recognize long-running reconcile requests');
assert(frontendSource.includes('maxAttempts=isRetailerReconcile?12'), 'frontend must reconnect through a temporary backend outage');
assert(frontendSource.includes('reconnectCount<8'), 'frontend must reconnect to a durable job through temporary service restarts without an endless loop');
assert(frontendSource.includes('mailbox checkpoint(s) are saved'), 'repeated restarts must give a clear durable-resume instruction');
assert(frontendSource.includes('job.percent'), 'frontend must display backend reconcile progress');
assert(frontendSource.includes('Recoverable stage errors:'), 'completed reconciliation diagnostics must expose partial retailer failures');
assert(frontendSource.includes('Connected mailboxes selected for full scan:'), 'completed diagnostics must show the full mailbox inventory');

console.log('Retailer reconcile resilience tests passed');
