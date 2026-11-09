const assert = require('assert');
const fs = require('fs');
const path = require('path');

const historyModule = require('../discord-history-import');
const history = historyModule.__test;
const recovery = require('../discord-checkout-recovery').__test;

const embed = {
  title:'Successful Checkout',
  fields:[
    { name:'Site', value:'amazon' },
    { name:'Mode', value:'fast' },
    { name:'Product', value:'B0H784PD4X' },
    { name:'SKU', value:'B0H784PD4X' },
    { name:'Qty', value:'3' },
    { name:'Price', value:'$179.99' },
    { name:'Email', value:'||buyer@example.com||' },
    { name:'Purchase ID', value:'||purchase-123456||' }
  ],
  footer:{ text:'Stellar AIO - 9.073 - 10:19:58 AM' }
};
const parsed = history.parseCheckoutEmbed({
  id:'1456789012345678901',
  timestamp:'2026-11-09T15:19:58.934Z',
  channel_id:'123456789012345678',
  guild_id:'234567890123456789',
  author:{ username:'Spidey Bot' },
  webhook_id:'345678901234567890'
}, embed, 0, {
  id:'123456789012345678',
  name:'superadmincheckouts',
  guild_id:'234567890123456789',
  guild_name:'The Secret Sauce'
}, { allowedStores:new Set(['amazon']) });

assert.strictEqual(parsed.store, 'amazon');
assert.strictEqual(parsed.checkout_account_email, 'buyer@example.com');
assert.strictEqual(parsed.retailer_order_number, 'purchase-123456');
assert.strictEqual(parsed.sku, 'B0H784PD4X');
assert.strictEqual(parsed.quantity, 3);
assert.strictEqual(parsed.purchase_price, 539.97);
assert.strictEqual(parsed.checkout_at, '2026-11-09T15:19:58.934Z');

const historicalDefault = history.parseCheckoutEmbed({
  id:'1456789012345678901', timestamp:'2026-03-09T15:19:58.934Z',
  channel_id:'123456789012345678', guild_id:'234567890123456789'
}, embed, 0, { id:'123456789012345678' });
assert.strictEqual(historicalDefault.skip_reason, 'unsupported_store', 'Amazon must not leak into the cutoff-only historical importer');

const range = recovery.safeRange('2026-11-09T14:00:00.000Z', '2026-11-09T16:00:00.000Z');
assert.strictEqual(range.start_at, '2026-11-09T14:00:00.000Z');
assert.strictEqual(range.end_at, '2026-11-09T16:00:00.000Z');
assert.throws(() => recovery.safeRange('2026-11-09T16:00:00.000Z', '2026-11-09T14:00:00.000Z'), /before the end/i);
assert.throws(() => recovery.safeRange('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), /14 days/i);

const priorHistoryToken = process.env.DISCORD_HISTORY_BOT_TOKEN;
process.env.DISCORD_HISTORY_BOT_TOKEN = 'existing-history-checker-token';
const sharedBot = historyModule.getHistoryCheckerBotConfig();
assert.strictEqual(sharedBot.token, 'existing-history-checker-token');
assert.strictEqual(sharedBot.token_source, 'DISCORD_HISTORY_BOT_TOKEN');
assert.strictEqual(sharedBot.bot_label, 'history checker');
if (priorHistoryToken == null) delete process.env.DISCORD_HISTORY_BOT_TOKEN;
else process.env.DISCORD_HISTORY_BOT_TOKEN = priorHistoryToken;

const backend = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const tracker = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const recoveryModule = fs.readFileSync(path.join(__dirname, '..', 'discord-checkout-recovery.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.html'), 'utf8');

assert(backend.includes("source:'discord_checkout_recovery'"), 'recovered checkouts must have an auditable service-order source');
assert(backend.includes("recovery_bot:'history checker'"), 'recovery audit metadata must identify the existing history checker bot');
assert(recoveryModule.includes('getHistoryCheckerBotConfig'), 'Amazon recovery must reuse the existing history checker configuration');
assert(!recoveryModule.includes('process.env.DISCORD_HISTORY_BOT_TOKEN'), 'the recovery module must not create a second independent bot configuration');
assert(backend.includes('recordSuccessfulCheckout(recoveryPayload, { createdAt:checkoutAt.toISOString() })'), 'the original Discord checkout time must be preserved');
assert(backend.includes("routingMode: 'public_and_admin_only'"), 'only the verified email finalizer may publish a recovered Amazon success');
assert(backend.includes('const verifiedCreditRule = await resolveVerifiedAmazonCreditCharge(serviceOrder);'), 'verified recovery must re-read the exact website catalog credit rule');
assert(tracker.includes('replaySinceAt'), 'recovery must bypass advanced IMAP UID checkpoints with a bounded date replay');
assert(tracker.includes('onlyMailboxEmails'), 'recovery must scan only the checkout account mailbox');
assert(backend.includes('followUpDelaysMs:[150000, 600000, 1200000, 1800000]'), 'late Amazon confirmations must be retried through 30 minutes');
assert(recoveryModule.includes(".contains('metadata', { discord_recovery:true })"), 'the automatic safety net must not scan the entire orders table every minute');
assert(frontend.includes('/orders/discord-checkout-recovery/preview'), 'the super-admin preview action must be wired');
assert(frontend.includes('/orders/discord-checkout-recovery/import'), 'the approved recovery action must be wired');
assert(html.includes('Credits and public pings stay blocked until a distinct Amazon confirmation email is found.'), 'the UI must explain safe confirmation behavior');
assert(html.includes('No new bot required:'), 'the UI must clearly say the existing history checker bot is reused');
assert(!html.includes('id="discordRecoveryInvite"'), 'Amazon recovery must not ask the owner to install another bot');

console.log('Existing history-checker Amazon checkout recovery tests passed.');

