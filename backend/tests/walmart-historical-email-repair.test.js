const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { detectStatus, extractOrderNumbers, extractAmounts, walmartOrderNumberVariants, orderNumberSearchVariants, rawMessageContainsOrderNumber, walmartOrdersNeedingRepair } };'
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
  }
  select() { return this; }
  eq(column, value) { this.filters.push(row => String(row[column]) === String(value)); return this; }
  not(column, operator) { if (operator === 'is') this.filters.push(row => row[column] != null); return this; }
  order() { return this; }
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
  const {
    detectStatus, extractOrderNumbers, extractAmounts, walmartOrderNumberVariants,
    orderNumberSearchVariants, rawMessageContainsOrderNumber, walmartOrdersNeedingRepair
  } = loadTestHooks();

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
      { id:'target', user_id:'admin', store:'target', order_number:'102003259010776', status:'waiting_confirmation', total:0 }
    ]
  };
  const problemRows = await walmartOrdersNeedingRepair(fakeSupabase(database), 'admin', 250);
  assert.deepStrictEqual(Array.from(problemRows, row => row.id), ['missing', 'linked-zero']);

  console.log('Walmart historical email repair tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
