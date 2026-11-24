'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClient } = require('@supabase/supabase-js');
const { applyExcludeCurrentUserFilter } = require('../admin-export-audience');
const { validateTargetRaffleExport } = require('../target-raffle-export');
const { fetchAllSupabaseRows } = require('../supabase-pagination');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function section(start, end) {
    const from = server.indexOf(start);
    const to = server.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Missing server section: ${start}`);
    return server.slice(from, to);
}

function profile(id, user_id, account_type) {
    return {
        id, user_id, account_type,
        profile_name: id,
        created_at: '2026-01-01T00:00:00Z',
        addresses: [{ email: `${id}@example.com` }]
    };
}

const regular = Array.from({ length: 1005 }, (_, i) => profile(`general-${i}`, 'other', 'general'));
const raffle = Array.from({ length: 608 }, (_, i) => profile(`raffle-${i}`, 'owner', 'raffle'));
let database = [...regular, ...raffle];
const requests = [];
const supabase = createClient('https://export-test.example', 'test-key', {
    global: {
        async fetch(input) {
            const { pathname, searchParams } = new URL(input);
            assert.strictEqual(pathname, '/rest/v1/profiles');
            const offset = Number(searchParams.get('offset') || 0);
            const limit = Number(searchParams.get('limit') || 1000);
            const type = searchParams.get('account_type');
            requests.push({ offset, limit, type, order: searchParams.get('order') });
            const rows = database.filter((row) => {
                if (type && type !== `eq.${row.account_type}`) return false;
                return searchParams.getAll('user_id').every((filter) => {
                    if (filter.startsWith('eq.')) return row.user_id === filter.slice(3);
                    if (filter.startsWith('neq.')) return row.user_id !== filter.slice(4);
                    if (filter.startsWith('in.(')) return filter.slice(4, -1).split(',').includes(row.user_id);
                    assert.fail(`Unexpected user filter: ${filter}`);
                });
            });
            return new Response(JSON.stringify(rows.slice(offset, offset + Math.min(limit, 1000))));
        }
    }
});

const handlers = new Map();
const vmContext = vm.createContext({
    app: { get: (route, ...args) => handlers.set(route, args.at(-1)) },
    auth: () => {},
    admin: () => {},
    supabase,
    fetchAllSupabaseRows,
    applyExcludeCurrentUserFilter,
    validateTargetRaffleExport,
    getCurrentUser: async (req) => req.currentUser,
    getScopeUserIdsForAdmin: async () => ['member'],
    safeIn: (ids) => ids,
    normalizeSplitBot: () => '',
    loadProfileStoreAssignments: async () => new Map(),
    loadProfileStoreCredentials: async (ids) => new Map(ids.map((id) => [id, {
        general: { login_email: `${id}@example.com` }
    }])),
    appendAssignedTargetExtraProfiles: async (items, group) => {
        assert.notStrictEqual(group, 'target', 'Target extra accounts are covered by their own tests');
        return items;
    }
});
vm.runInContext([
    section('const PROFILE_ACCOUNT_TYPES', 'async function loadStoreRunStatusForUsers'),
    section('function profileAssignedStores', 'async function loadProfileStoreAssignments'),
    section('async function fetchProfileExportRows', 'async function appendAssignedTargetExtraProfiles'),
    section('function applyRequestedCurrentUserExclusion', 'app.get("/admin/export/accounts"'),
    section('app.get("/admin/export/count"', 'function twoDigitYear'),
    section('function countryForStellar', 'function targetBotSplitSettingKey'),
    section('app.get("/admin/export/profiles-shikari-csv"', 'app.get("/admin/export/accounts-txt"')
].join('\n'), vmContext);

const group = { group: 'raffle' };
const all = { id: 'owner', role: 'super_admin' };
const scoped = { id: 'admin', role: 'admin' };
const countRoute = '/admin/export/count';
const jsonRoute = '/admin/export/profiles-json';
const csvRoute = '/admin/export/profiles-shikari-csv';

async function request(route, query = group, currentUser = all) {
    const response = {
        statusCode: 200,
        status(value) { this.statusCode = value; return this; },
        json(data) { this.data = data; },
        send(data) { this.data = data; },
        setHeader() {}
    };
    await handlers.get(route)({ query, currentUser }, response);
    return response;
}

(async () => {
    // Unrelated profiles fill the first database page before any raffle rows.
    assert.equal((await request(countRoute)).data.count, 608);
    const json = JSON.parse((await request(jsonRoute)).data);
    assert.deepEqual(json.map((row) => row.email), raffle.map((row) => row.addresses[0].email));
    const csv = (await request(csvRoute)).data.trimEnd().split('\r\n');
    assert.equal(csv.length, 609);
    assert.deepEqual(csv.slice(1).map((row) => row.split(',')[3]), json.map((row) => row.email));

    const attach = vm.runInContext('attachAndFilterProfilesByStore', vmContext);
    const mixed = [regular[0], raffle[0]];
    assert.equal(JSON.stringify((await attach(mixed, 'general')).map((row) => row.id)), '["general-0"]');
    assert.equal((await attach(mixed)).length, 2, 'All Groups still includes both profile types');

    database = [
        ...database,
        ...Array.from({ length: 395 }, (_, i) => profile(`member-raffle-${i}`, 'member', 'raffle'))
    ];
    requests.length = 0;
    assert.equal((await request(countRoute)).data.count, 1003);
    assert.equal(JSON.parse((await request(jsonRoute)).data).length, 1003);
    assert.deepEqual(requests.map((entry) => entry.offset), [0, 1000, 0, 1000]);
    assert.ok(requests.every((entry) => entry.type === 'eq.raffle' && entry.order.endsWith('id.asc')));

    assert.equal((await request(countRoute, group, scoped)).data.count, 395);
    assert.equal(JSON.parse((await request(jsonRoute, group, scoped)).data).length, 395);
    assert.equal((await request(jsonRoute, { ...group, user_id: 'owner' }, scoped)).statusCode, 403);
    assert.equal((await request(countRoute, { ...group, user_id: 'owner' })).data.count, 608);
    assert.equal((await request(countRoute, { ...group, exclude_current_user: '1' })).data.count, 395);

    console.log('Raffle Builder export count, downloads, pagination, and account scope tests passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
