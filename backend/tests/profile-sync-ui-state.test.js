const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mergeUserCache } = require('../../frontend/profile-sync-state');

const cachedUsers = [
    {
        id: 'linkin',
        email: 'linkin4112000@yahoo.com',
        stores: [
            { site: 'target', changed_since_acknowledged: true },
            { site: 'walmart', changed_since_acknowledged: false }
        ]
    },
    { id: 'other', stores: [{ site: 'target', changed_since_acknowledged: false }] }
];

const freshSelectedUser = [
    {
        id: 'linkin',
        email: 'linkin4112000@yahoo.com',
        stores: [{ site: 'target', changed_since_acknowledged: false, acknowledged_at: '2026-09-18T00:00:00.000Z' }]
    }
];

const merged = mergeUserCache(cachedUsers, freshSelectedUser, false);
assert.strictEqual(merged.length, 2, 'refreshing one selected user must preserve the full user selector');
assert.strictEqual(
    merged.find((user) => user.id === 'linkin').stores.find((store) => store.site === 'target').changed_since_acknowledged,
    false,
    'the fresh acknowledged Target row must replace the stale pending row'
);
assert.strictEqual(
    merged.find((user) => user.id === 'linkin').stores.find((store) => store.site === 'walmart').changed_since_acknowledged,
    false,
    'stores omitted by the filtered response must remain cached'
);

const replacedSet = mergeUserCache(cachedUsers, freshSelectedUser, true);
assert.deepStrictEqual(replacedSet.map((user) => user.id), ['linkin'], 'a full user-list refresh must discard users no longer returned');

const projectRoot = path.resolve(__dirname, '..', '..');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const serverScript = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');

assert.match(adminHtml, /profile-sync-state\.js\?v=20260918-profile-sync-display/, 'admin must load the profile sync cache helper');
assert.match(frontendScript, /mergeUserCache\(lastUsers, users, !userFilter\.value\)/, 'admin refresh must merge the acknowledged user into the selector cache');
assert.match(frontendScript, /renderUserOptions\(lastUsers\);[\s\S]*?updateProfileSyncBanner\(\);/, 'dropdown and banner must render from the refreshed shared cache');
assert.match(serverScript, /fetchAllSupabaseRows\(buildUsersQuery\)/, 'the all-user sync view must load the complete user list');
assert.match(serverScript, /fetchAllSupabaseRows\(\(\) => supabase\s*\.from\("profiles"\)/, 'the all-user sync view must load every profile before comparing acknowledged counts');

console.log('profile sync UI state tests passed');
