const CREDIT_AUTO_PAUSE_THRESHOLD = -15;
const STORE_REACTIVATION_MINIMUM_BALANCE = 0;

function normalizeBalance(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function shouldAutoPauseStores(balance) {
    return normalizeBalance(balance) < CREDIT_AUTO_PAUSE_THRESHOLD;
}

function crossedAutoPauseThreshold(previousBalance, newBalance) {
    return !shouldAutoPauseStores(previousBalance) && shouldAutoPauseStores(newBalance);
}

function canActivateStore(balance) {
    return normalizeBalance(balance) >= STORE_REACTIVATION_MINIMUM_BALANCE;
}

function creditsNeededForReactivation(balance) {
    return Math.max(0, STORE_REACTIVATION_MINIMUM_BALANCE - normalizeBalance(balance));
}

function shouldRestoreAfterCreditPurchase(previousBalance, newBalance, reason = '') {
    return normalizeBalance(previousBalance) < STORE_REACTIVATION_MINIMUM_BALANCE
        && canActivateStore(newBalance)
        && String(reason || '').trim().toLowerCase() === 'stripe_purchase';
}

module.exports = {
    CREDIT_AUTO_PAUSE_THRESHOLD,
    STORE_REACTIVATION_MINIMUM_BALANCE,
    shouldAutoPauseStores,
    crossedAutoPauseThreshold,
    canActivateStore,
    creditsNeededForReactivation,
    shouldRestoreAfterCreditPurchase
};
