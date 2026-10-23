'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MAX_ASSIGNMENTS_PER_PROFILE,
  clampMaxAssignmentsPerProfile,
  parseExtraTargetAccountLines,
  planEvenAssignments,
  resolveAssignmentAtTime,
  buildSyntheticTargetProfile
} = require('../target-extra-accounts');

assert.strictEqual(DEFAULT_MAX_ASSIGNMENTS_PER_PROFILE, 3);
assert.strictEqual(clampMaxAssignmentsPerProfile('5'), 5);
assert.strictEqual(clampMaxAssignmentsPerProfile('99'), 10);
assert.strictEqual(clampMaxAssignmentsPerProfile('not-a-number'), 3);

const parsed = parseExtraTargetAccountLines([
  'First@example.com:password:with:colons',
  'second@example.com:secret',
  'FIRST@example.com:different',
  'not-an-account'
].join('\n'));
assert.strictEqual(parsed.valid.length, 2);
assert.strictEqual(parsed.valid[0].email, 'first@example.com');
assert.strictEqual(parsed.valid[0].password, 'password:with:colons');
assert.strictEqual(parsed.duplicateInput.length, 1);
assert.strictEqual(parsed.invalid.length, 1);

const users = [
  { id: 'user-a', profiles: [{ id: 'profile-a1', address_key: 'address-a1' }, { id: 'profile-a2', address_key: 'address-a2' }] },
  { id: 'user-b', profiles: [{ id: 'profile-b1', address_key: 'address-b1' }, { id: 'profile-b2', address_key: 'address-b2' }] },
  { id: 'user-c', profiles: [{ id: 'profile-c1', address_key: 'address-c1' }, { id: 'profile-c2', address_key: 'address-c2' }] }
];
const accounts = Array.from({ length: 12 }, (_, index) => ({ id: `account-${index}`, login_email: `account${index}@example.com`, status: 'available' }));
const fairPlan = planEvenAssignments({ users, accounts, cycleId: 'fixed-cycle', mode: 'new_cycle' });
assert.strictEqual(fairPlan.create.length, 12);
assert.deepStrictEqual(Object.values(fairPlan.counts).sort(), [4, 4, 4], 'the full pool should be divided evenly across opted-in users');
for (const user of users) {
  const perProfile = user.profiles.map((profile) => fairPlan.profile_counts[profile.id] || 0);
  assert.ok(Math.max(...perProfile) - Math.min(...perProfile) <= 1, 'each user assignment should be balanced across saved Target addresses');
}

const cappedAccounts = Array.from({ length: 14 }, (_, index) => ({ id: `solo-${index}`, login_email: `solo${index}@example.com`, status: 'available' }));
const cappedPlan = planEvenAssignments({ users: [users[0]], accounts: cappedAccounts, cycleId: 'capped-cycle', mode: 'new_cycle' });
assert.strictEqual(cappedPlan.create.length, 6, 'the default limit should assign at most three accounts to each of two profiles');
assert.strictEqual(cappedPlan.unassignedAccountIds.length, 8, 'accounts above current profile capacity must remain open');
assert.ok(Object.values(cappedPlan.profile_counts).every((count) => count <= 3));

const raisedCapPlan = planEvenAssignments({
  users: [users[0]], accounts: cappedAccounts, cycleId: 'raised-cap-cycle', mode: 'new_cycle', maxAssignmentsPerProfile: 7
});
assert.strictEqual(raisedCapPlan.create.length, 14, 'raising the adjustable limit should increase capacity without changing code');
assert.ok(Object.values(raisedCapPlan.profile_counts).every((count) => count <= 7));

const reducedCapPlan = planEvenAssignments({
  users: [{ id: 'limited-user', profiles: [{ id: 'limited-profile', address_key: 'limited-address' }] }],
  accounts: cappedAccounts.slice(0, 5),
  currentAssignments: cappedAccounts.slice(0, 5).map((account, index) => ({
    id: `existing-${index}`,
    account_id: account.id,
    user_id: 'limited-user',
    template_profile_id: 'limited-profile',
    assigned_at: `2026-10-0${index + 1}T00:00:00Z`,
    released_at: null
  })),
  cycleId: 'reduced-cap-cycle',
  mode: 'fill',
  maxAssignmentsPerProfile: 3
});
assert.strictEqual(reducedCapPlan.keep.length, 3, 'lowering the limit should preserve only the oldest assignments up to the cap');
assert.strictEqual(reducedCapPlan.release.length, 2, 'assignments above the lowered cap should be released');
assert.strictEqual(reducedCapPlan.create.length, 0, 'released overflow must stay open when no profile capacity remains');

const groupedAddressPlan = planEvenAssignments({
  users: [{ id: 'grouped-user', profiles: [
    { id: 'grouped-1', address_key: 'physical-address-1' },
    { id: 'grouped-2', address_key: 'physical-address-1' },
    { id: 'grouped-3', address_key: 'physical-address-2' }
  ] }],
  accounts: accounts.slice(0, 8),
  cycleId: 'grouped-address-cycle',
  mode: 'new_cycle',
  maxAssignmentsPerProfile: 10
});
assert.strictEqual(groupedAddressPlan.address_counts['grouped-user:physical-address-1'], 4);
assert.strictEqual(groupedAddressPlan.address_counts['grouped-user:physical-address-2'], 4);
assert.ok(Math.abs(groupedAddressPlan.profile_counts['grouped-1'] - groupedAddressPlan.profile_counts['grouped-2']) <= 1, 'profiles sharing one address should rotate within that address share');

const fillPlan = planEvenAssignments({
  users: users.slice(0, 2),
  accounts: accounts.slice(0, 5),
  currentAssignments: [{ id: 'old', account_id: 'account-0', user_id: 'user-a', template_profile_id: 'profile-a1', assigned_at: '2026-10-01T00:00:00Z', released_at: null }],
  cycleId: 'fill-cycle',
  mode: 'fill'
});
assert.strictEqual(fillPlan.keep.length, 1, 'fill mode must preserve a valid current assignment');
assert.strictEqual(fillPlan.create.length, 4);
assert.ok(Math.abs(fillPlan.counts['user-a'] - fillPlan.counts['user-b']) <= 1);

const history = [
  { id: 'week-1', user_id: 'old-owner', assigned_at: '2026-10-01T00:00:00Z', released_at: '2026-10-08T00:00:00Z' },
  { id: 'week-2', user_id: 'new-owner', assigned_at: '2026-10-08T00:00:00Z', released_at: null }
];
assert.strictEqual(resolveAssignmentAtTime(history, '2026-10-04T12:00:00Z').user_id, 'old-owner');
assert.strictEqual(resolveAssignmentAtTime(history, '2026-10-10T12:00:00Z').user_id, 'new-owner');

const template = {
  id: 'profile-a', user_id: 'user-a', profile_name: 'Primary Target', account_type: 'target',
  addresses: [{ email: 'member@example.com', address1: '1 Main St' }],
  payments: [{ card_encrypted: 'encrypted-card' }],
  store_credentials: { target: { login_email: 'member@example.com', login_password: 'member-pass' } }
};
const synthetic = buildSyntheticTargetProfile(template, { id: 'extra-1', login_email: 'EXTRA@example.com', login_password: 'extra-pass' }, { id: 'assignment-1' }, 0);
assert.strictEqual(synthetic.addresses[0].email, 'extra@example.com');
assert.strictEqual(synthetic.store_credentials.target.login_email, 'extra@example.com');
assert.strictEqual(synthetic.store_credentials.target.login_password, 'extra-pass');
assert.strictEqual(synthetic.addresses[0].address1, '1 Main St');
assert.strictEqual(template.addresses[0].email, 'member@example.com', 'building an export profile must not mutate the saved template');

const root = path.resolve(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'frontend', 'dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'backend', 'sql', 'TARGET_EXTRA_ACCOUNTS.sql'), 'utf8');

assert.match(server, /app\.post\('\/admin\/target-extra-accounts\/import'/);
assert.match(server, /loadTargetEmailsAlreadyInProfiles/);
assert.match(server, /password_encrypted:\s*encrypt\(account\.password\)/);
assert.match(server, /findTargetExtraAccountOwnerAt[\s\S]*targetExtraEventTime/);
assert.match(server, /appendAssignedTargetExtraProfiles/);
const imapRoute = server.slice(server.indexOf('app.get("/admin/export/gmail-imap-txt"'), server.indexOf('/* ================= SUPER ADMIN BOOTSTRAP'));
assert.doesNotMatch(imapRoute, /appendAssignedTargetExtraProfiles/, 'extra Target logins must never be exported as IMAP credentials');
assert.match(dashboard, /id="targetExtraAccountsOptIn"/);
assert.doesNotMatch(dashboard, /id="targetExtraTemplateProfile"/, 'members should not have to choose one Target profile');
assert.doesNotMatch(dashboard, /id="targetExtraDesiredCount"/, 'members should not choose an account quantity');
assert.match(admin, /data-admin-nav="target-extra-accounts"/);
assert.match(admin, /id="targetExtraMaxPerProfile"/);
assert.match(admin, /id="saveTargetExtraAssignmentLimitButton"/);
assert.match(script, /assigned across[\s\S]*saved Target address/);
assert.match(script, /Start a new assignment round/);
assert.match(server, /app\.patch\('\/admin\/target-extra-accounts\/settings'/);
assert.match(server, /maxAssignmentsPerProfile/);
assert.match(migration, /target_extra_account_settings/i);
assert.match(migration, /max_assignments_per_profile/i);
assert.match(migration, /where released_at is null/i);
assert.match(migration, /enable row level security/i);

console.log('Target extra-account tests passed.');
