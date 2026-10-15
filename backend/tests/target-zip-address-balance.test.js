const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    buildZipAddressBalancePlan,
    addZipScopedIdealCounts
} = require('../target-address-zip-balancer');

const addressA = { address1: '120 Soundview Dr', city: 'Aydlett', state: 'NC', zip: '27916' };
const addressB = { address1: '190 Tabernacle Lane', city: 'Aydlett', state: 'NC', zip: '27916' };
const addressC = { address1: '194 Tabernacle Lane', city: 'Aydlett', state: 'NC', zip: '27916' };

const profiles = [
    { id: 1, addresses: [{ ...addressA }] },
    { id: 2, addresses: [{ ...addressA }] },
    { id: 3, addresses: [{ ...addressA }] },
    { id: 4, addresses: [{ ...addressA }] },
    { id: 5, addresses: [{ ...addressB }] },
    { id: 6, addresses: [{ ...addressB }] },
    { id: 7, addresses: [{ ...addressC }] },
    { id: 8, addresses: [{ address1: '121 Tabernacle Lane', city: 'Aydlett', state: 'NC', zip: '27916-1234' }] },
    { id: 9, addresses: [{ address1: '126 Neals Creek Rd', city: 'Poplar Branch', state: 'NC', zip: '27965' }] },
    { id: 10, addresses: [{ address1: '126 Neals Creek Rd', city: 'Poplar Branch', state: 'NC', zip: '27965' }] }
];

const plan = buildZipAddressBalancePlan({ profiles, addresses: [addressA, addressB, addressC], zip: '27916' });
assert.strictEqual(plan.eligible_count, 8, 'only profiles in the selected ZIP may be included');
assert.deepStrictEqual(plan.distribution.map((row) => row.profile_count), [3, 3, 2], 'selected ZIP must be distributed as evenly as possible');
assert.strictEqual(plan.assignments.some((row) => row.profile_id === 9 || row.profile_id === 10), false, 'profiles in another ZIP must never be reassigned');
assert.strictEqual(plan.unchanged_count, 6, 'the planner should preserve already-correct addresses whenever quotas allow');
assert.strictEqual(plan.changed_count, 2, 'only excess or unmatched addresses should move');

const editedAddressA = { ...addressA, address1: '125 Soundview Drive' };
const editPlan = buildZipAddressBalancePlan({ profiles, addresses: [editedAddressA, addressB, addressC], zip: '27916' });
assert.strictEqual(editPlan.assignments.some((row) => row.address.address1 === addressA.address1), false, 'editing a listed address must remove the old address from every resulting assignment');
assert.strictEqual(editPlan.assignments.filter((row) => [1, 2, 3, 4].includes(row.profile_id)).every((row) => row.changed), true, 'every profile that used the edited address must be updated');

const removePlan = buildZipAddressBalancePlan({ profiles, addresses: [addressA, addressB], zip: '27916' });
assert.deepStrictEqual(removePlan.distribution.map((row) => row.profile_count), [4, 4], 'removing an address must redistribute its profiles evenly among the addresses that remain');
assert.strictEqual(removePlan.assignments.some((row) => row.address.address1 === addressC.address1), false, 'a removed address must not remain in any assignment');

assert.throws(() => buildZipAddressBalancePlan({
    profiles,
    zip: '27916',
    addresses: [addressA, { ...addressA, address1: '120 soundview dr.' }]
}), /unique/i, 'duplicate destinations must be rejected');

const scoped = addZipScopedIdealCounts([
    { label: 'A', sample_address: { zip: '27916' }, profile_ids: [1, 2, 3, 4] },
    { label: 'B', sample_address: { zip: '27916' }, profile_ids: [5, 6] },
    { label: 'C', sample_address: { zip: '27965' }, profile_ids: [9, 10] }
]);
const zip27916 = scoped.filter((row) => row.zip === '27916');
const zip27965 = scoped.filter((row) => row.zip === '27965');
assert.deepStrictEqual(zip27916.map((row) => row.ideal_count), [3, 3], 'even targets must be calculated inside each ZIP');
assert.deepStrictEqual(zip27965.map((row) => row.ideal_count), [2], 'a separate ZIP must have its own target');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'script.js'), 'utf8');
assert.match(serverSource, /app\.post\('\/target-address-balance'/, 'backend must expose the ZIP balance action');
assert.match(serverSource, /confirm_zip/, 'applying a bulk address change must require the selected ZIP confirmation');
assert.match(serverSource, /update\(\{\s*address1:[\s\S]*?address2:[\s\S]*?city:[\s\S]*?state:[\s\S]*?zip:/, 'the action must update only shipping address fields');
assert.doesNotMatch(serverSource.match(/app\.post\('\/target-address-balance'[\s\S]*?app\.get\('\/target-profile-health'/)?.[0] || '', /billing_address/, 'ZIP balancing must not overwrite separate billing-address fields');
assert.match(frontendSource, /Balance one ZIP/, 'Target dashboard must expose the ZIP balancing tool');
assert.match(frontendSource, /Preview distribution/, 'the UI must preview changes before applying them');
assert.match(frontendSource, /addresses:\s*\[\],\s*addressKeys:\s*new Set\(\)/, 'each ZIP must collect its current unique physical addresses for the modal');
assert.match(frontendSource, /current\.addresses\.push\(\{[\s\S]*?address1:\s*address\.address1/, 'the modal choices must retain the complete current address instead of blank seed rows');
assert.match(frontendSource, /renderTargetBalanceAddressRows\(modal, existingAddresses\.length \? existingAddresses/, 'opening or changing a ZIP must preload its current addresses');
assert.doesNotMatch(frontendSource, /Array\.from\(\{ length: 5 \}/, 'the modal must not create five blank or duplicate address rows');
assert.match(frontendSource, /Edit a row to replace that address everywhere, or remove it to redistribute its profiles/, 'the modal must explain edit and remove behavior');

console.log('target ZIP address balance tests passed');
