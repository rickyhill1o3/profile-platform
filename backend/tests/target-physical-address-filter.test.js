const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sameTargetPhysicalAddress, targetBaseStreetParts } = require('../target-physical-address');

const projectRoot = path.resolve(__dirname, '..', '..');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const frontendStyles = fs.readFileSync(path.join(projectRoot, 'frontend', 'styles.css'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');

assert.match(frontendScript, /let targetPhysicalAddressFilter = '';/, 'the selected physical-address group must have its own filter state');
assert.match(frontendScript, /activeTargetAddressProfileIds = new Set\(\(activeTargetAddressGroup\?\.profile_ids/, 'address filtering must use the backend group profile IDs');
assert.match(frontendScript, /activeTargetAddressProfileIds\.has\(String\(p\.id\)\)/, 'only profiles belonging to the selected physical address may remain visible');
assert.match(frontendScript, /data-target-address-filter=/, 'each physical-address row must expose a filter control');
assert.match(frontendScript, /data-target-address-filter-clear/, 'the active address filter must provide a clear action');
assert.match(frontendScript, /Showing physical address/, 'the dashboard must visibly identify the active address filter');
assert.match(frontendScript, /visibleDashboardProfileIdsByGroup\.get\(group\)/, 'bulk selection must use the currently visible profile IDs');
assert.match(frontendScript, /visibleIds\.has\(String\(p\.id\)\).*selectedProfileIds\.has\(String\(p\.id\)\)/, 'bulk edit and delete must exclude hidden selected profiles');
assert.match(frontendStyles, /\.target-address-filter-button/);
assert.match(frontendStyles, /\.target-address-filter-active/);
assert.match(serverSource, /profile_ids:\s*group\.profile_ids/, 'the address distribution response must include exact profile membership');
assert.match(serverSource, /item\.match_addresses\s*\|\|\s*\[item\.sample_address\]/, 'each group must compare against all spelling variants already assigned to it');
assert.match(serverSource, /for \(const entry of savedAddressPool\)[\s\S]*?existingGroup[\s\S]*?existingGroup\.match_addresses\.push/, 'older duplicate saved address aliases must collapse into one displayed box');
assert.match(serverSource, /selected\s*\?\s*!sameTargetPhysicalAddress\(selected, item \|\| \{\}\)/, 'removing one displayed physical address must also remove its saved aliases');

const canonical190 = { address1: '190 Tabernacle Lane', city: 'Aydlett', state: 'North Carolina', zip: '27916' };
const variants190 = [
    '190 Tabernacle Lane Barn',
    '190 Tabernacle Lane Basement',
    '190 Tabernacle Lane BLDING 1A',
    '190 Tabernacle Lane BOX 0923',
    '190 Tabernacle Lane DORM 8273',
    '190 Tabernacle road Lane',
    '190 Tabernacle Barn Lane',
    '190 Tabernacle Beach Lane',
    '190 Tabernacle Lane APT 9837',
    '190 Tabernacle Ln basement apartment 2',
    '190 Tabernacle Ln building 2',
    '190 Tabernacle Ln room 4',
    '190 Tabernacle Ln unit 5',
    '190 Tebarnekle Ln'
].map((address1) => ({ ...canonical190, address1 }));

assert.strictEqual(variants190.length, 14, 'the reported 190 group fixture should contain all 14 profiles');
for (const variant of variants190) {
    assert.strictEqual(
        sameTargetPhysicalAddress(canonical190, variant),
        true,
        `${variant.address1} should remain in the 190 Tabernacle physical-address box`
    );
}
assert.deepStrictEqual(targetBaseStreetParts(variants190[2]).street_tokens, ['tabernacle'], 'misspelled building detail must not become part of the street identity');
assert.strictEqual(sameTargetPhysicalAddress(canonical190, { ...canonical190, address1: '194 Tabernacle Lane' }), false, 'different house numbers must stay separate');
assert.strictEqual(sameTargetPhysicalAddress(canonical190, { ...canonical190, zip: '27965' }), false, 'different ZIP codes must stay separate');
assert.strictEqual(sameTargetPhysicalAddress(canonical190, { ...canonical190, address1: '190 Narrow Shore Road' }), false, 'an unrelated street at the same number must stay separate');

console.log('target physical address filter tests passed');
