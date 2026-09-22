function clean(value) {
    return String(value ?? '').trim();
}

function csvCell(value) {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function csvDocument(headers, rows) {
    return [headers, ...rows]
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n') + '\r\n';
}

function resolveShikariImapServer(email) {
    const domain = clean(email).toLowerCase().split('@')[1] || '';

    if (['gmail.com', 'googlemail.com'].includes(domain)) {
        return { imap_server: 'imap.gmail.com', port: '993' };
    }
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
        return { imap_server: 'outlook.office365.com', port: '993' };
    }
    if (['yahoo.com', 'ymail.com', 'rocketmail.com'].includes(domain)) {
        return { imap_server: 'imap.mail.yahoo.com', port: '993' };
    }
    if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) {
        return { imap_server: 'imap.mail.me.com', port: '993' };
    }
    if (['aol.com', 'aim.com', 'verizon.net'].includes(domain)) {
        return { imap_server: 'export.imap.aol.com', port: '993' };
    }
    if (domain === 'comcast.net') {
        return { imap_server: 'imap.comcast.net', port: '993' };
    }

    return null;
}

function buildShikariAccountsCsv(credentials = []) {
    const rows = (credentials || [])
        .map((credential) => [
            clean(credential?.username || credential?.email),
            clean(credential?.password)
        ])
        .filter(([username, password]) => username && password);

    return csvDocument(['username', 'password'], rows);
}

function buildShikariImapCsv(credentials = []) {
    const rows = (credentials || [])
        .map((credential) => {
            const username = clean(credential?.username || credential?.email);
            const password = clean(credential?.password);
            const inferred = resolveShikariImapServer(username);
            const imapServer = clean(credential?.imap_server) || inferred?.imap_server || '';
            const port = clean(credential?.port) || inferred?.port || '';
            return [imapServer, port, username, password];
        })
        .filter(([imapServer, port, username, password]) => imapServer && port && username && password);

    return csvDocument(['imap_server', 'port', 'username', 'password'], rows);
}

module.exports = {
    buildShikariAccountsCsv,
    buildShikariImapCsv,
    resolveShikariImapServer
};
