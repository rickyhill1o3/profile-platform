const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    applyExcludeCurrentUserFilter,
    shouldExcludeCurrentUser
} = require('../admin-export-audience');

function fakeQuery() {
    return {
        filters: [],
        neq(column, value) {
            this.filters.push({ operation: 'neq', column, value });
            return this;
        }
    };
}

assert.strictEqual(shouldExcludeCurrentUser({
    currentUserRole: 'super_admin', currentUserId: 'super-1', excludeCurrentUser: true
}), true);
assert.strictEqual(shouldExcludeCurrentUser({
    currentUserRole: 'super_admin', currentUserId: 'super-1', selectedUserId: 'user-2', excludeCurrentUser: true
}), false, 'choosing one user must override the combined audience');
assert.strictEqual(shouldExcludeCurrentUser({
    currentUserRole: 'admin', currentUserId: 'admin-1', excludeCurrentUser: true
}), false, 'the combined audience is a super-admin-only option');

const profileQuery = fakeQuery();
applyExcludeCurrentUserFilter(profileQuery, {
    currentUserRole: 'super_admin', currentUserId: 'super-1', excludeCurrentUser: true
});
assert.deepStrictEqual(profileQuery.filters, [{ operation: 'neq', column: 'user_id', value: 'super-1' }]);

const usersQuery = fakeQuery();
applyExcludeCurrentUserFilter(usersQuery, {
    currentUserRole: 'super_admin', currentUserId: 'super-1', excludeCurrentUser: true, column: 'id'
});
assert.deepStrictEqual(usersQuery.filters, [{ operation: 'neq', column: 'id', value: 'super-1' }]);

const root = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');

assert.match(scriptSource, /All Admins \+ Users — Exclude My Profiles/);
assert.match(scriptSource, /exclude_current_user/);
assert.match(scriptSource, /ALL_EXCEPT_CURRENT_USER/);
assert.match(serverSource, /current_user:\s*\{\s*id:\s*currentUser\.id,\s*role:\s*currentUser\.role\s*\}/);
assert.ok((serverSource.match(/applyRequestedCurrentUserExclusion\(/g) || []).length >= 11,
    'store status and every active export route must use the same exclusion rule');
assert.match(adminSource, /script\.js\?v=20261104-export-other-users/);

console.log('Admin export audience tests passed.');
