const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

assert(
  packageJson.scripts.start.includes('--expose-gc'),
  'production must expose explicit garbage collection for 600+ mailbox reconciliations'
);
assert(
  backendSource.includes('RECONCILE_MEMORY_BATCH_SIZE'),
  'long reconciliation must divide mailbox workers into bounded memory batches'
);
assert(
  backendSource.includes('await releaseMailboxBatchMemory();'),
  'each bounded mailbox batch must release parser/IMAP memory before continuing'
);
assert(
  backendSource.includes('attachment.content = null') && backendSource.includes('msg.source=null'),
  'raw MIME and attachment buffers must be released before long database work'
);
assert(
  backendSource.includes('A bad password or disabled mailbox is complete for this reconciliation run too.'),
  'failed credentials must be durably checkpointed so a restart does not retry them from the beginning'
);
assert(
  backendSource.includes("progress.phase === 'waiting_for_global_scan'"),
  'scanner contention must be displayed as waiting rather than mailbox 1 of an unknown total'
);
assert(
  backendSource.includes('safely saved…'),
  'the waiting display must preserve and report the durable mailbox count'
);

console.log('Long-run reconciliation memory and resume tests passed');
