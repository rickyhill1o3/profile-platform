'use strict';

function clean(value) {
    return String(value ?? '').trim();
}

function semicolonCsvCell(value) {
    const text = String(value ?? '');
    if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function buildStellarAmazonAccountsCsv(accounts = []) {
    const headers = [
        'email',
        'password',
        'region',
        'authenticatorKey',
        'accountType',
        'cvv',
        'loginIp',
        'loginMethod'
    ];

    const rows = (accounts || [])
        .map((account) => {
            const email = clean(account?.email || account?.username);
            const password = clean(account?.password);
            return [
                email,
                password,
                clean(account?.region) || 'US',
                clean(account?.authenticatorKey || account?.authenticator_key).replace(/\s+/g, ''),
                clean(account?.accountType || account?.account_type),
                clean(account?.cvv),
                clean(account?.loginIp || account?.login_ip),
                clean(account?.loginMethod || account?.login_method)
            ];
        })
        .filter(([email, password]) => email && password);

    return [headers, ...rows]
        .map((row) => row.map(semicolonCsvCell).join(';'))
        .join('\r\n') + '\r\n';
}

module.exports = {
    buildStellarAmazonAccountsCsv
};
