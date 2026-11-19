const assert = require('assert');
const {
  validateTargetRaffleExport,
  targetLoginEmailForProfile,
  buildTargetRaffleProfiles
} = require('../target-raffle-export');

assert.deepStrictEqual(validateTargetRaffleExport({ requested: false }), { requested: false, ok: true });
assert.strictEqual(validateTargetRaffleExport({
  requested: true,
  currentUserRole: 'admin',
  group: 'target'
}).status, 403);
assert.strictEqual(validateTargetRaffleExport({
  requested: true,
  currentUserRole: 'super_admin',
  group: 'amazon'
}).status, 400);
assert.strictEqual(validateTargetRaffleExport({
  requested: true,
  currentUserRole: 'super_admin',
  group: 'target',
  excludeCurrentUser: true
}).ok, false);
assert.strictEqual(validateTargetRaffleExport({
  requested: true,
  currentUserRole: 'super_admin',
  group: 'target'
}).ok, true);

const baseProfile = {
  id: 'profile-user-1',
  user_id: 'user-1',
  profile_name: 'User Target',
  addresses: [{ email: 'already@example.com' }],
  accounts: [{ provider: 'target', login_email: 'assigned-extra@example.com' }],
  store_credentials: { target: { login_email: 'assigned-extra@example.com' } }
};
assert.strictEqual(targetLoginEmailForProfile(baseProfile), 'assigned-extra@example.com');

const templates = [
  {
    id: 'super-profile-1',
    user_id: 'super-1',
    profile_name: 'Owner One',
    addresses: [{ first_name: 'Owner', last_name: 'One', email: 'owner1@example.com', address1: '1 Main St' }],
    payments: [{ card_name: 'Owner One', card_encrypted: 'encrypted-1' }],
    accounts: [{ provider: 'target', login_email: 'owner1@example.com', login_password: 'owner-pass-1' }],
    store_credentials: { target: { login_email: 'owner1@example.com', login_password: 'owner-pass-1' } }
  },
  {
    id: 'super-profile-2',
    user_id: 'super-1',
    profile_name: 'Owner Two',
    addresses: [{ first_name: 'Owner', last_name: 'Two', email: 'owner2@example.com', address1: '2 Main St' }],
    payments: [{ card_name: 'Owner Two', card_encrypted: 'encrypted-2' }],
    accounts: [{ provider: 'target', login_email: 'owner2@example.com', login_password: 'owner-pass-2' }],
    store_credentials: { target: { login_email: 'owner2@example.com', login_password: 'owner-pass-2' } }
  }
];

const result = buildTargetRaffleProfiles({
  profiles: [baseProfile, ...templates],
  templates,
  openAccounts: [
    { id: 'open-2', login_email: 'z-open@example.com', login_password: 'z-pass', status: 'available' },
    { id: 'open-1', login_email: 'a-open@example.com', login_password: 'a-pass', status: 'available' },
    { id: 'duplicate', login_email: 'ASSIGNED-EXTRA@example.com', login_password: 'duplicate', status: 'available' },
    { id: 'disabled', login_email: 'disabled@example.com', login_password: 'disabled', status: 'disabled' }
  ]
});

assert.strictEqual(result.length, 5, 'two unique enabled open accounts should be added');
const raffleRows = result.filter((profile) => profile.is_target_raffle_account);
assert.strictEqual(raffleRows.length, 2);
assert.deepStrictEqual(raffleRows.map(targetLoginEmailForProfile), ['a-open@example.com', 'z-open@example.com']);
assert.strictEqual(raffleRows[0].addresses[0].address1, '1 Main St', 'the first open account should use the first owner template');
assert.strictEqual(raffleRows[1].addresses[0].address1, '2 Main St', 'the next open account should rotate to the next owner template');
assert.strictEqual(raffleRows[0].addresses[0].email, 'a-open@example.com');
assert.strictEqual(raffleRows[0].store_credentials.target.login_password, 'a-pass');
assert.strictEqual(raffleRows[1].accounts[0].login_email, 'z-open@example.com');

assert.throws(() => buildTargetRaffleProfiles({
  profiles: [],
  templates: [],
  openAccounts: [{ id: 'open-1', login_email: 'open@example.com', status: 'available' }]
}), /at least one enabled Target profile/i);

console.log('Target raffle export tests passed.');
