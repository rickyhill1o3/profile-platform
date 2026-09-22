const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    buildShikariAccountsCsv,
    buildShikariImapCsv,
    resolveShikariImapServer
} = require('../shikari-credential-exports');

assert.deepStrictEqual(resolveShikariImapServer('user@gmail.com'), { imap_server: 'imap.gmail.com', port: '993' });
assert.deepStrictEqual(resolveShikariImapServer('user@hotmail.com'), { imap_server: 'outlook.office365.com', port: '993' });
assert.deepStrictEqual(resolveShikariImapServer('user@yahoo.com'), { imap_server: 'imap.mail.yahoo.com', port: '993' });
assert.deepStrictEqual(resolveShikariImapServer('user@icloud.com'), { imap_server: 'imap.mail.me.com', port: '993' });
assert.deepStrictEqual(resolveShikariImapServer('user@aol.com'), { imap_server: 'export.imap.aol.com', port: '993' });
assert.strictEqual(resolveShikariImapServer('user@example.com'), null);

const accountsCsv = buildShikariAccountsCsv([
    { username: 'first@gmail.com', password: 'retailer-password' },
    { username: 'comma,user@example.com', password: 'quoted,"password"' },
    { username: 'missing-password@example.com', password: '' }
]);
assert.strictEqual(
    accountsCsv,
    'username,password\r\nfirst@gmail.com,retailer-password\r\n"comma,user@example.com","quoted,""password"""\r\n'
);

const imapCsv = buildShikariImapCsv([
    { username: 'first@gmail.com', password: 'abcd efgh ijkl mnop' },
    { username: 'second@hotmail.com', password: 'outlook-app-password' },
    { username: 'unsupported@example.com', password: 'not-exported-without-host' },
    { imap_server: 'imap.custom.example', port: 993, username: 'custom@example.com', password: 'custom-app-password' }
]);
assert.strictEqual(
    imapCsv,
    'imap_server,port,username,password\r\nimap.gmail.com,993,first@gmail.com,abcd efgh ijkl mnop\r\noutlook.office365.com,993,second@hotmail.com,outlook-app-password\r\nimap.custom.example,993,custom@example.com,custom-app-password\r\n'
);

const projectRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');

assert.match(serverSource, /buildShikariAccountsCsv\(rows\)/, 'account route must use the Shikari CSV builder');
assert.match(serverSource, /buildShikariImapCsv\(rows\)/, 'IMAP route must use the Shikari CSV builder');
assert.match(serverSource, /Content-Type", "text\/csv; charset=utf-8"/, 'credential exports must be served as CSV');
assert.match(frontendScript, /'\/admin\/export\/accounts-txt', 'shikari-accounts', '\.csv'/, 'active account export must download CSV');
assert.match(frontendScript, /'\/admin\/export\/gmail-imap-txt', 'shikari-imap', '\.csv'/, 'active IMAP export must download CSV');
assert.match(adminHtml, /Export Shikari Accounts[\s\S]*?CSV/, 'admin must label the account export for Shikari');
assert.match(adminHtml, /Export Shikari IMAP CSV/, 'admin must label the IMAP export for Shikari');

console.log('Shikari account and IMAP credential export tests passed');
