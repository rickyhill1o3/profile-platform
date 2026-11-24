const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseAstralCheckout, loadAstralCheckoutActivity, removeDuplicateAstralActivity } = require('../astral-checkout-activity');
const { __test:{ recoverEntries } } = require('../discord-checkout-recovery');

// These tests exercise data and routes, not GIF rendering or Discord connections.
const originalLoad = Module._load;
let buildReleaseRecapSummary, registerSuccessNetwork;
try {
  Module._load = function (id, parent, main) {
    if (['sharp','jsonwebtoken','discord.js'].includes(id)) return {};
    return originalLoad.call(this, id, parent, main);
  };
  ({ buildReleaseRecapSummary } = require('../release-success-recap'));
  registerSuccessNetwork = require('../success-network');
} finally {
  Module._load = originalLoad;
}

const message = { id:'1574831855612723342', timestamp:'2026-11-24T16:59:33.000Z', author:{ username:'Astral Cloud', bot:true } };
const channel = { name:'superadmincheckouts' };
const embedFor = group => ({ title:'Successful Checkout', description:'NeeDoh Teenie Cool Cat 3PK',
  fields:[{ name:'Total', value:'$49.95' }, { name:'Price', value:'$9.99' }, { name:'Quantity', value:'5' },
    { name:'Account', value:'ki\\*\\*\\*@gm\\*\\*\\*.com' }, { name:'Product group', value:group },
    { name:'ASIN', value:'`B0C6WZTWZ6`' }, { name:'Links', value:'[View on Amazon](https://www.amazon.com/dp/B0C6WZTWZ6)' }]
});
const first = parseAstralCheckout(message, embedFor('Ricky'), 0, channel);
const second = parseAstralCheckout({ ...message, id:'1574831855612723343' }, embedFor('johnathan'), 0, channel);
assert.equal(first.activity_only, true);
assert.equal(first.sku, 'B0C6WZTWZ6');
assert.equal(first.quantity, 5);
assert.equal(first.checkout_at, message.timestamp);
assert.notEqual(first.activity_id, second.activity_id, 'distinct posts for the same product must still count');
assert.equal(parseAstralCheckout(message, embedFor('guest'), 0, channel).skip_reason, 'unrecognized_astral_group');
assert.equal(parseAstralCheckout({ ...message, author:{ ...message.author, bot:false } }, embedFor('ricky'), 0, channel), undefined);
assert.equal(parseAstralCheckout(message, { ...embedFor('ricky'), title:'Checkout Failed' }, 0, channel).skip_reason, 'not_successful_checkout');
const stellar = require('../discord-history-import').__test.parseCheckoutEmbed(message, { ...embedFor('ricky'), url:'https://www.amazon.com/dp/B0C6WZTWZ6' }, 0, channel, { allowedStores:new Set(['amazon']) });
assert.equal(stellar.checkout_account_email, null, 'masked addresses outside the Astral path are not usable');

const settings = new Map();
const supabase = { from(table) {
  if (table === 'webhook_events') return { select:() => ({ order:() => ({ limit:async () => ({ data:[] }) }) }) };
  if (['catalog_products', 'storefront_products'].includes(table)) return { select:() => ({ in:async () => ({ data:[] }) }) };
  assert.equal(table, 'app_settings', 'Astral-only recovery must not touch orders or credits');
  return {
    upsert(rows, options) {
      assert.deepEqual(options, { onConflict:'key', ignoreDuplicates:true });
      const inserted = [];
      for (const row of rows) if (!settings.has(row.key)) {
        settings.set(row.key, row);
        inserted.push({ key:row.key });
      }
      return { select:async () => ({ data:inserted }) };
    },
    select() {
      let matches = [...settings.values()];
      const query = {
        like(_column, pattern) { matches = matches.filter(row => row.key.startsWith(pattern.slice(0,-1))); return query; },
        gte(_column, value) { matches = matches.filter(row => row.key >= value); return query; },
        lt(_column, value) { matches = matches.filter(row => row.key < value); return query; },
        order() { return query; },
        async range(start, end) { return { data:matches.slice(start,end+1) }; },
        eq() { return { maybeSingle:async () => ({ data:null }) }; }
      };
      return query;
    }
  };
} };

async function run() {
  const shouldNotRecover = async () => assert.fail('Astral reports must not invoke user/order recovery');
  assert.equal((await recoverEntries(supabase, [first, second], shouldNotRecover)).astral_activity_added, 2);
  const retried = await recoverEntries(supabase, [first, second], shouldNotRecover);
  assert.equal(retried.astral_activity_added, 0);
  assert.equal(retried.duplicates_skipped, 2);
  assert.equal(retried.recovered_orders, 0);
  assert.equal(retried.mailbox_scans_queued, 0);
  assert.doesNotMatch(JSON.stringify([...settings.entries()]), /ricky|johnathan|@|157483185|amazon\.com|\$9\.99/i);
  assert.equal((await loadAstralCheckoutActivity(supabase, { to:'2026-11-24T16:59:32.999Z' })).length, 0);
  const rows = await loadAstralCheckoutActivity(supabase, { from:message.timestamp, to:message.timestamp });
  assert.equal(rows.length, 2);
  const summary = buildReleaseRecapSummary({ events:rows, catalogRows:[{ site:'amazon', sku:first.sku, default_max_price:20 }] });
  assert.equal(summary.checkout_count, 2);
  assert.equal(summary.item_count, 10);
  assert.equal(summary.bot_reported_checkout_count, 2);
  assert.equal(summary.total_spend, 0);
  assert.equal(summary.retailer_confirmed_checkout_count, 0);

  const ref = '111-2222222-3333333';
  const confirmed = { id:'existing', site:'amazon', status:'processed', type:'checkout', payload:{ embeds:[{ fields:[{ name:'Purchase ID', value:`||${ref}||` }] }] } };
  assert.deepEqual(removeDuplicateAstralActivity([{ ...rows[0], external_order_id:ref }, rows[1], confirmed]), [rows[1], confirmed]);
  assert.deepEqual(removeDuplicateAstralActivity([rows[0], rows[0], rows[1]]), rows);

  // Exercise the actual public feed route with the same stored activity.
  const routes = new Map();
  const app = { get:(path,...handlers) => routes.set(path,handlers.at(-1)), post(){}, delete(){}, patch(){} };
  const envToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  try { registerSuccessNetwork({ app, supabase }); }
  finally { if (envToken !== undefined) process.env.DISCORD_BOT_TOKEN = envToken; }
  let feed;
  await routes.get('/public/checkout-success-feed')({}, { set(){}, json(value){ feed=value; } });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].checkout_count, 2);
  assert.equal(feed[0].sku, first.sku);
  assert.doesNotMatch(JSON.stringify(feed), /ricky|johnathan|@|external_order_id|157483185/i);
  console.log('Astral checkout activity tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
