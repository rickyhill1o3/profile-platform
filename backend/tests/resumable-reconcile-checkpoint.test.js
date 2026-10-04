const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadHooks() {
  const filename = path.join(__dirname, '..', 'order-tracker.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /module\.exports = \{ registerOrderTracker, scanAll, notifyCheckoutForOrderTracker \};\s*$/,
    'module.exports = { __test: { mailboxCheckpointKey, serializableRetailerReconcileJob, retailerReconcileJobView, loadDurableRetailerReconcileJob, persistRetailerReconcileJob, durableRetailerJobCanResume } };'
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
  return module.exports.__test;
}

class AppSettingsQuery {
  constructor(rows) { this.rows=rows; this.key=''; this.payload=null; }
  select() { return this; }
  eq(column, value) { if (column === 'key') this.key=String(value); return this; }
  maybeSingle() {
    const row=this.rows.find(item => String(item.key) === this.key) || null;
    return Promise.resolve({ data:row ? JSON.parse(JSON.stringify(row)) : null, error:null });
  }
  upsert(payload) { this.payload=JSON.parse(JSON.stringify(payload)); return this; }
  then(resolve, reject) {
    if (this.payload) {
      const index=this.rows.findIndex(item => String(item.key) === String(this.payload.key));
      if (index >= 0) this.rows[index]=this.payload; else this.rows.push(this.payload);
    }
    return Promise.resolve({ data:this.payload, error:null }).then(resolve, reject);
  }
}

(async () => {
  const hooks=loadHooks();
  const rows=[];
  const supabase={ from(table) { assert.strictEqual(table, 'app_settings'); return new AppSettingsQuery(rows); } };
  const now=new Date().toISOString();
  const job={
    id:'job-1', status:'running', stage:'all_email_scan', percent:22,
    message:'mailbox 120 of 660', started_at:now, heartbeat_at:now,
    stage_errors:[], resumed_from_checkpoint:true,
    scan_checkpoint:{
      completed_count:120, total_accounts:660, updated_at:now, scan_complete:false,
      results_by_key:{ 'user-1:a@example.com':{ email:'a@example.com', checked:3, archived:3 } }
    },
    result:{ should_not_be_saved_while_running:true }
  };

  await hooks.persistRetailerReconcileJob(supabase, 'super-admin', job);
  const loaded=await hooks.loadDurableRetailerReconcileJob(supabase, 'super-admin');
  assert.strictEqual(loaded.id, 'job-1');
  assert.strictEqual(loaded.scan_checkpoint.completed_count, 120);
  assert.strictEqual(loaded.result, null, 'large final diagnostics must not be stored before completion');
  assert.strictEqual(hooks.durableRetailerJobCanResume(loaded), true);
  assert.strictEqual(hooks.retailerReconcileJobView(loaded).resumed_mailboxes, 120);

  const stableA=hooks.mailboxCheckpointKey({ user_id:'user-1', archive_user_id:'importer-a', email:'A@Example.com' });
  const stableB=hooks.mailboxCheckpointKey({ user_id:'user-1', archive_user_id:'importer-b', email:'a@example.com' });
  assert.strictEqual(stableA, stableB, 'changing importer representation must not reset a mailbox cursor');

  const stale={ ...loaded, heartbeat_at:new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() };
  assert.strictEqual(hooks.durableRetailerJobCanResume(stale), false, 'an old abandoned run must not hide newly arrived mail forever');

  console.log('Resumable retailer reconciliation checkpoint tests passed');
})().catch(error => { console.error(error); process.exitCode=1; });
