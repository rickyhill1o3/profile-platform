'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildStellarAmazonAccountsText } = require('../stellar-amazon-account-export');

const output = buildStellarAmazonAccountsText([
    {
        email: 'amazon-user@example.com',
        password: 'pass;word',
        region: '',
        authenticatorKey: 'JBSW Y3DP EHPK 3PXP',
        accountType: 'business',
        cvv: '123',
        loginIp: '192.0.2.1',
        loginMethod: 'browser'
    },
    { email: 'missing-password@example.com', password: '' }
]);

assert.strictEqual(
    output,
    'amazon-user@example.com;"pass;word";US;JBSWY3DPEHPK3PXP;personal;123;;request\r\n'
);
assert.strictEqual(buildStellarAmazonAccountsText([]), '', 'an empty export must be an empty text file');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');

assert.match(serverSource, /app\.get\("\/admin\/export\/stellar-amazon-accounts-txt"/);
assert.match(serverSource, /attachAndFilterProfilesByStore\(profiles \|\| \[\], "amazon"\)/, 'the export must include only Amazon-assigned profiles');
assert.match(serverSource, /filterProfilesByActiveRunStatus\(exportProfiles, "amazon", activeOnly\)/, 'the active export must honor Amazon Store Run Status');
assert.match(serverSource, /authenticatorKey: account\.amazon_2fa_secret \|\| account\.two_fa_secret/, 'the Amazon authenticator secret must map into the Stellar column');
assert.match(serverSource, /cardCvv = payment\.cvv_encrypted \? decrypt\(payment\.cvv_encrypted\)/, 'the profile CVV must map into the Stellar account row');
assert.match(serverSource, /accountType: "personal"/);
assert.match(serverSource, /loginIp: ""/);
assert.match(serverSource, /loginMethod: "request"/);
assert.match(serverSource, /buildStellarAmazonAccountsText\(rows\)/);
assert.match(serverSource, /"Content-Type", "text\/plain; charset=utf-8"/);
assert.match(serverSource, /filename="\$\{filename\}\.txt"/);
assert.match(frontendSource, /'\/admin\/export\/stellar-amazon-accounts-txt\?'/);
assert.match(frontendSource, /filename \+ '\.txt'/);
assert.match(frontendSource, /stellar-accounts-amazon-active-/);
assert.match(adminHtml, /Export Active Stellar Amazon Accounts TXT/);
assert.match(adminHtml, /script\.js\?v=20260925-stellar-amazon-paste-txt/);

console.log('Stellar Amazon account export tests passed');
