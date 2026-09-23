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
    shouldRestoreAfterCreditPurchase,
    isCreditLimitExemptRole,
    shouldAutoPauseStoresForRole,
    canRoleActivateStore,
    creditsNeededForRoleReactivation
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

assert.strictEqual(isCreditLimitExemptRole('super_admin'), true, 'the site owner role must be credit-limit exempt');
assert.strictEqual(isCreditLimitExemptRole('admin'), false, 'regular admins keep the normal credit policy');
assert.strictEqual(shouldAutoPauseStoresForRole(-1025, 'super_admin'), false, 'a negative owner balance must never auto-pause stores');
assert.strictEqual(shouldAutoPauseStoresForRole(-16, 'user'), true, 'regular users still auto-pause below -15');
assert.strictEqual(canRoleActivateStore(-1025, 'super_admin'), true, 'the site owner can enable stores at any balance');
assert.strictEqual(canRoleActivateStore(-1, 'user'), false, 'regular users still need a non-negative balance to enable stores');
assert.strictEqual(creditsNeededForRoleReactivation(-1025, 'super_admin'), 0, 'the owner is never asked to buy credits to reactivate');

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
    /app\.put\("\/store-run-status"[\s\S]*?isEnabled && !canRoleActivateStore\(balance, req\.role\)[\s\S]*?status\(409\)/,
    'a negative balance must block regular-user reactivation without blocking the super admin'
);
assert.match(
    serverSource,
    /app\.put\("\/store-run-status"[\s\S]*?forgetAutomaticallyPausedStore\(supabase, req\.user_id, site\)/,
    'an explicit user store toggle must cancel automatic restoration for that store'
);
assert.match(
    serverSource,
    /app\.get\("\/credits\/me"[\s\S]*?balance,?[\s\S]*?stores_auto_paused: shouldAutoPauseStoresForRole\(balance, req\.role\)/,
    'the credit endpoint must expose the signed balance and role-aware pause state'
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
assert.match(frontendSource, /Super admin account — never auto-paused for credits/);
assert.match(adminHtml, /<th>Run Status<\/th>/);
assert.match(dashboardHtml, /id="creditsBalanceStat"[\s\S]*?href="buy-credits\.html">Buy credits →<\/a>/, 'the dashboard credit card must provide a direct purchase link');
assert.match(dashboardHtml, /script\.js\?v=20260923-super-admin-credit-exempt/, 'the dashboard must request the super-admin credit-exemption frontend instead of a cached older script');

assert.match(
    serverSource,
    /async function pauseActiveStoresForCreditLimit[\s\S]*?isCreditLimitExemptRole\(role\)[\s\S]*?bypassBalance: true[\s\S]*?credit_limit_exempt: true/,
    'an owner that was previously auto-paused must be restored without requiring a non-negative balance'
);
assert.match(
    serverSource,
    /const willCrossAutoPauseThreshold = creditsToCharge > 0[\s\S]*?!isCreditLimitExemptRole\(user\.role\)[\s\S]*?crossedAutoPauseThreshold/,
    'successful checkout processing must not flag or notify the super admin for the -15 threshold'
);

console.log('credit run policy tests passed');
