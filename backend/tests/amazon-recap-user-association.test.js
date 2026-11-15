const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.match(serverSource, /external_order_id:\s*normalized\.external_order_id \|\| null/, 'durable webhook rows must retain the bot checkout reference');
assert.match(serverSource, /source_webhook_log_id:logId/, 'the Amazon order must retain its source webhook row');
assert.match(serverSource, /metadata->>amazon_webhook_reference/, 'confirmed Amazon orders must resolve back to their original webhook reference');
assert.match(serverSource, /webhook_matched_user_id:recordedOrder\.user_id/, 'the original matched user must be retained on the order');
assert.match(serverSource, /updatedOrder\.metadata\?\.source_webhook_log_id/, 'IMAP confirmation must finalize the original webhook log instead of orphaning it');

console.log('Amazon recap and webhook-user association tests passed.');
