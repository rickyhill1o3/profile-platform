const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadOrderTrackerTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { loadScanAccounts, requestedPokemonCenterOrderNumbers } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module,
    exports:module.exports,
    Buffer,
    URLSearchParams,
    process,
    console,
    fetch:async () => { throw new Error('Unexpected network request'); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require(id) {
      if (id === 'imapflow') return { ImapFlow:class {} };
      if (id === 'mailparser') return { simpleParser:async () => ({}) };
      if (id === 'cheerio') return { load:() => { throw new Error('Unexpected HTML parse'); } };
      if (id === './encryption') return { encrypt:value => value, decrypt:value => value };
      if (id === './discord-history-import') return { registerDiscordHistoryImport:() => {} };
      if (id === './retailer-reconciliation') {
        return {
          parseRetailEmail:() => ({}), expectedWebhookItems:() => [], matchScore:() => 0,
          mainItemMatch:() => false, deriveOverallStatus:() => 'unknown',
          parseSupremeWebhookCheckoutAt:() => null, norm:value => String(value || '')
        };
      }
      return require(id);
    }
  };
  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.__test;
}

class Query {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.filters = [];
    this.rangeStart = 0;
    this.rangeEnd = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push(row => String(row[column]) === String(value)); return this; }
  or() { return this; }
  in(column, values) { const set = new Set(values.map(String)); this.filters.push(row => set.has(String(row[column]))); return this; }
  not(column, operator) { if (operator === 'is') this.filters.push(row => row[column] != null); return this; }
  order() { return this; }
  limit(count) { this.rangeEnd = this.rangeStart + Number(count) - 1; return this; }
  range(start, end) { this.rangeStart = start; this.rangeEnd = end; return this; }
  execute() {
    const filtered = (this.database[this.table] || []).filter(row => this.filters.every(fn => fn(row)));
    const end = this.rangeEnd == null ? filtered.length : this.rangeEnd + 1;
    return { data:filtered.slice(this.rangeStart, end), error:null };
  }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function fakeSupabase(database) {
  return { from:table => new Query(database, table) };
}

(async () => {
  const { loadScanAccounts, requestedPokemonCenterOrderNumbers } = loadOrderTrackerTestHooks();
  const profiles = Array.from({ length:1205 }, (_, index) => ({
    id:`profile-${String(index).padStart(4, '0')}`,
    user_id:`user-${index}`,
    profile_name:`Profile ${index}`
  }));
  const database = {
    profiles,
    imap_scan_accounts:[],
    profile_store_credentials:[{
      profile_id:'profile-1204',
      login_email:'isabelaavalos33@gmail.com',
      gmail_app_password:'aaaa bbbb cccc dddd'
    }],
    accounts:[],
    imported_mail_accounts:[]
  };

  const globalAccounts = await loadScanAccounts(fakeSupabase(database), null);
  assert.strictEqual(globalAccounts.loaderDiagnostics.profiles_loaded, 1205, 'all profile pages must load');
  assert(globalAccounts.some(account => account.email === 'isabelaavalos33@gmail.com'), 'later-user mailbox must be selected');
  assert.strictEqual(globalAccounts[0].password, 'aaaabbbbccccdddd', 'Gmail app-password spaces must be normalized');

  const scopedAccounts = await loadScanAccounts(fakeSupabase(database), 'user-1204');
  assert.strictEqual(scopedAccounts.loaderDiagnostics.scope, 'single_user');
  assert.strictEqual(scopedAccounts.length, 1, 'normal user scan must remain owner-scoped');

  assert.deepStrictEqual(
    Array.from(requestedPokemonCenterOrderNumbers('P0037328999, p0037327064 P0037328999')),
    ['P0037328999', 'P0037327064'],
    'one-time recovery must normalize and deduplicate exact P-order numbers'
  );

  console.log('order-tracker global mailbox pagination tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
