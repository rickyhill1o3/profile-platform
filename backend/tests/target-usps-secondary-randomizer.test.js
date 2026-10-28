const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    REQUIRED_USPS_SECONDARY_DESIGNATORS,
    OPTIONAL_USPS_SECONDARY_DESIGNATORS,
    canonicalTargetSourceAddress,
    buildTargetUspsRandomizationPlan,
    validateTargetUspsRandomizationPlan
} = require('../target-usps-secondary-randomizer');

assert.deepStrictEqual(REQUIRED_USPS_SECONDARY_DESIGNATORS, [
    'APT', 'BLDG', 'DEPT', 'FL', 'HNGR', 'KEY', 'LOT', 'PIER', 'RM', 'SLIP', 'SPC', 'STOP', 'STE', 'TRLR', 'UNIT', '#'
]);
assert.deepStrictEqual(OPTIONAL_USPS_SECONDARY_DESIGNATORS, ['BSMT', 'FRNT', 'LBBY', 'LOWR', 'OFC', 'PH', 'REAR', 'SIDE', 'UPPR']);

const sourceAddresses = [
    '190 Tabernacle Lane Barn', '190 Tabernacle Lane Basement', '190 Tabernacle Lane BLDING 1A',
    '190 Tabernacle Lane BOX 0923', '190 Tabernacle Lane DORM 8273', '190 Tabernacle road Lane',
    '190 Tabernacle Barn Lane', '190 Tabernacle Beach Lane', '190 Tabernacle Lane APT 9837',
    '190 Tabernacle Ln basement apartment 2', '190 Tabernacle Ln building 2',
    '190 Tabernacle Ln room 4', '190 Tabernacle Ln unit 5', '190 Tebarnekle Ln'
].map((address1) => ({ address1, address2: '', city: 'Aydlett', state: 'North Carolina', zip: '27916' }));

assert.deepStrictEqual(canonicalTargetSourceAddress(sourceAddresses), {
    address1: '190 Tabernacle Lane', address2: '', city: 'Aydlett', state: 'North Carolina', zip: '27916'
});

let randomCursor = 0;
const deterministicRandomInt = (minimum, maximum) => {
    randomCursor += 137;
    return minimum + (randomCursor % (maximum - minimum));
};
const profileIds = Array.from({ length: 14 }, (_, index) => `profile-${index + 1}`);
const plan = buildTargetUspsRandomizationPlan({ profileIds, sourceAddresses, randomInt: deterministicRandomInt });
assert.strictEqual(plan.assignments.length, 14);
assert.strictEqual(new Set(plan.assignments.map((row) => row.address1)).size, 14, 'every selected profile must receive a unique address line');

for (const assignment of plan.assignments) {
    assert.ok(assignment.address1.startsWith('190 Tabernacle Lane '));
    if (REQUIRED_USPS_SECONDARY_DESIGNATORS.includes(assignment.designator)) {
        assert.match(assignment.secondary_range, /^\d{4}$/, `${assignment.designator} must receive exactly four digits`);
        assert.match(assignment.address1, new RegExp(` ${assignment.designator === '#' ? '#' : assignment.designator} \\d{4}$`));
    } else {
        assert.strictEqual(assignment.secondary_range, '', `${assignment.designator} must not receive a number`);
        assert.ok(assignment.address1.endsWith(` ${assignment.designator}`));
    }
}

const selected194Addresses = Array.from({ length: 14 }, () => ({
    address1: '194 Tabernacle Lane', address2: '', city: 'Aydlett', state: 'North Carolina', zip: '27916'
}));
const plan194 = buildTargetUspsRandomizationPlan({
    profileIds,
    sourceAddresses: selected194Addresses,
    randomInt: deterministicRandomInt
});
assert.strictEqual(plan194.source.address1, '194 Tabernacle Lane');
assert.ok(plan194.assignments.every((row) => row.address1.startsWith('194 Tabernacle Lane ')));
assert.ok(plan194.assignments.every((row) => !row.address1.startsWith('190 Tabernacle Lane ')), 'the selected 194 group must never copy the 190 group');
assert.strictEqual(canonicalTargetSourceAddress(plan194.assignments).address1, '194 Tabernacle Lane', 'the randomized profiles must remain one reusable physical-address group');
assert.throws(() => buildTargetUspsRandomizationPlan({
    profileIds: ['mixed-1', 'mixed-2'],
    sourceAddresses: [selected194Addresses[0], sourceAddresses[0]],
    randomInt: deterministicRandomInt
}), /one physical-address group/i);

const validated = validateTargetUspsRandomizationPlan({ profileIds, sourceAddresses, assignments: plan.assignments });
assert.strictEqual(validated.assignments.length, 14);
const largePlan = buildTargetUspsRandomizationPlan({
    profileIds: Array.from({ length: 40 }, (_, index) => `large-${index + 1}`),
    sourceAddresses,
    randomInt: deterministicRandomInt
});
assert.strictEqual(new Set(largePlan.assignments.map((row) => row.address1)).size, 40, 'larger batches must stay unique after no-range designators are exhausted');
assert.throws(() => validateTargetUspsRandomizationPlan({
    profileIds,
    sourceAddresses,
    assignments: plan.assignments.map((row, index) => index === 0 ? { ...row, address1: '190 Tabernacle Lane APT 12' } : row)
}), /approved USPS designator|four-digit/i);

const projectRoot = path.resolve(__dirname, '..', '..');
const frontend = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const server = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
assert.match(frontend, /Randomize selected address with USPS designators/);
assert.match(frontend, /Preview randomized versions of this address/);
assert.doesNotMatch(frontend, /bulkTargetAddressRandomizerSource/);
assert.doesNotMatch(frontend, /source_profile_id:\s*data\.source_profile_id/);
assert.match(frontend, /target_address_randomization:\s*targetAddressRandomization/);
assert.match(server, /app\.post\("\/profiles\/target-address-randomizer\/preview"/);
assert.match(server, /targetRandomizerSelectedAddresses\(selected\)/);
assert.doesNotMatch(server, /targetRandomizerSourceAddresses/);
assert.match(server, /validateTargetUspsRandomizationPlan/);
assert.match(server, /targetRandomizedAddressByProfile/);

console.log('Target USPS secondary-address randomizer tests passed');
