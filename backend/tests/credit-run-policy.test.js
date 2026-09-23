const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    CREDIT_AUTO_PAUSE_THRESHOLD,
    STORE_REACTIVATION_MINIMUM_BALANCE,
    shouldAutoPauseStores,
    crossedAutoPauseThreshold,
    canActivateStore,
    creditsNeededForReactivation
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
    /app\.put\("\/store-run-status"[\s\S]*?isEnabled && !canActivateStore\(balance\)[\s\S]*?status\(409\)/,
    'a negative balance must block manual store reactivation'
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
assert.match(adminHtml, /<th>Run Status<\/th>/);
assert.match(dashboardHtml, /id="creditsBalanceStat"[\s\S]*?href="buy-credits\.html">Buy credits →<\/a>/, 'the dashboard credit card must provide a direct purchase link');
assert.match(dashboardHtml, /script\.js\?v=20260923-credit-balance/, 'the dashboard must request the signed-balance frontend instead of a cached older script');

console.log('credit run policy tests passed');
