const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const backend = fs.readFileSync(path.join(projectRoot, 'backend', 'order-tracker.js'), 'utf8');
const frontend = fs.readFileSync(path.join(projectRoot, 'frontend', 'order-tracker.js'), 'utf8');
const html = fs.readFileSync(path.join(projectRoot, 'frontend', 'order-tracker.html'), 'utf8');

const routeStart = backend.indexOf("app.get('/orders/email-database-export'");
const routeEnd = backend.indexOf("app.get('/orders/account-alerts'", routeStart);
assert(routeStart >= 0 && routeEnd > routeStart, 'email export route must be registered');
const route = backend.slice(routeStart, routeEnd);

assert.match(route, /req\.role !== 'super_admin'/, 'the export must be super-admin only');
assert.match(route, /buildRetailerPaymentAlertOwnerMap\(supabase\)/, 'mailbox ownership must be resolved before export');
assert.match(route, /String\(owner\.matched_user_id\) === String\(req\.user_id\)/, 'only the signed-in owner mailboxes may be selected');
assert.match(route, /\.eq\('user_id', req\.user_id\)/, 'the archive query must remain user scoped');
assert.match(route, /if \(!mailbox \|\| !ownedMailboxes\.has\(mailbox\)\)/, 'each exported row must pass the mailbox ownership filter');
assert.match(route, /zlib\.createGzip/, 'large exports must be compressed as a stream');
assert.match(route, /record_type:'export_manifest'/, 'the JSONL file must describe its format and privacy scope');
assert.match(route, /record_type:'export_complete'/, 'the JSONL file must end with export counts');
assert.match(route, /body_text:row\.body_text/, 'stored plain text must be included for parser review');
assert.match(route, /body_html:row\.body_html/, 'stored HTML must be included for link and template review');
assert.match(route, /excludes:\['attachment files','mailbox passwords','OAuth tokens','other users mailboxes'\]/, 'secrets, attachments, and other users must be expressly excluded');
assert.doesNotMatch(route.slice(route.indexOf('const safeEmailRecord'), route.indexOf('let totalArchiveRows')), /password_enc|app_password_enc|refresh_token_enc|client_secret_enc/, 'credential fields must never enter an email record');

assert.match(html, /id="exportEmailDatabase" hidden>Export my collected emails</, 'the download button must be hidden until super-admin bootstrap');
assert.match(html, /order-tracker\.js\?v=20260928-email-database-export/, 'the browser must receive the new script version');
assert.match(frontend, /\$\('exportEmailDatabase'\)\.hidden=false/, 'bootstrap must reveal the button only to super admins');
assert.match(frontend, /fetch\(`\$\{API\}\/orders\/email-database-export`,\{headers:\{Authorization:`Bearer \$\{token\}`\}\}\)/, 'the browser download must send the signed-in bearer token');
assert.match(frontend, /response\.blob\(\)/, 'the compressed response must download as a file');
assert.match(frontend, /Your collected-email export is ready/, 'successful reconciliation must tell the admin that the snapshot is ready');

console.log('Collected email database export tests passed');
