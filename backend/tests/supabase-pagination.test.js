const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    fetchAllSupabaseRows,
    fetchAllSupabaseRowsInBatches
} = require('../supabase-pagination');

function pagedQuery(rows, calls, batch = null) {
    return {
        async range(from, to) {
            calls.push({ from, to, batch });
            return { data: rows.slice(from, to + 1), error: null };
        }
    };
}

(async () => {
    const rows = Array.from({ length: 2505 }, (_, index) => ({ id: index + 1 }));
    const pageCalls = [];
    const allRows = await fetchAllSupabaseRows(() => pagedQuery(rows, pageCalls), 1000);

    assert.ifError(allRows.error);
    assert.strictEqual(allRows.data.length, 2505, 'pagination must return rows beyond the Supabase 1,000-row limit');
    assert.deepStrictEqual(pageCalls.map(({ from, to }) => [from, to]), [
        [0, 999],
        [1000, 1999],
        [2000, 2999]
    ], 'pagination must request consecutive, non-overlapping ranges');

    const values = Array.from({ length: 450 }, (_, index) => `profile-${index + 1}`);
    const batchCalls = [];
    const batchedRows = await fetchAllSupabaseRowsInBatches(
        [...values, values[0]],
        (batch) => pagedQuery(batch.map((profileId) => ({ profile_id: profileId })), batchCalls, batch),
        { batchSize: 200, pageSize: 100 }
    );

    assert.ifError(batchedRows.error);
    assert.strictEqual(batchedRows.data.length, 450, 'batched reads must return every unique profile exactly once');
    assert.deepStrictEqual(
        new Set(batchedRows.data.map((row) => row.profile_id)),
        new Set(values),
        'batched reads must preserve the complete set of requested profile ids'
    );
    assert.deepStrictEqual(
        [...new Set(batchCalls.map((call) => call.batch[0]))],
        ['profile-1', 'profile-201', 'profile-401'],
        'large profile-id lists must be split into safe query batches'
    );

    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(
        serverSource,
        /fetchAllSupabaseRows\(\(\) => supabase\s*\.from\("profiles"\)[\s\S]*?\.in\("user_id", userIds\)/,
        'the all-user store status route must page through every profile row'
    );
    assert.match(
        serverSource,
        /fetchAllSupabaseRowsInBatches\([\s\S]*?\.from\("profile_store_credentials"\)/,
        'the all-user store status route must safely batch profile credential reads'
    );
    assert.match(
        serverSource,
        /fetchAllSupabaseRowsInBatches\([\s\S]*?\.from\("accounts"\)/,
        'the all-user store status route must safely batch account reads'
    );

    console.log('Supabase pagination tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
