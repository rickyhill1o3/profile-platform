const assert = require('assert');
const {
  parseRetailEmail,
  targetSingleLineDeliveryAlias,
  deriveOverallStatus
} = require('../retailer-reconciliation');

const order716Delivery = `
Order #102003237489716
Ricky, an item from your order has arrived
Item delivered
Delivered to: Ricky Hill, 194 Tabernacle Lane, Aydlett, NC, 27916
Pokemon A0000 Trading Cards
Qty: 1
Delivered on Thu, Feb 5, 2026
Rate & review
`;
const parsed716 = parseRetailEmail(
  'target', 'delivered',
  'An item has arrived from order #102003237489716!',
  order716Delivery
);
assert.strictEqual(parsed716.order_number, '102003237489716');
assert.deepStrictEqual(
  parsed716.items.map(item => ({ name:item.product_name, quantity:item.quantity, status:item.status })),
  [{ name:'Pokemon A0000 Trading Cards', quantity:1, status:'delivered' }]
);

const main716 = {
  id:'main-716', role:'main', status:'shipped', quantity:1, price:11,
  product_name:'Pokémon Trading Card Game : Pokémon Day 2026 Collection'
};
let alias = targetSingleLineDeliveryAlias(
  [{ product_name:main716.product_name, quantity:1 }],
  parsed716.items,
  [main716]
);
assert.strictEqual(alias.main.id, 'main-716');
assert.strictEqual(deriveOverallStatus([{ ...main716, status:'delivered' }]), 'delivered');

// Replaying an email processed by an older build is also safe: the only extra row must be the
// price-less delivered alias created from that same shortened Target title.
alias = targetSingleLineDeliveryAlias(
  [{ product_name:main716.product_name, quantity:1 }],
  parsed716.items,
  [main716, {
    id:'alias-716', role:'filler', status:'delivered', quantity:1, price:null,
    product_name:'Pokemon A0000 Trading Cards'
  }]
);
assert.strictEqual(alias.main.id, 'main-716');
assert.strictEqual(alias.alias_rows.length, 1);

// A separately purchased filler with a price must remain independent.
assert.strictEqual(targetSingleLineDeliveryAlias(
  [{ product_name:main716.product_name, quantity:1 }],
  parsed716.items,
  [main716, {
    id:'paid-filler', role:'filler', status:'delivered', quantity:1, price:3.99,
    product_name:'Pokemon A0000 Trading Cards'
  }]
), null);

// The title-alias shortcut is deliberately limited to an unambiguous one-line order.
assert.strictEqual(targetSingleLineDeliveryAlias(
  [
    { product_name:main716.product_name, quantity:1 },
    { product_name:'A separately purchased item', quantity:1 }
  ],
  parsed716.items,
  [main716]
), null);

const order092Delivery = `
Order #102003236984092
Ricky, items from your order have arrived
Items delivered
Delivered to: Ricky Hill II, 6007 Caratoke Hwy, Poplar Branch, NC, 27965
Pokémon Clctbl TC Charmander
Qty: 2
Delivered on Fri, Feb 6, 2026
Rate & review
`;
const parsed092 = parseRetailEmail(
  'target', 'delivered',
  'Items have arrived from order #102003236984092!',
  order092Delivery
);
assert.strictEqual(parsed092.order_number, '102003236984092');
assert.deepStrictEqual(
  parsed092.items.map(item => ({ name:item.product_name, quantity:item.quantity, status:item.status })),
  [{ name:'Pokémon Clctbl TC Charmander', quantity:2, status:'delivered' }]
);
assert.ok(targetSingleLineDeliveryAlias(
  [{ product_name:'Pokémon Mega Evolution S2.5 Ascended Heroes Tech Sticker - Charmander', quantity:2 }],
  parsed092.items,
  [{
    id:'main-092', role:'main', status:'confirmed', quantity:2, price:18.99,
    product_name:'Pokémon Mega Evolution S2.5 Ascended Heroes Tech Sticker - Charmander'
  }]
));

console.log('Target delivered-title alias reconciliation tests passed');
