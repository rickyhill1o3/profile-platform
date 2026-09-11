const assert = require('assert');
const { buildProfileAccountsByUserStore } = require('../profile-account-summary');

const assignments = [
    { profile_id:'profile-3', profile_name:'Target 3', user_id:'collector', stores:['target'] },
    { profile_id:'profile-1', profile_name:'Target 1', user_id:'collector', stores:['target', 'walmart'] },
    { profile_id:'profile-2', profile_name:'Target 2', user_id:'collector', stores:['target'] }
];
const exact = new Map([
    ['profile-1:target', new Set(['ONE@EXAMPLE.COM'])],
    ['profile-2:target', new Set(['two@example.com'])],
    ['profile-1:walmart', new Set(['walmart@example.com'])]
]);
const fallback = new Map([
    ['profile-3', new Set(['three@example.com'])]
]);

const result = buildProfileAccountsByUserStore(assignments, exact, fallback);
const target = result.get('collector:target');
assert.strictEqual(target.length, 3, 'all three Target-assigned profiles must be displayed');
assert.deepStrictEqual(target.map((profile) => profile.profile_name), ['Target 1', 'Target 2', 'Target 3']);
assert.deepStrictEqual(target.map((profile) => profile.login_email), ['one@example.com', 'two@example.com', 'three@example.com']);
assert.strictEqual(result.get('collector:walmart').length, 1, 'store filtering must not mix another retailer into Target');
assert.strictEqual(result.get('collector:walmart')[0].login_email, 'walmart@example.com');

console.log('profile account summary tests passed');
