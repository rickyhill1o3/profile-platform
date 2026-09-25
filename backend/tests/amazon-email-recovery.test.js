const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const original = fs.readFileSync(filename, 'utf8');
  const source = original.replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { rawMessageLooksLikeAmazonConfirmation, rawMessageLooksLikeMacysConfirmation, matchPendingAmazonOrder, matchServiceOrderByMailboxTime, amazonOrdersMissingConfirmation, detectStore } };'
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
  return { hooks:module.exports.__test, source:original };
}

class Query {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.filters = [];
    this.rangeStart = 0;
    this.rangeEnd = null;
    this.descending = false;
    this.orderColumn = '';
  }
  select() { return this; }
  eq(column, value) { this.filters.push(row => String(row[column]) === String(value)); return this; }
  in(column, values) { const set = new Set(values.map(String)); this.filters.push(row => set.has(String(row[column]))); return this; }
  not(column, operator) { if (operator === 'is') this.filters.push(row => row[column] != null); return this; }
  order(column, options = {}) { this.orderColumn = column; this.descending = options.ascending === false; return this; }
  limit(count) { this.rangeEnd = this.rangeStart + Number(count) - 1; return this; }
  range(start, end) { this.rangeStart = start; this.rangeEnd = end; return this; }
  execute() {
    let rows = (this.database[this.table] || []).filter(row => this.filters.every(fn => fn(row)));
    if (this.orderColumn) rows = rows.slice().sort((a,b) => {
      const result = String(a[this.orderColumn] || '').localeCompare(String(b[this.orderColumn] || ''));
      return this.descending ? -result : result;
    });
    const end = this.rangeEnd == null ? rows.length : this.rangeEnd + 1;
    return { data:rows.slice(this.rangeStart, end), error:null };
  }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function fakeSupabase(database) {
  return { from:table => new Query(database, table) };
}

(async () => {
  const { hooks, source } = loadTestHooks();
  const {
    rawMessageLooksLikeAmazonConfirmation,
    rawMessageLooksLikeMacysConfirmation,
    matchPendingAmazonOrder,
    matchServiceOrderByMailboxTime,
    amazonOrdersMissingConfirmation,
    detectStore
  } = hooks;

  assert.strictEqual(rawMessageLooksLikeAmazonConfirmation({
    subject:'Ordered: Pokémon TCG Booster Bundle',
    from:[{ name:'Amazon.com', address:'auto-confirm@amazon.com' }]
  }, Buffer.from('Order number 111-2222222-3333333')), true);
  assert.strictEqual(rawMessageLooksLikeAmazonConfirmation({
    subject:'Package delivered', from:[{ address:'shipment-tracking@amazon.com' }]
  }, Buffer.from('Your package was delivered')), false);

  const webhookAt = Date.parse('2026-09-24T15:00:00.000Z');
  const database = {
    orders:[
      {
        id:'farther', user_id:'owner', site:'amazon', status:'pending_email_verification',
        created_at:new Date(webhookAt - 70 * 60 * 1000).toISOString(), credits_charged:0,
        raw_payload:{ account:'buyer@example.com' }, metadata:{ email_verification_required:true }
      },
      {
        id:'nearest', user_id:'owner', site:'amazon', status:'pending_email_verification',
        created_at:new Date(webhookAt - 4 * 60 * 1000).toISOString(), credits_charged:0,
        raw_payload:{ account:'buyer@example.com' }, metadata:{ email_verification_required:true }
      },
      {
        id:'wrong-mailbox', user_id:'owner', site:'amazon', status:'pending_email_verification',
        created_at:new Date(webhookAt - 60 * 1000).toISOString(), credits_charged:0,
        raw_payload:{ account:'someone-else@example.com' }, metadata:{ email_verification_required:true }
      },
      {
        id:'legacy-pending', user_id:'owner', site:'amazon', status:'pending_email_verification',
        created_at:new Date(webhookAt - 24 * 60 * 60 * 1000).toISOString(), credits_charged:0,
        raw_payload:{ account:'buyer@example.com' }, metadata:{ email_verification_required:true }
      }
    ],
    tracked_orders:[
      { id:'amazon-canceled', user_id:'owner', store:'amazon', order_number:'106-1111111-2222222', status:'canceled', order_date:'2026-09-24T15:00:00.000Z' },
      { id:'amazon-confirmed', user_id:'owner', store:'amazon', order_number:'111-2222222-3333333', status:'confirmed', order_date:'2026-09-24T15:05:00.000Z' },
      { id:'amazon-linked-pending', source_order_id:'legacy-pending', user_id:'owner', store:'amazon', order_number:'114-4444444-5555555', status:'confirmed', order_date:'2026-09-24T14:00:00.000Z' }
    ],
    tracked_order_emails:[
      { order_id:'amazon-confirmed', event_type:'confirmed' },
      { order_id:'amazon-linked-pending', event_type:'confirmed' }
    ],
    email_messages:[{ linked_order_id:'amazon-canceled', email_type:'canceled' }]
  };
  const pending = await matchPendingAmazonOrder(
    fakeSupabase(database),
    { user_id:'owner', email:'buyer@example.com' },
    { date:new Date(webhookAt), subject:'Ordered: Pokémon TCG Booster Bundle', text:'Order 111-2222222-3333333', html:'' },
    '111-2222222-3333333', { total:138.77 }, '<confirmation@example>'
  );
  assert.strictEqual(pending.serviceOrder.id, 'nearest', 'nearest unused webhook for the exact mailbox must win');

  const missing = await amazonOrdersMissingConfirmation(fakeSupabase(database), 'owner', 100);
  assert.deepStrictEqual(
    Array.from(missing, row => row.id),
    ['amazon-canceled','amazon-linked-pending'],
    'a cancellation alone or a legacy linked receipt with an unfinished source checkout must remain repairable'
  );

  assert.strictEqual(detectStore('orders@macys.com', "Thanks for your Macy's order", ''), 'macys');
  assert.strictEqual(rawMessageLooksLikeMacysConfirmation({
    subject:'Thanks for your order', from:[{ address:'orders@macys.com' }]
  }, Buffer.from('Order confirmation')), true);
  const macys = matchServiceOrderByMailboxTime([
    { id:'macys-old', site:'macys', created_at:new Date(webhookAt - 5 * 60 * 60 * 1000).toISOString(), raw_payload:{ email:'buyer@example.com' }, metadata:{} },
    { id:'macys-near', site:'macys', created_at:new Date(webhookAt - 2 * 60 * 1000).toISOString(), raw_payload:{ email:'buyer@example.com' }, metadata:{} }
  ], { email:'buyer@example.com' }, 'macys', { date:new Date(webhookAt) }, '<macys@example>', 6 * 60 * 60 * 1000);
  assert.strictEqual(macys.id, 'macys-near');

  assert(source.includes("amazonPendingMatch = { serviceOrder:direct"), 'exact Amazon confirmations must use the verified-checkout finalizer');
  assert(source.includes("method = uidSet.size ? 'amazon_webhook_time_window'"), 'historical repair must expose Amazon time-window matching');
  console.log('Amazon and Macy\'s email recovery tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
