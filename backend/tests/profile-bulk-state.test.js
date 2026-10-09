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
assert.match(frontendScript, /id="bulkProfileName"/, 'bulk editor must include the profile-name control');
assert.match(frontendScript, /Matching profile names are allowed/, 'bulk editor must explain that matching names are supported');
assert.match(frontendScript, /profile_name:\s*profileName\s*\|\|\s*undefined/, 'bulk editor must submit the shared profile name');
assert.match(frontendScript, /state:\s*state\s*\|\|\s*undefined/, 'bulk editor must submit the selected state');
assert.match(frontendScript, /!profileName[\s\S]*?aycdAction\s*===\s*'keep'\s*&&\s*!state/, 'profile-name-only and state-only bulk edits must pass client validation');
assert.match(serverSource, /\.from\('profiles'\)[\s\S]*?\.update\(\{ profile_name: requestedProfileName \}\)[\s\S]*?\.eq\('user_id', req\.user_id\)[\s\S]*?\.in\('id'/, 'bulk endpoint must rename only selected profiles owned by the current user');
assert.match(serverSource, /Bulk renaming intentionally permits matching names/, 'bulk rename must intentionally allow matching profile names');
assert.match(serverSource, /\.from\('addresses'\)[\s\S]*?\.update\(\{ state: requestedState \}\)[\s\S]*?\.in\('profile_id'/, 'bulk endpoint must update only selected profile address rows');
assert.match(serverSource, /const changedTargetProfiles = \(hasState \|\| hasProfileName \|\| store === 'target'\)/, 'shared profile-name changes must put assigned Target profiles into standby');
assert.match(serverSource, /const changedStores = \(hasState \|\| hasProfileName\)[\s\S]*?profileAssignedStores/, 'a shared name or address change must mark all assigned store exports as changed');

console.log('profile bulk state tests passed');
