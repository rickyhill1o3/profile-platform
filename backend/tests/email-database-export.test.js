const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const backend = fs.readFileSync(path.join(projectRoot, 'backend', 'order-tracker.js'), 'utf8');
const frontend = fs.readFileSync(path.join(projectRoot, 'frontend', 'order-tracker.js'), 'utf8');
const html = fs.readFileSync(path.join(projectRoot, 'frontend', 'order-tracker.html'), 'utf8');

const routeStart = backend.indexOf("app.get('/orders/email-database-export'");
const routeEnd = backend.indexOf("app.get('/orders/email-index-export'", routeStart);
assert(routeStart >= 0 && routeEnd > routeStart, 'email export route must be registered');
const route = backend.slice(routeStart, routeEnd);

assert.match(route, /req\.role !== 'super_admin'/, 'the export must be super-admin only');
assert.match(route, /\.eq\('user_id', req\.user_id\)/, 'the archive query must remain user scoped');
assert.doesNotMatch(route, /\.eq\('store'|\.eq\('email_type'|ownedMailboxes\.has/, 'the parser-development export must not filter retailer, type, or imported mailbox');
assert.match(route, /zlib\.createGzip/, 'large exports must be compressed as a stream');
assert.match(route, /record_type:'export_manifest'/, 'the JSONL file must describe its format and privacy scope');
assert.match(route, /record_type:'export_complete'/, 'the JSONL file must end with export counts');
assert.match(route, /signed_in_super_admin_complete_collected_email_archive/, 'the manifest must identify the complete super-admin archive scope');
assert.match(route, /all recognized and unrecognized email types/, 'the manifest must confirm unknown email types are included');
assert.match(route, /body_text:row\.body_text/, 'stored plain text must be included for parser review');
assert.match(route, /body_html:row\.body_html/, 'stored HTML must be included for link and template review');
assert.match(route, /excludes:\['attachment files','mailbox passwords','OAuth tokens'\]/, 'credentials and attachment files must be expressly excluded');
assert.doesNotMatch(route.slice(route.indexOf('const safeEmailRecord'), route.indexOf('let totalArchiveRows')), /password_enc|app_password_enc|refresh_token_enc|client_secret_enc/, 'credential fields must never enter an email record');

assert.match(html, /id="exportEmailDatabase" hidden>Export full parser archive</, 'the complete export button must be hidden until super-admin bootstrap');
assert.match(html, /id="exportEmailIndex" hidden>Export readable email list</, 'the readable CSV button must be hidden until super-admin bootstrap');
assert.match(html, /order-tracker\.js\?v=20260929-reconcile-readable-export/, 'the browser must receive the new script version');
assert.match(frontend, /\$\('exportEmailDatabase'\)\.hidden=false/, 'bootstrap must reveal the button only to super admins');
assert.match(frontend, /\$\('exportEmailIndex'\)\.hidden=false/, 'bootstrap must reveal the readable export only to super admins');
assert.match(frontend, /fetch\(`\$\{API\}\/orders\/email-database-export`,\{headers:\{Authorization:`Bearer \$\{token\}`\}\}\)/, 'the browser download must send the signed-in bearer token');
assert.match(frontend, /response\.blob\(\)/, 'the compressed response must download as a file');
assert.match(frontend, /Your readable email list and complete collected-email parser archive are ready/, 'successful reconciliation must explain both export choices');

const indexStart = backend.indexOf("app.get('/orders/email-index-export'");
const indexEnd = backend.indexOf("app.get('/orders/account-alerts'", indexStart);
assert(indexStart >= 0 && indexEnd > indexStart, 'readable email index route must be registered');
const indexRoute = backend.slice(indexStart, indexEnd);
assert.match(indexRoute, /req\.role !== 'super_admin'/, 'the readable export must be super-admin only');
assert.match(indexRoute, /\.eq\('user_id', req\.user_id\)/, 'the readable export must remain user scoped');
assert.match(indexRoute, /text\/csv; charset=utf-8/, 'the readable export must download as CSV');
assert.match(indexRoute, /large stored bodies/, 'route documentation must explain that large bodies are omitted');
assert.doesNotMatch(indexRoute.match(/const columns = ([^;]+);/)?.[1] || '', /body_text|body_html/, 'readable rows must not include large MIME bodies');
assert.match(indexRoute, /Prevent spreadsheet formula injection/, 'sender-controlled cells must be safe to open in Excel');
assert.match(frontend, /fetch\(`\$\{API\}\/orders\/email-index-export`/, 'the readable export button must call the CSV endpoint');

console.log('Collected email database export tests passed');
