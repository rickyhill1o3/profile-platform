const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'script.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'TARGET_SUPER_ADMIN_ACCOUNT_SHARING.sql'), 'utf8');

assert.match(server, /app\.patch\('\/target-personal-accounts\/status'/, 'personal Target status endpoint must exist');
assert.match(server, /source_profile_id:\s*item\.profile\.id/, 'paused personal profiles must link to shared pool rows');
assert.match(server, /release_reason:\s*'source_profile_reactivated'/, 'reactivation must release current shared assignments with history');
assert.match(server, /personalState\.get\(String\(profile\.id\)\)\s*!==\s*false/, 'paused personal profiles must be filtered from Target exports');
assert.match(server, /target_personal_account_enabled/, 'profile responses must expose the personal Target run state');
assert.match(server, /password_encrypted:\s*encrypt\(item\.password\)/, 'shared account passwords must be encrypted');

assert.match(frontend, /data-target-personal-status="on"/, 'Target toolbar must include Turn On Accounts');
assert.match(frontend, /data-target-personal-status="pause"/, 'Target toolbar must include Pause Accounts');
assert.match(frontend, /Paused · shared pool/, 'paused profiles must be visibly labeled');
['bulkProfileName', 'bulkProfileFirstName', 'bulkProfileLastName', 'bulkProfileEmail', 'bulkProfilePhone',
 'bulkProfileAddress1', 'bulkProfileAddress2', 'bulkProfileCity', 'bulkProfileState', 'bulkProfileZip',
 'bulkProfileCard', 'bulkProfileExpMonth', 'bulkProfileExpYear', 'bulkProfileCvv', 'bulkProfileLoginEmail',
 'bulkProfileLoginPassword', 'bulkProfileGmailAppPassword', 'bulkProfileAmazon2fa'].forEach((id) => {
    assert.match(frontend, new RegExp(`id="${id}"`), `bulk editor must include ${id}`);
});

assert.match(migration, /create table if not exists public\.target_personal_account_status/, 'migration must create the personal status table');
assert.match(migration, /add column if not exists source_profile_id/, 'migration must link pool rows to personal profiles');

console.log('target super-admin account sharing tests passed');
