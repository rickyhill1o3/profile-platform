const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { detectStatus, extractOrderNumbers, extractAmounts, targetOrdersMissingConfirmation, rawMessageContainsOrderNumber, resolveExactProfileMailbox, resolveHistoricalDiscordMailboxIdentity } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module, exports:module.exports, Buffer, URLSearchParams, process, console,
    fetch:async () => { throw new Error('Unexpected network request'); },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(id) {
      if (id === 'imapflow') return { ImapFlow:class {} };
      if (id === 'mailparser') return { simpleParser:async () => ({}) };
      if (id === 'cheerio') return { load:() => { throw new Error('Unexpected HTML parse'); } };
      if (id === './encryption') return { encrypt:value => value, decrypt:value => value };
      if (id === './discord-history-import') return { registerDiscordHistoryImport:() => {} };
      if (id === './retailer-reconciliation') return {
        parseRetailEmail:() => ({}), expectedWebhookItems:() => [], matchScore:() => 0,
        mainItemMatch:() => false, deriveOverallStatus:() => 'unknown',
        parseSupremeWebhookCheckoutAt:() => null, norm:value => String(value || '')
      };
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
  in(column, values) { const set = new Set(values.map(String)); this.filters.push(row => set.has(String(row[column]))); return this; }
  not(column, operator) { if (operator === 'is') this.filters.push(row => row[column] != null); return this; }
  order() { return this; }
  limit(count) { this.rangeEnd = this.rangeStart + Number(count) - 1; return this; }
  range(start, end) { this.rangeStart = start; this.rangeEnd = end; return this; }
  execute() {
    const rows = (this.database[this.table] || []).filter(row => this.filters.every(fn => fn(row)));
    const end = this.rangeEnd == null ? rows.length : this.rangeEnd + 1;
    return { data:rows.slice(this.rangeStart, end), error:null };
  }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function fakeSupabase(database) {
  return { from:table => new Query(database, table) };
}

(async () => {
  const { detectStatus, extractOrderNumbers, extractAmounts, targetOrdersMissingConfirmation, rawMessageContainsOrderNumber, resolveExactProfileMailbox, resolveHistoricalDiscordMailboxIdentity } = loadTestHooks();

  assert.strictEqual(detectStatus("Thanks for shopping with us! Here's your order #102003237489716.", ''), 'confirmed');
  assert.strictEqual(detectStatus('Get ready for something special! An item from order #102003237489716 is about to ship.', ''), 'shipped');
  assert.strictEqual(detectStatus('Your order arrives today! Order #102003237489716', ''), 'shipped');
  assert.strictEqual(detectStatus('An item has arrived from order #102003237489716!', ''), 'delivered');
  assert.strictEqual(detectStatus("You've successfully canceled items from your order ending in 0776.", ''), 'canceled');

  assert.deepStrictEqual(
    Array.from(extractOrderNumbers('target', 'Your order arrives today! Order #102003237489716', '')),
    ['102003237489716']
  );
  assert.strictEqual(extractAmounts('Order total $24.53').total, 24.53);
  assert.strictEqual(extractAmounts('Total $53.35').total, 53.35);
  assert.strictEqual(rawMessageContainsOrderNumber(
    '102003259010776',
    { subject:"Thanks for shopping with us! Here's your order #:102003259010776." },
    Buffer.from('unrelated body')
  ), true);
  assert.strictEqual(rawMessageContainsOrderNumber(
    '102003259010776',
    { subject:'Target order update' },
    Buffer.from('Content-Type: text/html\r\n\r\nOrder #102003259010776')
  ), true);
  assert.strictEqual(rawMessageContainsOrderNumber(
    '102003259010776',
    { subject:"You've successfully canceled items from your order ending in 0776." },
    Buffer.from('Your cancellation is complete.')
  ), false);

  const discordSource = {
    user_id:'admin', source:'discord_history', site:'target',
    metadata:{
      discord_history_import:true,
      profile_name:'Ricky Chase',
      checkout_account_email:'rickyhill1o5@hotmail.com'
    }
  };
  const identityIndex = {
    profiles:[
      { id:'bina-profile', user_id:'admin', profile_name:'Ricky Chase', account_type:'target' },
      { id:'ricky-profile', user_id:'admin', profile_name:'Ricky Current', account_type:'target' }
    ],
    credentials:new Map([
      ['bina-profile', [{ email:'bina.enid0794@hotmail.com', store:'target' }]],
      ['ricky-profile', [{ email:'rickyhill1o5@hotmail.com', store:'target' }]]
    ])
  };
  assert.strictEqual(resolveExactProfileMailbox(discordSource, identityIndex).email, 'bina.enid0794@hotmail.com');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(resolveHistoricalDiscordMailboxIdentity(discordSource, identityIndex))),
    {
      email:'rickyhill1o5@hotmail.com', profile_id:'ricky-profile',
      profile_name:'Ricky Current', evidence:'discord_checkout_account'
    }
  );

  const database = {
    tracked_orders:[
      { id:'missing-old', user_id:'admin', store:'target', order_number:'102003237489716', status:'waiting_confirmation', total:0, order_date:'2026-01-30T00:00:00Z' },
      { id:'already-confirmed', user_id:'admin', store:'target', order_number:'102003259010776', status:'delivered', total:53.35, order_date:'2026-02-20T00:00:00Z' },
      { id:'other-user', user_id:'other', store:'target', order_number:'102003250324566', status:'waiting_confirmation', total:0, order_date:'2026-02-03T00:00:00Z' }
    ],
    tracked_order_emails:[{ order_id:'already-confirmed', event_type:'confirmed' }]
  };
  const missing = await targetOrdersMissingConfirmation(fakeSupabase(database), 'admin', 100);
  assert.deepStrictEqual(Array.from(missing, row => row.id), ['missing-old']);

  console.log('Target historical email repair tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
