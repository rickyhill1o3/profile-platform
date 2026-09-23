'use strict';

const { fetchAllSupabaseRows } = require('./supabase-pagination');
const { shouldAutoPauseStores } = require('./credit-run-policy');
const { pauseStoresForCreditLimit } = require('./credit-store-lifecycle');

function productSelectionRunStatusSite(site = '') {
    const normalized = String(site || '').trim().toLowerCase();
    return normalized === 'pokemon' ? 'pokemoncenter' : normalized;
}

async function loadActiveProductSelectionUserIds(supabase, site, scopedUserIds = null) {
    const runStatusSite = productSelectionRunStatusSite(site);
    const scope = scopedUserIds === null
        ? null
        : [...new Set((scopedUserIds || []).map((id) => String(id || '').trim()).filter(Boolean))];

    if (scope && !scope.length) return new Set();

    const buildQuery = () => {
        let query = supabase
            .from('user_store_run_status')
            .select('user_id')
            .eq('site', runStatusSite)
            .eq('is_enabled', true)
            .order('user_id', { ascending: true });
        if (scope) query = query.in('user_id', scope);
        return query;
    };

    const { data, error } = await fetchAllSupabaseRows(buildQuery);
    if (error) throw new Error(error.message || 'Could not load active store accounts.');

    const activeUserIds = [...new Set((data || []).map((row) => String(row.user_id || '').trim()).filter(Boolean))];

    // The site owner does not purchase credits from their own service. Super
    // admin selections must remain exportable even when an earlier credit
    // auto-pause turned off the corresponding Store Run Status row.
    const buildSuperAdminQuery = () => {
        let query = supabase
            .from('users')
            .select('id')
            .eq('role', 'super_admin')
            .order('id', { ascending: true });
        if (scope) query = query.in('id', scope);
        return query;
    };
    const { data: superAdminRows, error: superAdminError } = await fetchAllSupabaseRows(buildSuperAdminQuery);
    if (superAdminError) throw new Error(superAdminError.message || 'Could not load super admin export accounts.');

    const superAdminUserIds = new Set((superAdminRows || [])
        .map((row) => String(row.id || '').trim())
        .filter(Boolean));
    const creditCheckedUserIds = activeUserIds.filter((userId) => !superAdminUserIds.has(userId));
    if (!creditCheckedUserIds.length) return superAdminUserIds;

    // Store status is the primary filter, but the credit balance is an
    // additional fail-safe. If an older/stale status row still says Active
    // after the user dropped below -15, never expose that user to a bot export.
    const { data: creditRows, error: creditError } = await fetchAllSupabaseRows(() => supabase
        .from('user_credit_balances')
        .select('user_id, balance')
        .in('user_id', creditCheckedUserIds)
        .order('user_id', { ascending: true }));
    if (creditError) throw new Error(creditError.message || 'Could not verify credit eligibility for product exports.');

    const creditPausedUserIds = new Set((creditRows || [])
        .filter((row) => shouldAutoPauseStores(row.balance))
        .map((row) => String(row.user_id || '').trim())
        .filter(Boolean));

    if (creditPausedUserIds.size) {
        for (const blockedId of creditPausedUserIds) {
            await pauseStoresForCreditLimit(supabase, blockedId, (creditRows || [])
                .find((row) => String(row.user_id || '') === blockedId)?.balance);
        }
    }

    return new Set([
        ...superAdminUserIds,
        ...creditCheckedUserIds.filter((userId) => !creditPausedUserIds.has(userId))
    ]);
}

function filterRowsToActiveUsers(rows = [], activeUserIds = new Set()) {
    return (Array.isArray(rows) ? rows : []).filter((row) => activeUserIds.has(String(row?.user_id || '')));
}

module.exports = {
    productSelectionRunStatusSite,
    loadActiveProductSelectionUserIds,
    filterRowsToActiveUsers
};
