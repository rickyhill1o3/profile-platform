const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    CREDIT_AUTO_PAUSE_THRESHOLD,
    STORE_REACTIVATION_MINIMUM_BALANCE,
    shouldAutoPauseStores,
    crossedAutoPauseThreshold,
    canActivateStore,
    creditsNeededForReactivation,
    shouldRestoreAfterCreditPurchase
} = require('../credit-run-policy');

assert.strictEqual(CREDIT_AUTO_PAUSE_THRESHOLD, -15);
assert.strictEqual(STORE_REACTIVATION_MINIMUM_BALANCE, 0);

assert.strictEqual(shouldAutoPauseStores(-15), false, 'a balance of exactly -15 must remain within the active allowance');
assert.strictEqual(shouldAutoPauseStores(-16), true, 'a balance below -15 must trigger the automatic pause');
assert.strictEqual(crossedAutoPauseThreshold(-10, -16), true, 'crossing below -15 must be detected');
assert.strictEqual(crossedAutoPauseThreshold(-16, -20), false, 'an already-paused balance must not look like a new crossing');

assert.strictEqual(canActivateStore(-1), false, 'negative balances cannot reactivate a paused store');
assert.strictEqual(canActivateStore(0), true, 'a zero balance can reactivate a store');
assert.strictEqual(creditsNeededForReactivation(-31), 31);
assert.strictEqual(creditsNeededForReactivation(4), 0);
assert.strictEqual(shouldRestoreAfterCreditPurchase(-31, 0, 'stripe_purchase'), true, 'a purchase reaching zero must qualify for selective automatic restoration');
assert.strictEqual(shouldRestoreAfterCreditPurchase(-31, -1, 'stripe_purchase'), false, 'a purchase that stays negative must not restore stores');
assert.strictEqual(shouldRestoreAfterCreditPurchase(-31, 0, 'order_refunded'), false, 'non-purchase credits must not trigger automatic restoration');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'dashboard.html'), 'utf8');

assert.match(
    serverSource,
    /async function adjustUserCredits[\s\S]*?shouldAutoPauseStores\(nextBalance\)[\s\S]*?pauseActiveStoresForCreditLimit\(userId, nextBalance\)/,
    'every central credit adjustment must enforce the automatic pause'
);
assert.match(
    serverSource,
    /async function adjustUserCredits[\s\S]*?shouldRestoreAfterCreditPurchase\(previousBalance, nextBalance, normalizedReason\)[\s\S]*?markCreditPurchaseRestorePending[\s\S]*?restoreCreditPausedStores/,
    'a qualifying credit purchase must restore only provenance-tracked automatic pauses'
);
assert.match(
    serverSource,
    /app\.put\("\/store-run-status"[\s\S]*?isEnabled && !canActivateStore\(balance\)[\s\S]*?status\(409\)/,
    'a negative balance must block manual store reactivation'
);
assert.match(
    serverSource,
    /app\.put\("\/store-run-status"[\s\S]*?forgetAutomaticallyPausedStore\(supabase, req\.user_id, site\)/,
    'an explicit user store toggle must cancel automatic restoration for that store'
);
assert.match(
    serverSource,
    /app\.get\("\/credits\/me"[\s\S]*?balance:?[\s\S]*?stores_auto_paused: shouldAutoPauseStores\(balance\)/,
    'the credit endpoint must expose the signed balance and pause state'
);
assert.match(
    serverSource,
    /app\.get\("\/credits\/me"[\s\S]*?const balance = asSignedCredits\(balanceRow\.balance, 0\)/,
    'the dashboard credit endpoint must preserve negative balances instead of clamping them to zero'
);
assert.match(frontendSource, /Negative balance allowed through -15 credits/);
assert.match(frontendSource, /Stores automatically paused/);
assert.match(frontendSource, /Reach 0 credits before reactivating this store/);
assert.match(frontendSource, /Stores you paused yourself stay paused/);
assert.match(adminHtml, /<th>Run Status<\/th>/);
assert.match(dashboardHtml, /id="creditsBalanceStat"[\s\S]*?href="buy-credits\.html">Buy credits →<\/a>/, 'the dashboard credit card must provide a direct purchase link');
assert.match(dashboardHtml, /script\.js\?v=20260923-auto-credit-restore/, 'the dashboard must request the selective automatic-restoration frontend instead of a cached older script');

console.log('credit run policy tests passed');
