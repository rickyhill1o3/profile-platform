const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    productSelectionRunStatusSite,
    loadActiveProductSelectionUserIds,
    filterRowsToActiveUsers
} = require('../product-selection-run-status');

function mockSupabase(rows) {
    return {
        from(table) {
            assert.strictEqual(table, 'user_store_run_status');
            const filters = [];
            let allowedIds = null;
            const builder = {
                select() { return builder; },
                eq(column, value) { filters.push([column, value]); return builder; },
                in(column, values) {
                    assert.strictEqual(column, 'user_id');
                    allowedIds = new Set(values.map(String));
                    return builder;
                },
                order() { return builder; },
                async range(from, to) {
                    const filtered = rows.filter((row) => filters.every(([column, value]) => row[column] === value))
                        .filter((row) => !allowedIds || allowedIds.has(String(row.user_id)));
                    return { data: filtered.slice(from, to + 1), error: null };
                }
            };
            return builder;
        }
    };
}

(async () => {
    assert.strictEqual(productSelectionRunStatusSite('target'), 'target');
    assert.strictEqual(productSelectionRunStatusSite('pokemon'), 'pokemoncenter');

    const supabase = mockSupabase([
        { user_id: 'torres', site: 'target', is_enabled: false },
        { user_id: 'linkin', site: 'target', is_enabled: true },
        { user_id: 'battgirl', site: 'target', is_enabled: true },
        { user_id: 'torres', site: 'amazon', is_enabled: true }
    ]);

    const activeTargetUsers = await loadActiveProductSelectionUserIds(supabase, 'target', null);
    assert.deepStrictEqual(activeTargetUsers, new Set(['linkin', 'battgirl']), 'paused Target users must be excluded');

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

    console.log('product selection paused-user tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
