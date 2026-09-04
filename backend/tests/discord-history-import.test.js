const assert = require('assert');
const { __test } = require('../discord-history-import');

function message(id, timestamp, embed) {
  return {
    id,
    timestamp,
    channel_id:'123456789012345678',
    guild_id:'234567890123456789',
    author:{ username:'checkout bot' },
    webhook_id:'345678901234567890',
    embeds:[embed]
  };
}

const stellarPokemon = {
  title:'Successful Checkout!',
  fields:[
    { name:'Site', value:'Pokemon Center US' },
    { name:'Product', value:'Mega Evolution Booster Box' },
    { name:'Price', value:'$161.64' },
    { name:'Quantity', value:'1' },
    { name:'Profile', value:'Ricky PKC #38' },
    { name:'Account', value:'||ricky@example.com||' },
    { name:'Order ID', value:'||P0037327064||' }
  ]
};
const parsedPokemon = __test.parseCheckoutEmbed(
  message('456789012345678901', '2026-03-30T17:36:00.000Z', stellarPokemon),
  stellarPokemon,
  0,
  { id:'123456789012345678', name:'checkouts', guild_id:'234567890123456789', guild_name:'The Secret Sauce' }
);
assert.strictEqual(parsedPokemon.store, 'pokemoncenter');
assert.strictEqual(parsedPokemon.retailer_order_number, 'P0037327064');
assert.strictEqual(parsedPokemon.checkout_account_email, 'ricky@example.com');
assert.strictEqual(parsedPokemon.quantity, 1);
assert.strictEqual(parsedPokemon.purchase_price, 161.64);

const prismWalmart = {
  title:'Successful Checkout | Walmart',
  fields:[
    { name:'Product', value:'Funko POP!' },
    { name:'Price', value:'$12.98' },
    { name:'Quantity', value:'2' },
    { name:'Email', value:'owner@example.com' },
    { name:'Order Number', value:'#200014396398394' }
  ]
};
const parsedWalmart = __test.parseCheckoutEmbed(
  message('567890123456789012', '2026-04-01T12:00:00.000Z', prismWalmart),
  prismWalmart,
  0,
  { id:'123456789012345678', name:'checkouts', guild_id:'234567890123456789', guild_name:'The Secret Sauce' }
);
assert.strictEqual(parsedWalmart.store, 'walmart');
assert.strictEqual(parsedWalmart.retailer_order_number, '200014396398394');
assert.strictEqual(parsedWalmart.purchase_price, 25.96);

const boxLunch = {
  title:'Successful Checkout!',
  fields:[
    { name:'Site', value:'boxlunch' },
    { name:'Product', value:'Exclusive Loungefly Backpack' },
    { name:'SKU', value:'12345678' },
    { name:'Qty', value:'1' },
    { name:'Price', value:'$89.90' },
    { name:'Order ID', value:'DL123456789' },
    { name:'Account', value:'shopper@example.com' }
  ]
};
const parsedBoxLunch = __test.parseCheckoutEmbed(
  message('678901234567890123', '2026-02-10T18:00:00.000Z', boxLunch),
  boxLunch,
  0,
  { id:'123456789012345678', name:'stellar-checkouts', guild_id:'234567890123456789', guild_name:'SUCCESS' }
);
assert.strictEqual(parsedBoxLunch.store, 'boxlunch');
assert.strictEqual(parsedBoxLunch.retailer_order_number, 'DL123456789');

const supremeNoOrder = {
  title:'Successful Checkout!',
  fields:[
    { name:'Site', value:'us.supreme.com' },
    { name:'Product - Name', value:'Supreme Tee' },
    { name:'Product - Price', value:'$44.00' },
    { name:'Profile', value:'Supreme Profile 1' },
    { name:'Account', value:'supreme@example.com' }
  ]
};
const parsedSupreme = __test.parseCheckoutEmbed(
  message('789012345678901234', '2026-03-01T18:00:00.000Z', supremeNoOrder),
  supremeNoOrder,
  0,
  { id:'123456789012345678', name:'checkouts', guild_id:'234567890123456789', guild_name:'The Secret Sauce' }
);
assert.strictEqual(parsedSupreme.store, 'supreme');
assert.strictEqual(parsedSupreme.has_retailer_order_number, false);
assert.strictEqual(parsedSupreme.order_number, 'DISCORD-789012345678901234-1');

assert.throws(
  () => __test.safeCutoff('2026-04-18T18:07:01.000Z'),
  /cannot be later/i
);
assert.strictEqual(__test.safeCutoff('2026-04-18T18:07:00.000Z'), '2026-04-18T18:07:00.000Z');
assert.strictEqual(__test.timestampSnowflake('2026-04-18T18:07:00.000Z'), ((BigInt(Date.parse('2026-04-18T18:07:00.000Z')) - 1420070400000n) << 22n).toString());

const insert = __test.orderInsertRow('super-admin-user', parsedPokemon);
assert.strictEqual(insert.user_id, 'super-admin-user');
assert.strictEqual(insert.credits_charged, 0);
assert.strictEqual(insert.source, 'discord_history');
assert.strictEqual(insert.created_at, '2026-03-30T17:36:00.000Z');
assert.strictEqual(insert.metadata.checkout_account_email, 'ricky@example.com');

console.log('Discord historical checkout parser and cutoff tests passed.');
