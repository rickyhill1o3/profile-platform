const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const original = fs.readFileSync(filename, 'utf8');
  const source = original.replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { detectStore, detectStatus, extractOrderNumbers, normalizeStoreKey, archiveRetailerReplayClassification } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module, exports:module.exports, Buffer, URL, URLSearchParams, process, console,
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
  return { hooks:module.exports.__test, source:original };
}

const { hooks, source } = loadTestHooks();
const { detectStore, detectStatus, extractOrderNumbers, normalizeStoreKey, archiveRetailerReplayClassification } = hooks;

const exportedExamples = [
  ['"Macy\'s" <CustomerService@oes.macys.com>', 'Thank you for your order! # 4722071907', 'macys', 'confirmed', '4722071907'],
  ['"Costco Orders" <Costco@orders.costco.com>', 'Your Costco.com order 1303088558 is confirmed!', 'costco', 'confirmed', '1303088558'],
  ['"Costco Orders" <Costco@orders.costco.com>', 'Your Costco.com order 1303088558 has shipped!', 'costco', 'shipped', '1303088558'],
  ['"Barnes & Noble" <noreply@orderstatus.barnesandnoble.com>', 'Barnes & Noble Order Confirmation #4174077771', 'barnesnoble', 'confirmed', '4174077771'],
  ['"The Home Depot" <HomeDepot@order.homedepot.com>', 'Order #WK15587470 Received: Thank you for shopping with us!', 'homedepot', 'confirmed', 'WK15587470'],
  ['"The Home Depot" <HomeDepot@order.homedepot.com>', 'Order #WK15587470 Delivered: Let us know how we did!', 'homedepot', 'delivered', 'WK15587470'],
  ['"BoxLunch Order Status" <noreply@s.boxlunch.com>', 'Your BoxLunch order has been canceled.', 'boxlunch', 'canceled', 'DL4192415283'],
  ['"Temu" <orders@transaction.temu.com>', 'Order shipped and UPS tracking number is ready (Order ID: #PO-211-12622430710391149)', 'temu', 'shipped', 'PO-211-12622430710391149'],
  ['"The United States Mint" <orders@email.usmint.gov>', 'Your Order USM21730628 Was Delivered', 'usmint', 'delivered', 'USM21730628']
];

for (const [from, subject, store, status, orderNumber] of exportedExamples) {
  const body = store === 'boxlunch' ? `Order Number: ${orderNumber}` : '';
  assert.strictEqual(detectStore(from, subject, body), store, `${store} sender must be recognized`);
  assert.strictEqual(detectStatus(subject, body), status, `${store} lifecycle status must be recognized`);
  assert.strictEqual(Array.from(extractOrderNumbers(store, subject, body))[0], orderNumber, `${store} order number must be extracted`);
}

assert.strictEqual(detectStore('BestBuy@orders.bestbuy.com', 'Thanks for your Best Buy order BBY01-1234567890', ''), 'bestbuy');
assert.strictEqual(detectStore('noreply@s.hottopic.com', 'Thanks for your order!', ''), 'hottopic');
assert.strictEqual(detectStore('orders@e.fivebelow.com', 'Your Five Below order has shipped', ''), 'fivebelow');
assert.strictEqual(detectStore('orders@gamestop.com', 'Your GameStop order has shipped', ''), 'gamestop');
assert.strictEqual(detectStatus('Knock, Knock: Your Order Is Here!', ''), 'delivered');
assert.strictEqual(detectStatus('Tomorrow Is the Day!', ''), 'shipped');
assert.strictEqual(detectStatus('Your order is ready for pickup', ''), 'processing');
assert.strictEqual(detectStatus('Subscription cancelled. Other options are suggested for you.', ''), 'unknown', 'an Amazon subscription cancellation is not an order cancellation');
assert.strictEqual(normalizeStoreKey('Best Buy'), 'bestbuy');
assert.strictEqual(normalizeStoreKey('Barnes & Noble'), 'barnesnoble');
assert.strictEqual(normalizeStoreKey('The Home Depot'), 'homedepot');

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(archiveRetailerReplayClassification({
    store:'unknown', from_text:'"Macy\'s" <CustomerService@oes.macys.com>',
    subject:'Thank you for your order! # 4722071907', snippet:'We will let you know when your items ship.'
  }))),
  { store:'macys', status:'confirmed' }
);
assert.strictEqual(archiveRetailerReplayClassification({
  store:'unknown', from_text:'"Best Buy" <BestBuy@policyemail.bestbuy.com>',
  subject:'Shop deals worth celebrating during our sale', snippet:'Save on TVs today.'
}), null, 'retailer marketing mail must not enter lifecycle replay');

assert(source.includes('fetchGeneralRetailerArchiveCandidates'), 'reconcile must scan the complete saved-email metadata index');
assert(source.includes('archivedRetailerPaymentAlertOwner(email, archiveOwnerMap)'), 'archive replay must resolve the mailbox website owner before linking orders');
console.log('archive-derived retailer classification tests passed');
