const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeBulkProfileState } = require('../profile-bulk-update');

assert.strictEqual(normalizeBulkProfileState('NC'), 'North Carolina');
assert.strictEqual(normalizeBulkProfileState('north carolina'), 'North Carolina');
assert.strictEqual(normalizeBulkProfileState(' North Carolina '), 'North Carolina');
assert.strictEqual(normalizeBulkProfileState('not-a-state'), '');
assert.strictEqual(normalizeBulkProfileState(''), '');

const projectRoot = path.resolve(__dirname, '..', '..');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');

assert.match(frontendScript, /id="bulkProfileState"/, 'bulk editor must include the shipping-state control');
assert.match(frontendScript, /state:\s*state\s*\|\|\s*undefined/, 'bulk editor must submit the selected state');
assert.match(frontendScript, /aycdAction\s*===\s*'keep'\s*&&\s*!state/, 'state-only bulk edits must pass client validation');
assert.match(serverSource, /\.from\('addresses'\)[\s\S]*?\.update\(\{ state: requestedState \}\)[\s\S]*?\.in\('profile_id'/, 'bulk endpoint must update only selected profile address rows');
assert.match(serverSource, /const changedStores = hasState[\s\S]*?profileAssignedStores/, 'a shared address change must mark all assigned store exports as changed');

console.log('profile bulk state tests passed');
