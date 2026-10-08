const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backendPath = path.join(__dirname, '..', 'order-tracker.js');
const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js');
const backendSource = fs.readFileSync(backendPath, 'utf8');
const frontendSource = fs.readFileSync(frontendPath, 'utf8');

function loadParser() {
  const source = backendSource.replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { parsePokemonCenterReceiptPdfText, pokemonCenterManualReceiptHtml } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module, exports:module.exports, Buffer, URL, URLSearchParams, process, console,
    fetch:async () => { throw new Error('Unexpected network request'); },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(id) {
      if (id === 'imapflow') return { ImapFlow:class {} };
      if (id === 'mailparser') return { simpleParser:async () => ({}) };
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
  vm.runInNewContext(source, sandbox, { filename:backendPath });
  return module.exports.__test;
}

const hooks = loadParser();
const receiptText = `
Order Details | Pokémon Center Official Site
Order Details
Order #: P0041820553
Date: September 30, 2026 at 1:26 PM EDT
Status: Received

Pokémon TCG: Mega Evolution-Delta Reign
Booster Bundle (6 Packs)
SKU: 10-10439-109
Qty
1
Price
$26.94
Subtotal
$26.94
Subtotal
Shipping
Tax
Total
$26.94
$0.00
$1.82
$28.76
Billing Information
Payment Method
Amount: $28.76
`;

const receipt = hooks.parsePokemonCenterReceiptPdfText(receiptText);
assert.strictEqual(receipt.order_number, 'P0041820553');
assert.strictEqual(receipt.retailer_status, 'Received');
assert.strictEqual(receipt.items.length, 1);
assert.strictEqual(receipt.items[0].product_name, 'Pokémon TCG: Mega Evolution-Delta Reign Booster Bundle (6 Packs)');
assert.strictEqual(receipt.items[0].sku, '10-10439-109');
assert.strictEqual(receipt.items[0].quantity, 1);
assert.strictEqual(receipt.items[0].price, 26.94);
assert.strictEqual(receipt.subtotal, 26.94);
assert.strictEqual(receipt.shipping, 0);
assert.strictEqual(receipt.tax, 1.82);
assert.strictEqual(receipt.total, 28.76);
assert.match(hooks.pokemonCenterManualReceiptHtml(receipt, 'order.pdf'), /\$28\.76/);

const routeStart = backendSource.indexOf("app.post('/orders/tracked/:id/upload-confirmation-pdf'");
const routeEnd = backendSource.indexOf("app.post('/orders/tracked/:id/find-emails'", routeStart);
assert(routeStart >= 0 && routeEnd > routeStart, 'manual PDF upload route must exist');
const route = backendSource.slice(routeStart, routeEnd);
assert(route.includes("req.role !== 'super_admin'"), 'manual receipt upload must be super-admin-only');
assert(route.includes("code:'order_number_mismatch'"), 'route must reject a PDF for another order');
assert(route.includes('replacePokemonCenterItemsFromManualReceipt'), 'route must replace tracker items with receipt items');
assert(route.includes("status:'confirmed'"), 'route must create a confirmed receipt event');
assert(route.includes('manual_confirmation_pdf_sha256'), 'source-order metadata must retain a receipt fingerprint');
assert(frontendSource.includes('Upload order receipt PDF'), 'missing Pokemon Center confirmations need a PDF upload button');
assert(frontendSource.includes('upload-confirmation-pdf'), 'frontend must send the selected PDF to the manual confirmation route');
assert(frontendSource.includes("error.details?.code==='order_number_mismatch'"), 'frontend must explain order-number mismatches');

assert.throws(
  () => hooks.parsePokemonCenterReceiptPdfText(receiptText.replace('P0041820553', 'not-an-order')),
  /P-order number could not be read/
);
assert.throws(
  () => hooks.parsePokemonCenterReceiptPdfText(receiptText.replace('Status: Received', 'Status: Canceled')),
  /cannot be used as a confirmation receipt/
);

console.log('Pokemon Center manual receipt PDF tests passed');
