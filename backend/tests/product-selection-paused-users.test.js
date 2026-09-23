const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    productSelectionRunStatusSite,
    loadActiveProductSelectionUserIds,
    filterRowsToActiveUsers
} = require('../product-selection-run-status');

function mockSupabase(runStatusRows, creditRows, userRows = []) {
    const settingsRows = [];
    return {
        from(table) {
            const filters = [];
            let allowedIds = null;
            let allowedIdColumn = 'user_id';
            let updateValues = null;
            let upsertValues = null;
            const sourceForTable = () => {
                if (table === 'user_store_run_status') return runStatusRows;
                if (table === 'user_credit_balances') return creditRows;
                if (table === 'users') return userRows;
                if (table === 'app_settings') return settingsRows;
                throw new Error(`Unexpected table ${table}`);
            };
            const filteredRows = () => sourceForTable()
                .filter((row) => filters.every(([column, value]) => row[column] === value))
                .filter((row) => !allowedIds || allowedIds.has(String(row[allowedIdColumn])));
            const applyMutation = () => {
                if (table === 'user_store_run_status' && updateValues) {
                    filteredRows().forEach((row) => Object.assign(row, updateValues));
                }
                if (upsertValues) {
                    const values = Array.isArray(upsertValues) ? upsertValues : [upsertValues];
                    const source = sourceForTable();
                    values.forEach((value) => {
                        const match = table === 'app_settings'
                            ? source.find((row) => row.key === value.key)
                            : source.find((row) => row.user_id === value.user_id && row.site === value.site);
                        if (match) Object.assign(match, value);
                        else source.push({ ...value });
                    });
                }
            };
            const builder = {
                select() { return builder; },
                eq(column, value) { filters.push([column, value]); return builder; },
                in(column, values) {
                    assert.ok(['user_id', 'id'].includes(column));
                    allowedIdColumn = column;
                    allowedIds = new Set(values.map(String));
                    return builder;
                },
                update(values) { updateValues = values; return builder; },
                upsert(values) { upsertValues = values; return builder; },
                order() { return builder; },
                async maybeSingle() {
                    const rows = filteredRows();
                    return { data: rows[0] || null, error: null };
                },
                async range(from, to) {
                    return { data: filteredRows().slice(from, to + 1), error: null };
                },
                then(resolve) {
                    applyMutation();
                    return Promise.resolve({ data: updateValues || upsertValues ? null : filteredRows(), error: null }).then(resolve);
                }
            };
            return builder;
        }
    };
}

(async () => {
    assert.strictEqual(productSelectionRunStatusSite('target'), 'target');
    assert.strictEqual(productSelectionRunStatusSite('pokemon'), 'pokemoncenter');

    const runStatusRows = [
        { user_id: 'owner', site: 'target', is_enabled: false },
        { user_id: 'torres', site: 'target', is_enabled: false },
        { user_id: 'linkin', site: 'target', is_enabled: true },
        { user_id: 'battgirl', site: 'target', is_enabled: true },
        { user_id: 'jose', site: 'target', is_enabled: true },
        { user_id: 'torres', site: 'amazon', is_enabled: true }
    ];
    const supabase = mockSupabase(runStatusRows, [
        { user_id: 'owner', balance: -1025 },
        { user_id: 'linkin', balance: 8 },
        { user_id: 'battgirl', balance: -15 },
        { user_id: 'jose', balance: -31 }
    ], [
        { id: 'owner', role: 'super_admin' },
        { id: 'linkin', role: 'user' },
        { id: 'battgirl', role: 'user' },
        { id: 'jose', role: 'user' }
    ]);

    const activeTargetUsers = await loadActiveProductSelectionUserIds(supabase, 'target', null);
    assert.deepStrictEqual(activeTargetUsers, new Set(['owner', 'linkin', 'battgirl']), 'regular paused users must be excluded while super admin remains exportable');
    assert.strictEqual(runStatusRows.find((row) => row.user_id === 'jose').is_enabled, false, 'a stale active status must be repaired when credit balance is below -15');

    const scopedActiveUsers = await loadActiveProductSelectionUserIds(supabase, 'target', ['torres', 'linkin']);
    assert.deepStrictEqual(scopedActiveUsers, new Set(['linkin']), 'admin scope and active status must both apply');

    const scopedSuperAdmin = await loadActiveProductSelectionUserIds(supabase, 'target', ['owner']);
    assert.deepStrictEqual(scopedSuperAdmin, new Set(['owner']), 'super admin must remain exportable despite a paused status and negative balance');

    const selections = [
        { user_id: 'torres', sku: 'paused-sku' },
        { user_id: 'linkin', sku: 'active-sku' }
    ];
    assert.deepStrictEqual(
        filterRowsToActiveUsers(selections, activeTargetUsers),
        [{ user_id: 'linkin', sku: 'active-sku' }],
        'paused selections must remain stored but be absent from operational exports'
    );

    const source = fs.readFileSync(path.join(__dirname, '..', 'product-catalog-routes.js'), 'utf8');
    assert.match(source, /app\.get\('\/admin\/product-selection-export-users'[\s\S]*?loadActiveProductSelectionUserIds\(supabase, site, scopedUserIds\)/, 'the selector endpoint must load active users for the selected store');
    assert.match(source, /filterRowsToActiveUsers\(data, activeUserIds\)\.forEach/, 'the selector and pending count must exclude paused selections');
    assert.match(source, /app\.get\('\/admin\/product-selections\/export'[\s\S]*?excluded_paused: true/, 'direct paused-user exports must return empty output');
    assert.match(source, /const resolvedData = filterRowsToActiveUsers\(data, activeUserIds\)\.map/, 'bulk Stellar and Shikari exports must exclude paused users');

    const eligibilitySource = fs.readFileSync(path.join(__dirname, '..', 'product-selection-run-status.js'), 'utf8');
    assert.match(eligibilitySource, /from\('user_credit_balances'\)/, 'product exports must verify credit eligibility directly');
    assert.match(eligibilitySource, /from\('users'\)[\s\S]*?eq\('role', 'super_admin'\)/, 'product exports must explicitly include super admin accounts');
    assert.match(eligibilitySource, /shouldAutoPauseStores\(row\.balance\)/, 'the same below -15 policy must drive export exclusion');
    assert.match(eligibilitySource, /pauseStoresForCreditLimit\(supabase, blockedId/, 'stale active run-status rows must be repaired with automatic-pause provenance');

    console.log('product selection paused-user tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
