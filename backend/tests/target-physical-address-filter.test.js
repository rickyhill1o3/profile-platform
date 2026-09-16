const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

console.log('target physical address filter tests passed');
