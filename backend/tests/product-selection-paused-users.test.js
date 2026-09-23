const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    productSelectionRunStatusSite,
    loadActiveProductSelectionUserIds,
    filterRowsToActiveUsers
} = require('../product-selection-run-status');

function mockSupabase(runStatusRows, creditRows) {
    return {
        from(table) {
            const filters = [];
            let allowedIds = null;
            let updateValues = null;
            const builder = {
                select() { return builder; },
                eq(column, value) { filters.push([column, value]); return builder; },
                in(column, values) {
                    assert.strictEqual(column, 'user_id');
                    allowedIds = new Set(values.map(String));
                    return builder;
                },
                update(values) { updateValues = values; return builder; },
                order() { return builder; },
                async range(from, to) {
                    const source = table === 'user_store_run_status' ? runStatusRows : creditRows;
                    assert.ok(['user_store_run_status', 'user_credit_balances'].includes(table));
                    const filtered = source.filter((row) => filters.every(([column, value]) => row[column] === value))
                        .filter((row) => !allowedIds || allowedIds.has(String(row.user_id)));
                    return { data: filtered.slice(from, to + 1), error: null };
                },
                then(resolve) {
                    if (table === 'user_store_run_status' && updateValues) {
                        runStatusRows.forEach((row) => {
                            if (filters.every(([column, value]) => row[column] === value)
                                && (!allowedIds || allowedIds.has(String(row.user_id)))) {
                                Object.assign(row, updateValues);
                            }
                        });
                    }
                    return Promise.resolve({ data: null, error: null }).then(resolve);
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
        { user_id: 'torres', site: 'target', is_enabled: false },
        { user_id: 'linkin', site: 'target', is_enabled: true },
        { user_id: 'battgirl', site: 'target', is_enabled: true },
        { user_id: 'jose', site: 'target', is_enabled: true },
        { user_id: 'torres', site: 'amazon', is_enabled: true }
    ];
    const supabase = mockSupabase(runStatusRows, [
        { user_id: 'linkin', balance: 8 },
        { user_id: 'battgirl', balance: -15 },
        { user_id: 'jose', balance: -31 }
    ]);

    const activeTargetUsers = await loadActiveProductSelectionUserIds(supabase, 'target', null);
    assert.deepStrictEqual(activeTargetUsers, new Set(['linkin', 'battgirl']), 'paused Target users must be excluded');
    assert.strictEqual(runStatusRows.find((row) => row.user_id === 'jose').is_enabled, false, 'a stale active status must be repaired when credit balance is below -15');

    const scopedActiveUsers = await loadActiveProductSelectionUserIds(supabase, 'target', ['torres', 'linkin']);
    assert.deepStrictEqual(scopedActiveUsers, new Set(['linkin']), 'admin scope and active status must both apply');

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
    assert.match(eligibilitySource, /shouldAutoPauseStores\(row\.balance\)/, 'the same below -15 policy must drive export exclusion');
    assert.match(eligibilitySource, /update\(\{ is_enabled: false/, 'stale active run-status rows must be repaired');

    console.log('product selection paused-user tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
