const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js'), 'utf8');

assert(backendSource.includes("app.get('/orders/reconcile-retailer-emails/status'"), 'bulk reconcile must expose a pollable status endpoint');
assert(backendSource.includes('retailerReconcileJobView(existingReconcile)'), 'a second click must reconnect to the running job');
assert(backendSource.includes("syncRetailerPaymentAlertsFromArchive(supabase, req.user_id)"), 'bulk reconcile must rebuild Target and Pokemon Center payment alerts');
assert(backendSource.includes("stage:'payment_alerts'") || backendSource.includes("'payment_alerts', 20"), 'payment alert recovery must report progress');
assert(backendSource.includes('walmartOrdersNeedingRepair'), 'bulk reconcile must include Walmart order repair');
assert(backendSource.includes('targetOrdersMissingConfirmation'), 'bulk reconcile must include Target order repair');
assert(backendSource.includes('amazonOrdersMissingConfirmation'), 'bulk reconcile must include Amazon time-window repair');
assert(backendSource.includes('otherRetailerOrders'), 'bulk reconcile must reserve repair capacity for other supported retailers such as Macy\'s');
assert(backendSource.includes('discoverPokemonCenterConfirmationsGlobally'), 'bulk reconcile must include Pokemon Center live mailbox recovery');
assert(backendSource.includes('fetchSupremeArchiveCandidatesForOrders'), 'bulk reconcile must preserve Supreme recovery');
assert(backendSource.includes('RECONCILE_IMAP_CONCURRENCY'), 'global mailbox scans must use bounded concurrency');
assert(backendSource.includes('stage_errors:reconcileJob.stage_errors.slice()'), 'recoverable retailer failures must be returned instead of aborting all stages');

assert(frontendSource.includes('const isRetailerReconcile='), 'frontend must recognize long-running reconcile requests');
assert(frontendSource.includes('maxAttempts=isRetailerReconcile?12'), 'frontend must reconnect through a temporary backend outage');
assert(frontendSource.includes("restartCount<3"), 'frontend must recover from more than one server restart');
assert(frontendSource.includes('job.percent'), 'frontend must display backend reconcile progress');
assert(frontendSource.includes('Recoverable stage errors:'), 'completed reconciliation diagnostics must expose partial retailer failures');

console.log('Retailer reconcile resilience tests passed');
