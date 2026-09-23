'use strict';

const { fetchAllSupabaseRows } = require('./supabase-pagination');

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
    return new Set((data || []).map((row) => String(row.user_id || '').trim()).filter(Boolean));
}

function filterRowsToActiveUsers(rows = [], activeUserIds = new Set()) {
    return (Array.isArray(rows) ? rows : []).filter((row) => activeUserIds.has(String(row?.user_id || '')));
}

module.exports = {
    productSelectionRunStatusSite,
    loadActiveProductSelectionUserIds,
    filterRowsToActiveUsers
};
