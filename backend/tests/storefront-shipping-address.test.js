const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  extractStripeShippingContact,
  extractStoredShippingContact,
  hasAddress,
  shippingAddressLines
} = require('../storefront-shipping-address');

const explicitShipping = extractStripeShippingContact({
  customer_details: {
    name: 'Billing Name',
    phone: '555-0100',
    address: { line1: '1 Billing Road', city: 'Billing City', state: 'NC', postal_code: '27000', country: 'US' }
  },
  shipping_details: {
    name: 'Shipping Name',
    address: { line1: '22 Ship Lane', line2: 'Unit 4', city: 'Ship City', state: 'VA', postal_code: '22000', country: 'us' }
  }
});
assert.equal(explicitShipping.name, 'Shipping Name', 'the shipping contact must win over the billing contact');
assert.equal(explicitShipping.phone, '555-0100', 'customer phone should fill a missing shipping phone');
assert.equal(explicitShipping.address.line1, '22 Ship Lane');
assert.equal(explicitShipping.address.country, 'US');
assert.equal(hasAddress(explicitShipping.address), true);

const currentStripeShape = extractStripeShippingContact({
  collected_information: {
    shipping_details: {
      name: 'Current Shape',
      phone: '555-0199',
      address: { line1: '75 Current Street', city: 'Raleigh', state: 'NC', postal_code: '27601', country: 'US' }
    }
  }
});
assert.equal(currentStripeShape.name, 'Current Shape');
assert.equal(currentStripeShape.address.postal_code, '27601');

const historical = extractStoredShippingContact({
  shipping_name: 'Saved Name',
  shipping_address: { line1: '4 Saved Court', city: 'Aydlett', state: 'NC', postal_code: '27916', country: 'US' }
});
assert.equal(historical.name, 'Saved Name');
assert.deepEqual(shippingAddressLines(historical), [
  'Saved Name', '4 Saved Court', 'Aydlett, NC 27916', 'US'
]);

const rawHistorical = extractStoredShippingContact({
  raw_session: {
    shipping_details: {
      name: 'Raw Stripe Name',
      address: { line1: '8 Stripe Way', city: 'Norfolk', state: 'VA', postal_code: '23501', country: 'US' }
    }
  }
});
assert.equal(rawHistorical.address.line1, '8 Stripe Way', 'already-paid orders must be recoverable from the saved Stripe session');

const root = path.join(__dirname, '..', '..');
const shopRoutes = fs.readFileSync(path.join(root, 'backend', 'shop-routes.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'frontend', 'admin-store.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'frontend', 'admin-store.html'), 'utf8');

assert.match(shopRoutes, /shipping_address:\s*shippingContact\.address/);
assert.match(shopRoutes, /has_shipping_address:\s*hasAddress/);
assert.match(shopRoutes, /\/admin\/store\/orders\/:sessionId\/refresh-shipping/);
assert.match(adminHtml, /<th>Ship to<\/th>/);
assert.match(adminHtml, /id="storeReceiptShippingAddress"/);
assert.match(adminJs, /data-copy-shipping/);
assert.match(adminJs, /refreshActiveOrderShipping/);

console.log('storefront-shipping-address tests passed');
