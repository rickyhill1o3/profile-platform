const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const profileHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'profile.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'dashboard.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(projectRoot, 'backend', 'sql', 'COSTCO_PROFILE_SCHEMA.sql'), 'utf8');

assert.match(profileHtml, /name="assigned_stores" value="costco"/, 'profile editor must allow Costco assignment');
assert.match(frontendScript, /costco:\s*\{\s*label:\s*'Costco',\s*method:\s*'imap'/, 'Costco must collect login, password, and IMAP credentials');
assert.match(frontendScript, /pokemoncenter:\s*\{[^}]*method:\s*'guest_imap'/, 'Pokémon Center must use guest email plus IMAP');
assert.match(frontendScript, /cfg\.method === 'guest_imap' \? ''/, 'Pokémon Center must not render a retailer password field');
assert.match(frontendScript, /accountPasswordField\.style\.display = group === 'pokemoncenter' \? 'none'/, 'Pokémon Center bulk edit must hide the retailer password field');
assert.match(frontendScript, /cfg\.method === 'guest_imap'\) return hasEmail && \(hasImap \|\| usesAycd\)/, 'Pokémon Center credential readiness must not require an account password');

assert.match(dashboardHtml, /data-user-nav="costco"/, 'dashboard must include the Costco store tab');
assert.match(dashboardHtml, /id="costcoProfilesPanel"/, 'dashboard must display Costco profiles');
assert.match(dashboardHtml, /option value="costco">Costco<\/option>/, 'profile import must support Costco');

assert.match(adminHtml, /id="adminRunStatusStoreFilter"[\s\S]*?option value="costco">Costco<\/option>/, 'admin run status must filter Costco');
assert.match(adminHtml, /id="adminRunStatusExportCostcoAccountsButton"/, 'admin must provide a dedicated active Costco account export');
assert.match(frontendScript, /new URLSearchParams\(\{ group: 'costco', active_only: '1' \}\)/, 'Costco export must enforce the active-only filter');

assert.match(serverSource, /PROFILE_ACCOUNT_TYPES[^\n]*"costco"/, 'backend must accept Costco profiles');
assert.match(serverSource, /STORE_RUN_STATUS_SITES[^\n]*"costco"/, 'backend run-status model must include Costco');
assert.match(serverSource, /imapStores = new Set\([^\n]*'costco'[^\n]*'pokemoncenter'/, 'backend must persist Costco and Pokémon Center IMAP values');
assert.match(serverSource, /login_password:\s*store === 'pokemoncenter' \? ''/, 'backend must not copy another store password into Pokémon Center');
assert.match(serverSource, /hasLoginPassword = store !== 'pokemoncenter'/, 'backend bulk edit must ignore Pokémon Center retailer passwords');
assert.match(serverSource, /profile\.store_credentials\.pokemoncenter = \{[\s\S]*?login_email:\s*String\(profile\.addresses\?\.\[0\]\?\.email/, 'existing Pokémon Center profiles must expose the saved profile email as their checkout email');
assert.match(migrationSource, /profiles_account_type_check[\s\S]*?'costco'/, 'database profile constraint must accept Costco');
assert.match(migrationSource, /profile_store_credentials_store_check[\s\S]*?'costco'/, 'database credential constraint must accept Costco');
assert.match(migrationSource, /user_store_run_status_site_check[\s\S]*?'costco'/, 'database run-status constraint must accept Costco');

console.log('Pokémon Center IMAP and Costco store expansion tests passed');
