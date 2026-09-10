const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTestHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { detectStatus, detectStore, readableEmailText, isPokemonCenterPaymentAlert, safePokemonPaymentUrl, extractPokemonPaymentActionUrl, extractPokemonPaymentActionUrlFromText, parsePokemonCenterPaymentAlert, saveParsedMessage, POKEMON_CENTER_LIVE_DISCOVERY_SUBJECTS } };'
  );
  const module = { exports:{} };
  const sandbox = {
    module, exports:module.exports, Buffer, URL, URLSearchParams, process, console,
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
  constructor(database, table) { this.database=database; this.table=table; this.operation='read'; this.row=null; }
  upsert(row) { this.operation='upsert'; this.row={...row}; return this; }
  select() { return this; }
  single() {
    if (this.operation !== 'upsert') return Promise.resolve({ data:null, error:null });
    const rows=this.database[this.table]||(this.database[this.table]=[]);
    const index=rows.findIndex(existing => existing.user_id===this.row.user_id && existing.message_id===this.row.message_id);
    const saved={...(index>=0?rows[index]:{}),...this.row,id:(index>=0?rows[index].id:`${this.table}-1`)};
    if(index>=0)rows[index]=saved;else rows.push(saved);
    return Promise.resolve({ data:saved, error:null });
  }
}

function fakeSupabase(database) { return { from:table => new Query(database, table) }; }

(async () => {
  const hooks=loadTestHooks();
  const actionUrl='https://click.em.pokemon.com/?qs=opaque-payment-token';
  const html=`<html><body>
    <p>We’re unable to authorize your credit card for your preorder from PokemonCenter.com.</p>
    <p>Hello, Ricky,</p>
    <p>We recently attempted to reauthorize your credit card in preparation for the upcoming shipment of your preorder <strong>Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box</strong>. However, we ran into an issue with your payment card and we are unable to reauthorize the charges.</p>
    <p>If you have a new card, please <a href="${actionUrl}">update your payment information</a> before <strong>September 14, 2026 by 11:59 p.m. PT</strong>.</p>
    <p>If we cannot charge your current or new payment card within this time, your preorder will be cancelled.</p>
  </body></html>`;
  const subject='ACTION REQUIRED on Your Preorder: Please update your payment information.';
  const parsed={
    subject, from:{text:'Pokémon Center <info@em.pokemon.com>'}, to:{text:'stickydeliverydc@gmail.com'},
    html, text:'', date:new Date('2026-09-09T05:31:51.000Z'), messageId:'pokemon-payment-test'
  };
  const readable=hooks.readableEmailText(parsed);
  assert.strictEqual(hooks.detectStore(parsed.from.text, subject, readable), 'pokemoncenter');
  assert.strictEqual(hooks.detectStatus(subject, readable), 'payment_needed');
  assert.strictEqual(hooks.isPokemonCenterPaymentAlert('pokemoncenter', subject, readable), true);
  assert.ok(
    hooks.POKEMON_CENTER_LIVE_DISCOVERY_SUBJECTS.includes('ACTION REQUIRED on Your Preorder'),
    'manual live reconciliation must search for orderless payment-warning subjects'
  );
  assert.strictEqual(hooks.extractPokemonPaymentActionUrl(html), actionUrl);
  assert.strictEqual(hooks.safePokemonPaymentUrl('https://evil.example/payment'), '');

  const details=hooks.parsePokemonCenterPaymentAlert(subject, readable, html);
  assert.strictEqual(details.product_hint, 'Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box');
  assert.strictEqual(details.deadline_text, 'September 14, 2026 by 11:59 p.m. PT');
  assert.strictEqual(details.action_url, actionUrl);
  const mailparserStyleText=readable.replace(
    'update your payment information before',
    `update your payment information [${actionUrl}] before`
  );
  assert.strictEqual(
    hooks.parsePokemonCenterPaymentAlert(subject, mailparserStyleText, html).deadline_text,
    'September 14, 2026 by 11:59 p.m. PT'
  );
  assert.strictEqual(hooks.extractPokemonPaymentActionUrlFromText(mailparserStyleText), actionUrl);
  assert.strictEqual(hooks.parsePokemonCenterPaymentAlert(subject, mailparserStyleText, '').action_url, actionUrl);

  const database={ email_messages:[], retailer_account_alerts:[] };
  const result=await hooks.saveParsedMessage(fakeSupabase(database), {
    user_id:'user-1', profile_id:'profile-1', email:'stickydeliverydc@gmail.com', provider:{name:'gmail'}
  }, parsed, 42);
  assert.strictEqual(result.saved, true);
  assert.strictEqual(result.status, 'payment_needed');
  assert.strictEqual(result.order_number, null, 'an orderless alert must never invent or guess an order number');
  assert.strictEqual(database.email_messages.length, 1);
  assert.strictEqual(database.email_messages[0].keep_forever, true);
  assert.strictEqual(database.retailer_account_alerts.length, 1);
  assert.strictEqual(database.retailer_account_alerts[0].mailbox_email, 'stickydeliverydc@gmail.com');
  assert.strictEqual(database.retailer_account_alerts[0].action_url, actionUrl);

  console.log('pokemon-payment-alert tests passed');
})().catch(error => { console.error(error); process.exitCode=1; });
