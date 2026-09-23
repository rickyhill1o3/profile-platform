'use strict';

const assert = require('assert');
const {
    loadCreditAutoPauseState,
    pauseStoresForCreditLimit,
    markCreditPurchaseRestorePending,
    restoreAutomaticallyPausedStores,
    forgetAutomaticallyPausedStore,
    findLegacyRecoveryWindow,
    recoverLegacyAutomaticallyPausedStores
} = require('../credit-store-lifecycle');

function mockSupabase(seed = {}) {
    const tables = {
        user_store_run_status: (seed.user_store_run_status || []).map((row) => ({ ...row })),
        app_settings: (seed.app_settings || []).map((row) => ({ ...row }))
    };

    return {
        tables,
        from(table) {
            if (!tables[table]) throw new Error(`Unexpected table ${table}`);
            const filters = [];
            let updateValues = null;
            let upsertValues = null;
            const filtered = () => tables[table].filter((row) => filters.every(([column, value]) => row[column] === value));
            const applyMutation = () => {
                if (updateValues) filtered().forEach((row) => Object.assign(row, updateValues));
                if (upsertValues) {
                    const rows = Array.isArray(upsertValues) ? upsertValues : [upsertValues];
                    rows.forEach((value) => {
                        const existing = table === 'app_settings'
                            ? tables[table].find((row) => row.key === value.key)
                            : tables[table].find((row) => row.user_id === value.user_id && row.site === value.site);
                        if (existing) Object.assign(existing, value);
                        else tables[table].push({ ...value });
                    });
                }
            };
            const builder = {
                select() { return builder; },
                eq(column, value) { filters.push([column, value]); return builder; },
                update(values) { updateValues = values; return builder; },
                upsert(values) { upsertValues = values; return builder; },
                async maybeSingle() {
                    return { data: filtered()[0] || null, error: null };
                },
                then(resolve) {
                    applyMutation();
                    return Promise.resolve({
                        data: updateValues || upsertValues ? null : filtered().map((row) => ({ ...row })),
                        error: null
                    }).then(resolve);
                }
            };
            return builder;
        }
    };
}

(async () => {
    const db = mockSupabase({
        user_store_run_status: [
            { user_id: 'new-user', site: 'target', is_enabled: true, updated_at: '2026-09-23T00:00:00.000Z' },
            { user_id: 'new-user', site: 'walmart', is_enabled: true, updated_at: '2026-09-23T00:00:00.000Z' },
            { user_id: 'new-user', site: 'amazon', is_enabled: false, updated_at: '2026-09-01T00:00:00.000Z' }
        ]
    });

    const paused = await pauseStoresForCreditLimit(db, 'new-user', -16, { now: '2026-09-23T01:00:00.000Z' });
    assert.deepStrictEqual(paused.paused_sites.sort(), ['target', 'walmart']);
    assert.strictEqual(db.tables.user_store_run_status.find((row) => row.site === 'target').is_enabled, false);
    assert.strictEqual(db.tables.user_store_run_status.find((row) => row.site === 'amazon').is_enabled, false, 'an already-manual pause must remain untouched');

    let state = await loadCreditAutoPauseState(db, 'new-user');
    assert.deepStrictEqual(state.sites.sort(), ['target', 'walmart'], 'only stores the website actually paused are remembered');

    await markCreditPurchaseRestorePending(db, 'new-user', 0, { now: '2026-09-23T02:00:00.000Z' });
    const restored = await restoreAutomaticallyPausedStores(db, 'new-user', 0);
    assert.deepStrictEqual(restored.restored_sites.sort(), ['target', 'walmart']);
    assert.strictEqual(db.tables.user_store_run_status.find((row) => row.site === 'target').is_enabled, true);
    assert.strictEqual(db.tables.user_store_run_status.find((row) => row.site === 'walmart').is_enabled, true);
    assert.strictEqual(db.tables.user_store_run_status.find((row) => row.site === 'amazon').is_enabled, false, 'a store paused manually before the credit event must stay paused');

    const manualDb = mockSupabase({
        user_store_run_status: [
            { user_id: 'manual-user', site: 'target', is_enabled: true, updated_at: '2026-09-23T00:00:00.000Z' }
        ]
    });
    await pauseStoresForCreditLimit(manualDb, 'manual-user', -20, { now: '2026-09-23T01:00:00.000Z' });
    await forgetAutomaticallyPausedStore(manualDb, 'manual-user', 'target');
    await markCreditPurchaseRestorePending(manualDb, 'manual-user', 0);
    const manualRestore = await restoreAutomaticallyPausedStores(manualDb, 'manual-user', 0);
    assert.strictEqual(manualRestore.restored, false);
    assert.strictEqual(manualDb.tables.user_store_run_status[0].is_enabled, false, 'an explicit manual pause must cancel automatic restoration');

    const exemptDb = mockSupabase({
        user_store_run_status: [
            { user_id: 'owner', site: 'target', is_enabled: true, updated_at: '2026-09-23T00:00:00.000Z' },
            { user_id: 'owner', site: 'amazon', is_enabled: false, updated_at: '2026-09-01T00:00:00.000Z' }
        ]
    });
    await pauseStoresForCreditLimit(exemptDb, 'owner', -1025, { now: '2026-09-23T01:00:00.000Z' });
    const exemptRestore = await restoreAutomaticallyPausedStores(exemptDb, 'owner', -1025, {
        requirePending: false,
        bypassBalance: true,
        now: '2026-09-23T02:00:00.000Z'
    });
    assert.deepStrictEqual(exemptRestore.restored_sites, ['target'], 'a super-admin exemption must reverse prior provenance-tracked automatic pauses at any balance');
    assert.strictEqual(exemptDb.tables.user_store_run_status.find((row) => row.site === 'target').is_enabled, true);
    assert.strictEqual(exemptDb.tables.user_store_run_status.find((row) => row.site === 'amazon').is_enabled, false, 'the exemption must not turn on a manually paused store');

    const legacyTransactions = [
        { id: 'charge-1', amount_delta: -5, reason: 'successful_checkout', balance_after: -14, created_at: '2026-09-20T10:00:00.000Z' },
        { id: 'charge-2', amount_delta: -5, reason: 'successful_checkout', balance_after: -19, created_at: '2026-09-20T11:00:00.000Z' },
        { id: 'charge-3', amount_delta: -12, reason: 'successful_checkout', balance_after: -31, created_at: '2026-09-21T11:00:00.000Z' },
        { id: 'jose-purchase', amount_delta: 31, reason: 'stripe_purchase', balance_after: 0, created_at: '2026-09-22T23:09:00.000Z' }
    ];
    assert.deepStrictEqual(findLegacyRecoveryWindow(legacyTransactions), {
        started_at: '2026-09-20T11:00:00.000Z',
        recovered_at: '2026-09-22T23:09:00.000Z',
        transaction: 'jose-purchase'
    });

    const legacyDb = mockSupabase({
        user_store_run_status: [
            { user_id: 'jose', site: 'target', is_enabled: false, updated_at: '2026-09-22T22:56:00.000Z' },
            { user_id: 'jose', site: 'amazon', is_enabled: false, updated_at: '2026-09-01T10:00:00.000Z' }
        ]
    });
    const legacyRestore = await recoverLegacyAutomaticallyPausedStores(legacyDb, 'jose', 0, legacyTransactions, { now: '2026-09-23T00:00:00.000Z' });
    assert.deepStrictEqual(legacyRestore.restored_sites, ['target'], 'Jose-style legacy recovery must restore only stores paused during the below-limit episode');
    assert.strictEqual(legacyDb.tables.user_store_run_status.find((row) => row.site === 'target').is_enabled, true);
    assert.strictEqual(legacyDb.tables.user_store_run_status.find((row) => row.site === 'amazon').is_enabled, false, 'older manual pauses must remain paused during legacy recovery');

    state = await loadCreditAutoPauseState(legacyDb, 'jose');
    assert.strictEqual(state.legacy_recovery_transaction, 'jose-purchase', 'legacy recovery must be recorded so it cannot repeat');

    console.log('credit store lifecycle tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
