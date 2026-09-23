'use strict';

const {
    shouldAutoPauseStores,
    canActivateStore
} = require('./credit-run-policy');

const AUTO_PAUSE_SETTING_PREFIX = 'credit_auto_pause_state:';

function cleanUserId(value) {
    return String(value || '').trim();
}

function normalizeSites(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((site) => String(site || '').trim().toLowerCase())
        .filter(Boolean))];
}

function creditAutoPauseSettingKey(userId) {
    return `${AUTO_PAUSE_SETTING_PREFIX}${cleanUserId(userId)}`;
}

function normalizeAutoPauseState(value = {}) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        version: 1,
        sites: normalizeSites(state.sites),
        paused_at: state.paused_at || null,
        last_paused_at: state.last_paused_at || null,
        balance_at_pause: state.balance_at_pause !== null
            && state.balance_at_pause !== undefined
            && state.balance_at_pause !== ''
            && Number.isFinite(Number(state.balance_at_pause))
            ? Math.round(Number(state.balance_at_pause))
            : null,
        restore_pending: state.restore_pending === true,
        restore_eligible_at: state.restore_eligible_at || null,
        restored_at: state.restored_at || null,
        legacy_recovery_transaction: String(state.legacy_recovery_transaction || ''),
        legacy_recovered_at: state.legacy_recovered_at || null
    };
}

async function loadCreditAutoPauseState(supabase, userId) {
    const cleanId = cleanUserId(userId);
    if (!cleanId) return normalizeAutoPauseState();
    const { data, error } = await supabase
        .from('app_settings')
        .select('value_json')
        .eq('key', creditAutoPauseSettingKey(cleanId))
        .maybeSingle();
    if (error) throw new Error(error.message || 'Could not load automatic store-pause state.');
    return normalizeAutoPauseState(data?.value_json);
}

async function saveCreditAutoPauseState(supabase, userId, state) {
    const cleanId = cleanUserId(userId);
    if (!cleanId) throw new Error('A user is required to save automatic store-pause state.');
    const value = normalizeAutoPauseState(state);
    const { error } = await supabase.from('app_settings').upsert({
        key: creditAutoPauseSettingKey(cleanId),
        value_json: value,
        updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) throw new Error(error.message || 'Could not save automatic store-pause state.');
    return value;
}

async function pauseStoresForCreditLimit(supabase, userId, balance, options = {}) {
    if (!shouldAutoPauseStores(balance)) return { paused: false, paused_sites: [] };

    const cleanId = cleanUserId(userId);
    const now = options.now || new Date().toISOString();
    const { data: activeRows, error: loadError } = await supabase
        .from('user_store_run_status')
        .select('site')
        .eq('user_id', cleanId)
        .eq('is_enabled', true);
    if (loadError) throw new Error(loadError.message || 'Could not load active stores.');

    const pausedSites = normalizeSites((activeRows || []).map((row) => row.site));
    if (!pausedSites.length) return { paused: false, paused_sites: [] };

    const existing = await loadCreditAutoPauseState(supabase, cleanId);
    await saveCreditAutoPauseState(supabase, cleanId, {
        ...existing,
        sites: normalizeSites([...existing.sites, ...pausedSites]),
        paused_at: existing.paused_at || now,
        last_paused_at: now,
        balance_at_pause: balance,
        restore_pending: false,
        restore_eligible_at: null,
        restored_at: null
    });

    const { error: pauseError } = await supabase
        .from('user_store_run_status')
        .update({ is_enabled: false, updated_at: now })
        .eq('user_id', cleanId)
        .eq('is_enabled', true);
    if (pauseError) throw new Error(pauseError.message || 'Could not pause active stores.');

    return { paused: true, paused_sites: pausedSites };
}

async function markCreditPurchaseRestorePending(supabase, userId, balance, options = {}) {
    if (!canActivateStore(balance)) return { pending: false, sites: [] };
    const state = await loadCreditAutoPauseState(supabase, userId);
    if (!state.sites.length) return { pending: false, sites: [] };
    const now = options.now || new Date().toISOString();
    await saveCreditAutoPauseState(supabase, userId, {
        ...state,
        restore_pending: true,
        restore_eligible_at: now
    });
    return { pending: true, sites: state.sites };
}

async function restoreAutomaticallyPausedStores(supabase, userId, balance, options = {}) {
    if (!options.bypassBalance && !canActivateStore(balance)) return { restored: false, restored_sites: [] };
    const state = await loadCreditAutoPauseState(supabase, userId);
    if (!state.sites.length || (!state.restore_pending && options.requirePending !== false)) {
        return { restored: false, restored_sites: [] };
    }

    const now = options.now || new Date().toISOString();
    const rows = state.sites.map((site) => ({
        user_id: cleanUserId(userId),
        site,
        is_enabled: true,
        updated_at: now
    }));
    const { error } = await supabase
        .from('user_store_run_status')
        .upsert(rows, { onConflict: 'user_id,site' });
    if (error) throw new Error(error.message || 'Could not restore automatically paused stores.');

    await saveCreditAutoPauseState(supabase, userId, {
        ...state,
        sites: [],
        restore_pending: false,
        restored_at: now
    });

    return { restored: true, restored_sites: state.sites };
}

async function forgetAutomaticallyPausedStore(supabase, userId, site) {
    const cleanSite = String(site || '').trim().toLowerCase();
    if (!cleanUserId(userId) || !cleanSite) return { changed: false, sites: [] };
    const state = await loadCreditAutoPauseState(supabase, userId);
    const sites = state.sites.filter((item) => item !== cleanSite);
    if (sites.length === state.sites.length) return { changed: false, sites };
    await saveCreditAutoPauseState(supabase, userId, {
        ...state,
        sites,
        restore_pending: sites.length ? state.restore_pending : false
    });
    return { changed: true, sites };
}

function findLegacyRecoveryWindow(transactions = []) {
    const rows = (Array.isArray(transactions) ? transactions : [])
        .filter((row) => row?.created_at)
        .map((row) => ({
            ...row,
            amount_delta: Math.trunc(Number(row.amount_delta || 0)),
            balance_after: Number(row.balance_after),
            created_ms: new Date(row.created_at).getTime()
        }))
        .filter((row) => Number.isFinite(row.balance_after) && Number.isFinite(row.created_ms))
        .sort((a, b) => a.created_ms - b.created_ms);

    let episodeStart = null;
    let latestWindow = null;
    let previousBalance = null;
    for (const row of rows) {
        const inferredPrevious = Number.isFinite(previousBalance)
            ? previousBalance
            : row.balance_after - row.amount_delta;
        if (shouldAutoPauseStores(row.balance_after) && !shouldAutoPauseStores(inferredPrevious)) {
            episodeStart = row.created_at;
        }
        const isPurchaseRecovery = String(row.reason || '').toLowerCase() === 'stripe_purchase'
            && row.amount_delta > 0
            && inferredPrevious < 0
            && canActivateStore(row.balance_after);
        if (isPurchaseRecovery && episodeStart) {
            latestWindow = {
                started_at: episodeStart,
                recovered_at: row.created_at,
                transaction: String(row.id || row.created_at)
            };
            episodeStart = null;
        }
        previousBalance = row.balance_after;
    }
    return latestWindow;
}

async function recoverLegacyAutomaticallyPausedStores(supabase, userId, balance, transactions = [], options = {}) {
    if (!canActivateStore(balance)) return { restored: false, restored_sites: [], legacy: true };
    const state = await loadCreditAutoPauseState(supabase, userId);
    if (state.sites.length || state.restore_pending) return { restored: false, restored_sites: [], legacy: true };

    const window = findLegacyRecoveryWindow(transactions);
    if (!window || state.legacy_recovery_transaction === window.transaction) {
        return { restored: false, restored_sites: [], legacy: true };
    }

    const { data: statusRows, error } = await supabase
        .from('user_store_run_status')
        .select('site,is_enabled,updated_at')
        .eq('user_id', cleanUserId(userId));
    if (error) throw new Error(error.message || 'Could not inspect legacy automatic pauses.');

    const startedMs = new Date(window.started_at).getTime();
    const recoveredMs = new Date(window.recovered_at).getTime();
    const sites = normalizeSites((statusRows || [])
        .filter((row) => {
            const updatedMs = new Date(row.updated_at || '').getTime();
            return row.is_enabled === false
                && Number.isFinite(updatedMs)
                && updatedMs >= startedMs
                && updatedMs <= recoveredMs;
        })
        .map((row) => row.site));

    const now = options.now || new Date().toISOString();
    if (sites.length) {
        const { error: restoreError } = await supabase
            .from('user_store_run_status')
            .upsert(sites.map((site) => ({
                user_id: cleanUserId(userId),
                site,
                is_enabled: true,
                updated_at: now
            })), { onConflict: 'user_id,site' });
        if (restoreError) throw new Error(restoreError.message || 'Could not restore legacy automatic pauses.');
    }

    await saveCreditAutoPauseState(supabase, userId, {
        ...state,
        sites: [],
        restore_pending: false,
        restored_at: sites.length ? now : state.restored_at,
        legacy_recovery_transaction: window.transaction,
        legacy_recovered_at: now
    });

    return { restored: sites.length > 0, restored_sites: sites, legacy: true };
}

module.exports = {
    AUTO_PAUSE_SETTING_PREFIX,
    creditAutoPauseSettingKey,
    normalizeAutoPauseState,
    loadCreditAutoPauseState,
    pauseStoresForCreditLimit,
    markCreditPurchaseRestorePending,
    restoreAutomaticallyPausedStores,
    forgetAutomaticallyPausedStore,
    findLegacyRecoveryWindow,
    recoverLegacyAutomaticallyPausedStores
};
