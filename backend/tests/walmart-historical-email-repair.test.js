const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { htmlToReadableEmailText, detectStatus, extractOrderNumbers, extractAmounts, walmartOrderNumberVariants, orderNumberSearchVariants, rawMessageContainsOrderNumber, walmartArchiveRowMatchesTrackedOrder, fetchWalmartArchiveCandidatesForOrders, historicalRepairMailboxNames, walmartOrdersNeedingRepair, findWalmartServiceOrderViaExactTracker } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module, exports:module.exports, Buffer, URLSearchParams, process, console,
    fetch:async () => { throw new Error('Unexpected network request'); },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(id) {
      if (id === 'imapflow') return { ImapFlow:class {} };
      if (id === 'mailparser') return { simpleParser:async () => ({}) };
      if (id === 'cheerio') return require(id);
      if (id === './encryption') return { encrypt:value => value, decrypt:value => value };
      if (id === './discord-history-import') return { registerDiscordHistoryImport:() => {} };
      if (id === './retailer-reconciliation') return {
        parseRetailEmail:() => ({}), expectedWebhookItems:() => [], matchScore:() => 0,
        mainItemMatch:() => false, targetSingleLineDeliveryAlias:() => null,
        deriveOverallStatus:() => 'unknown', parseSupremeWebhookCheckoutAt:() => null,
        norm:value => String(value || '')
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
    this.limitCount = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push(row => String(row[column]) === String(value)); return this; }
  in(column, values) { const wanted = new Set((values || []).map(String)); this.filters.push(row => wanted.has(String(row[column]))); return this; }
  gte(column, value) { this.filters.push(row => String(row[column] || '') >= String(value)); return this; }
  not(column, operator) { if (operator === 'is') this.filters.push(row => row[column] != null); return this; }
  order() { return this; }
  limit(value) { this.limitCount = Number(value); return this; }
  range(start, end) { this.rangeStart = start; this.rangeEnd = end; return this; }
  execute() {
    const rows = (this.database[this.table] || []).filter(row => this.filters.every(fn => fn(row)));
    const end = this.rangeEnd == null ? (this.limitCount == null ? rows.length : this.rangeStart + this.limitCount) : this.rangeEnd + 1;
    return { data:rows.slice(this.rangeStart, end), error:null };
  }
  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({ data:result.data[0] || null, error:result.data.length > 1 ? new Error('Multiple rows') : null });
  }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}

function fakeSupabase(database) {
  return { from:table => new Query(database, table) };
}

(async () => {
  const {
    htmlToReadableEmailText, detectStatus, extractOrderNumbers, extractAmounts, walmartOrderNumberVariants,
    orderNumberSearchVariants, rawMessageContainsOrderNumber, walmartArchiveRowMatchesTrackedOrder,
    fetchWalmartArchiveCandidatesForOrders, historicalRepairMailboxNames, walmartOrdersNeedingRepair,
    findWalmartServiceOrderViaExactTracker
  } = loadTestHooks();

  // Walmart's current HTML-only lifecycle emails put font-size:0 on layout wrappers and restore
  // the visible font size on descendants. The wrapper must survive text conversion.
  const htmlOnlyWalmartText = htmlToReadableEmailText(`
    <table><tr><td style="direction:ltr;font-size:0px;text-align:center">
      <div style="font-size:14px">Order number: #2000148-13548797</div>
      <div style="font-size:16px">Order total</div>
      <div style="font-size:16px">Includes all fees, taxes and discounts</div>
      <div style="font-size:16px">$159.96</div>
    </td></tr></table>
  `);
  assert.match(htmlOnlyWalmartText, /2000148-13548797/);
  assert.match(htmlOnlyWalmartText, /\$159\.96/);

  assert.strictEqual(detectStatus('Thanks for your delivery order, Ricky Hill', ''), 'confirmed');
  assert.strictEqual(detectStatus('Shipped: Pokemon Trading Card G... and 4 other items', ''), 'shipped');
  assert.strictEqual(detectStatus('Arrived: Your Pokemon Trading Card G... +4 items', ''), 'delivered');
  assert.strictEqual(detectStatus('Walmart order update', 'Your package arrived'), 'delivered');
  assert.strictEqual(
    detectStatus('Canceled: delivery from order #200014389978678', 'We had to cancel your delivery order.'),
    'canceled'
  );

  assert.deepStrictEqual(
    Array.from(extractOrderNumbers('walmart', 'Walmart order update', 'Order number: 2000149-70438121')),
    ['2000149-70438121']
  );
  assert.deepStrictEqual(
    Array.from(extractOrderNumbers('walmart', 'Canceled: delivery from order #200014389978678', '')),
    ['200014389978678']
  );
  assert.deepStrictEqual(
    Array.from(extractOrderNumbers(
      'walmart',
      'Thanks for your delivery order, ricky',
      'Order date: Thu, Mar 26, 2026\nOrder number:\n#2000148-13548797\nOrder total\nIncludes all fees, taxes and discounts\n$159.96'
    )),
    ['2000148-13548797']
  );

  assert.strictEqual(extractAmounts(`
    Order total
    Includes all fees, taxes and discounts        $320.25
    Payment method
  `).total, 320.25);
  assert.strictEqual(extractAmounts(`Order total\nIncludes all fees, taxes and discounts\n$266.23`).total, 266.23);

  assert.deepStrictEqual(
    Array.from(walmartOrderNumberVariants('200014970438121')),
    ['200014970438121', '2000149-70438121']
  );
  assert.ok(Array.from(orderNumberSearchVariants('walmart', '2000149-70438121')).includes('200014970438121'));
  assert.strictEqual(rawMessageContainsOrderNumber(
    '200014970438121',
    { subject:'Thanks for your delivery order, Ricky Hill' },
    Buffer.from('Order number: 2000149-70438121'),
    'walmart'
  ), true);
  assert.strictEqual(rawMessageContainsOrderNumber(
    '200014970438121',
    { subject:'Walmart order update' },
    Buffer.from('Order number: 2000149=2D70438121'),
    'walmart'
  ), true);
  assert.strictEqual(rawMessageContainsOrderNumber(
    '200014970438121',
    { subject:'Walmart order update' },
    Buffer.from('Order number: 2000149-70438122'),
    'walmart'
  ), false);

  assert.strictEqual(walmartArchiveRowMatchesTrackedOrder({
    mailbox_email:'rickyhill@hotmail.com', subject:'Thanks for your delivery order, Ricky',
    body_text:'Order number: 2000145-47816339', order_number:null
  }, {
    store:'walmart', source_email:'rickyhill@hotmail.com', order_number:'200014547816339'
  }), true);
  assert.strictEqual(walmartArchiveRowMatchesTrackedOrder({
    mailbox_email:'someoneelse@hotmail.com', body_text:'Order number: 2000145-47816339'
  }, {
    store:'walmart', source_email:'rickyhill@hotmail.com', order_number:'200014547816339'
  }), false);

  const outlookFolders = historicalRepairMailboxNames(
    { provider:{ name:'outlook' } },
    [
      { path:'INBOX', flags:new Set() },
      { path:'Archive', specialUse:'\\Archive', flags:new Set() },
      { path:'2026 purchases', flags:new Set() },
      { path:'Drafts', specialUse:'\\Drafts', flags:new Set() },
      { path:'Parent', flags:new Set(['\\Noselect']) }
    ]
  );
  assert.deepStrictEqual(Array.from(outlookFolders), ['INBOX','Archive','2026 purchases']);
  assert.deepStrictEqual(Array.from(historicalRepairMailboxNames(
    { provider:{ name:'gmail' } },
    [{ path:'[Gmail]/All Mail', specialUse:'\\All', flags:new Set() }, { path:'INBOX', flags:new Set() }]
  )), ['[Gmail]/All Mail']);

  // Every Walmart row supplied in the historical-missing report is the same 15-digit shape and
  // must produce the exact 7+8 Walmart display form used inside the live retailer emails.
  const reportedMissing = [
    '200014643524411','200014349234907','200014184259592','200014547816339',
    '200014396398394','200014813548797','200014433543454','200014803865941',
    '200014616154088','200014388850436','200014439625487','200014651552757',
    '200014590537416','200014621805533','200014447797985','200014547816220',
    '200014486385007','200014456777421','200014450240873','200014417554437',
    '200014424554933','200014511851041','200014459929214','200014608103145',
    '200014597424028','200014505089638','200014581144402','200014459928707',
    '200014156165583','200014492855904','200014676889453','200014616939781',
    '200014335132913','200014474699340'
  ];
  assert.strictEqual(new Set(reportedMissing).size, 34);
  for (const orderNumber of reportedMissing) {
    const variants = Array.from(walmartOrderNumberVariants(orderNumber));
    assert.ok(variants.includes(`${orderNumber.slice(0, 7)}-${orderNumber.slice(7)}`), orderNumber);
  }

  const database = {
    tracked_orders:[
      { id:'missing', user_id:'admin', store:'walmart', order_number:'200014643524411', status:'waiting_confirmation', total:0 },
      { id:'linked-zero', user_id:'admin', store:'walmart', order_number:'2000149-70438121', status:'shipped', total:0 },
      { id:'healthy', user_id:'admin', store:'walmart', order_number:'2000148-76543210', status:'delivered', total:75.25 },
      { id:'canceled-zero', user_id:'admin', store:'walmart', order_number:'2000143-89978678', status:'canceled', total:0 },
      { id:'other-user', user_id:'other', store:'walmart', order_number:'2000147-57957926', status:'confirmed', total:0 },
      { id:'target', user_id:'admin', store:'target', order_number:'102003259010776', status:'waiting_confirmation', total:0 },
      {
        id:'kix-walmart', user_id:'admin', store:'walmart', order_number:'200014813548797',
        source_email:'kixnotherthings@gmail.com', source_order_id:'discord-kix', status:'waiting_confirmation', total:0
      }
    ],
    orders:[]
  };
  const problemRows = await walmartOrdersNeedingRepair(fakeSupabase(database), 'admin', 250);
  assert.deepStrictEqual(Array.from(problemRows, row => row.id), ['missing', 'linked-zero', 'kix-walmart']);

  const bridgedServiceOrder = {
    id:'discord-kix', user_id:'admin', source:'discord_history', site:'walmart',
    // Regression: the imported source payload does not contain the retailer reference, while the
    // exact tracker row above still does.
    external_order_id:'DISCORD-legacy-kix', metadata:{ checkout_account_email:'kixnotherthings@gmail.com' }
  };
  assert.strictEqual(
    await findWalmartServiceOrderViaExactTracker(
      fakeSupabase(database),
      { user_id:'admin', email:'kixnotherthings@gmail.com' },
      ['2000148-13548797'],
      [bridgedServiceOrder]
    ),
    bridgedServiceOrder
  );
  assert.strictEqual(
    await findWalmartServiceOrderViaExactTracker(
      fakeSupabase(database),
      { user_id:'admin', email:'someoneelse@gmail.com' },
      ['2000148-13548797'],
      [bridgedServiceOrder]
    ),
    null
  );
  database.orders.push(bridgedServiceOrder);
  assert.strictEqual(
    await findWalmartServiceOrderViaExactTracker(
      fakeSupabase(database),
      { user_id:'admin', email:'kixnotherthings@gmail.com' },
      ['200014813548797'],
      []
    ),
    bridgedServiceOrder
  );

  database.email_messages = [
    {
      id:'archived-before-import', user_id:'admin', mailbox_email:'rickyhill@hotmail.com',
      store:'walmart', email_type:'confirmed', order_number:null,
      subject:'Thanks for your delivery order, Ricky', from_text:'Walmart <help@walmart.com>',
      received_at:'2026-03-27T00:01:00.000Z', body_text:'Order number: 2000145-47816339',
      body_html:'', snippet:'', message_id:'walmart-1'
    },
    {
      id:'wrong-order', user_id:'admin', mailbox_email:'rickyhill@hotmail.com',
      store:'walmart', email_type:'confirmed', order_number:null,
      subject:'Thanks for your delivery order, Ricky', from_text:'Walmart <help@walmart.com>',
      received_at:'2026-03-27T00:02:00.000Z', body_text:'Order number: 2000145-47816340',
      body_html:'', snippet:'', message_id:'walmart-2'
    }
  ];
  const archiveDiscovery = await fetchWalmartArchiveCandidatesForOrders(fakeSupabase(database), 'admin', [{
    id:'missing', user_id:'admin', store:'walmart', order_number:'200014547816339',
    source_email:'rickyhill@hotmail.com', order_date:'2026-03-26T23:40:54.000Z'
  }], '*', 50);
  assert.deepStrictEqual(Array.from(archiveDiscovery.rows, row => row.id), ['archived-before-import']);

  console.log('Walmart historical email repair tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
