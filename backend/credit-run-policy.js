const CREDIT_AUTO_PAUSE_THRESHOLD = -15;
const STORE_REACTIVATION_MINIMUM_BALANCE = 0;

function normalizeBalance(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function isCreditLimitExemptRole(role = '') {
    return String(role || '').trim().toLowerCase() === 'super_admin';
}

function shouldAutoPauseStoresForRole(balance, role = '') {
    return !isCreditLimitExemptRole(role) && shouldAutoPauseStores(balance);
}

function canRoleActivateStore(balance, role = '') {
    return isCreditLimitExemptRole(role) || canActivateStore(balance);
}

function creditsNeededForRoleReactivation(balance, role = '') {
    return isCreditLimitExemptRole(role) ? 0 : creditsNeededForReactivation(balance);
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
    shouldRestoreAfterCreditPurchase,
    isCreditLimitExemptRole,
    shouldAutoPauseStoresForRole,
    canRoleActivateStore,
    creditsNeededForRoleReactivation
};
