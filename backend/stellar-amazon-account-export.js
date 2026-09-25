'use strict';

function clean(value) {
    return String(value ?? '').trim();
}

function semicolonCsvCell(value) {
    const text = String(value ?? '');
    if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function buildStellarAmazonAccountsText(accounts = []) {
    const rows = (accounts || [])
        .map((account) => {
            const email = clean(account?.email || account?.username);
            const password = clean(account?.password);
            return [
                email,
                password,
                clean(account?.region) || 'US',
                clean(account?.authenticatorKey || account?.authenticator_key).replace(/\s+/g, ''),
                'personal',
                clean(account?.cvv),
                '',
                'request'
            ];
        })
        .filter(([email, password]) => email && password);

    if (!rows.length) return '';
    return rows.map((row) => row.map(semicolonCsvCell).join(';')).join('\r\n') + '\r\n';
}

module.exports = {
    buildStellarAmazonAccountsText
};
