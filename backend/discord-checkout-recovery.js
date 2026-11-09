const crypto = require('crypto');
const { __test: discordHistoryHelpers, getHistoryCheckerBotConfig, discordGet } = require('./discord-history-import');
const RECOVERY_STORES = new Set(['amazon']);
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const CONFIG_KEY = 'discord_checkout_recovery';
const recoveryJobs = new Map();

function clean(value, max = 4000) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function normalizeOrderRef(value) {
  return clean(value, 200).replace(/^#+/, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function safeRange(startValue, endValue) {
  const now = Date.now();
  const end = new Date(endValue || new Date(now + 60 * 1000).toISOString());
  const start = new Date(startValue || new Date(now - 24 * 60 * 60 * 1000).toISOString());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error('Choose a valid recovery start and end time.');
  if (start.getTime() >= end.getTime()) throw new Error('The recovery start time must be before the end time.');
  if (end.getTime() > now + 10 * 60 * 1000) throw new Error('The recovery end time cannot be more than 10 minutes in the future.');
  if (end.getTime() - start.getTime() > MAX_RANGE_MS) throw new Error('Recover at most 14 days at a time.');
  return { start_at:start.toISOString(), end_at:end.toISOString() };
}

async function loadChannelRange(token, channelId, startAt, endAt, progress = null) {
  const channel = await discordGet(token, `/channels/${encodeURIComponent(channelId)}`);
  const guild = channel.guild_id ? await discordGet(token, `/guilds/${encodeURIComponent(channel.guild_id)}`).catch(() => null) : null;
  const channelInfo = {
    id:String(channel.id || channelId),
    name:channel.name || channelId,
    guild_id:channel.guild_id || null,
    guild_name:guild?.name || null
  };
  const maxMessages = Math.max(100, Math.min(25000, Number(process.env.DISCORD_CHECKOUT_RECOVERY_MAX_MESSAGES_PER_CHANNEL || 5000)));
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  let before = discordHistoryHelpers.timestampSnowflake(endAt);
  let scanned = 0;
  let reachedStart = false;
  let emptyWebhookEmbeds = 0;
  const entries = [];
  const skipped = { not_successful_checkout:0, unsupported_store:0, invalid_timestamp:0 };

  while (scanned < maxMessages && !reachedStart) {
    const page = await discordGet(token, `/channels/${encodeURIComponent(channelId)}/messages?limit=100&before=${encodeURIComponent(before)}`);
    if (!Array.isArray(page) || !page.length) break;
    scanned += page.length;
    if (progress) {
      progress.messages_scanned = Number(progress.messages_scanned || 0) + page.length;
      progress.current_channel = `${channelInfo.guild_name || 'Discord'} / #${channelInfo.name}`;
      progress.progress_message = `Scanned ${progress.messages_scanned.toLocaleString()} recent Discord message(s); found ${Number(progress.matches_found || 0).toLocaleString()} Amazon checkout(s).`;
    }

    for (const message of page) {
      const messageMs = new Date(message.timestamp || 0).getTime();
      if (!Number.isFinite(messageMs)) continue;
      if (messageMs < startMs) { reachedStart = true; continue; }
      if (messageMs >= endMs) continue;
      const embeds = Array.isArray(message.embeds) ? message.embeds : [];
      if (!embeds.length && message.webhook_id && !clean(message.content)) emptyWebhookEmbeds++;
      embeds.forEach((embed, index) => {
        const parsed = discordHistoryHelpers.parseCheckoutEmbed(message, embed, index, channelInfo, { allowedStores:RECOVERY_STORES });
        if (parsed.skip_reason) skipped[parsed.skip_reason] = (skipped[parsed.skip_reason] || 0) + 1;
        else {
          entries.push(parsed);
          if (progress) progress.matches_found = Number(progress.matches_found || 0) + 1;
        }
      });
    }
    before = String(page[page.length - 1]?.id || '');
    if (!before || page.length < 100) break;
  }

  return {
    channel:channelInfo,
    messages_scanned:scanned,
    checkout_matches:entries.length,
    entries,
    skipped,
    empty_webhook_embeds:emptyWebhookEmbeds,
    truncated:scanned >= maxMessages && !reachedStart
  };
}

async function existingRecoveryKeys(supabase, entries = []) {
  const sourceKeys = new Set();
  let offset = 0;
  while (true) {
    const page = await supabase.from('orders').select('id,external_order_id,metadata,raw_payload')
      .contains('metadata', { discord_recovery:true })
      .order('created_at', { ascending:true }).range(offset, offset + 999);
    if (page.error) throw page.error;
    for (const row of page.data || []) {
      if (row.metadata?.discord_recovery_source_key) sourceKeys.add(String(row.metadata.discord_recovery_source_key));
      if (row.raw_payload?.discord_recovery_source_key) sourceKeys.add(String(row.raw_payload.discord_recovery_source_key));
    }
    if ((page.data || []).length < 1000) break;
    offset += 1000;
  }

  const externalIds = new Set();
  const wanted = [...new Set(entries.map(entry => clean(entry.order_number, 200)).filter(Boolean))];
  for (let i = 0; i < wanted.length; i += 100) {
    const variants = [...new Set(wanted.slice(i, i + 100).flatMap(value => [value, `#${value.replace(/^#+/, '')}`]))];
    const result = await supabase.from('orders').select('external_order_id').in('external_order_id', variants);
    if (result.error) throw result.error;
    for (const row of result.data || []) externalIds.add(normalizeOrderRef(row.external_order_id));
  }
  return { sourceKeys, externalIds };
}

function publicEntry(entry = {}) {
  return {
    source_key:entry.source_key,
    checkout_at:entry.checkout_at,
    guild_name:entry.guild_name,
    channel_name:entry.channel_name,
    store:entry.store,
    order_number:entry.order_number,
    retailer_order_number:entry.retailer_order_number,
    checkout_account_email:entry.checkout_account_email,
    profile_name:entry.profile_name,
    product_name:entry.product_name,
    sku:entry.sku,
    quantity:entry.quantity,
    purchase_price:entry.purchase_price,
    action:entry.action,
    duplicate_reason:entry.duplicate_reason || null,
    message_url:entry.message_url
  };
}

function jobView(job) {
  if (!job) return { status:'idle' };
  return {
    id:job.id,
    status:job.status,
    phase:job.phase,
    started_at:job.started_at,
    finished_at:job.finished_at || null,
    expires_at:job.expires_at,
    messages_scanned:Number(job.messages_scanned || 0),
    matches_found:Number(job.matches_found || 0),
    current_channel:job.current_channel || null,
    progress_message:job.progress_message || null,
    error:job.error || null,
    result:job.result ? { ...job.result, entries:(job.result.entries || []).slice(0, 250).map(publicEntry) } : null,
    import_result:job.import_result || null
  };
}

async function loadConfig(supabase) {
  const result = await supabase.from('app_settings').select('value_json').eq('key', CONFIG_KEY).maybeSingle();
  if (result.error) throw result.error;
  return result.data?.value_json || {};
}

async function saveConfig(supabase, value) {
  const result = await supabase.from('app_settings').upsert({
    key:CONFIG_KEY,
    value_json:value,
    updated_at:new Date().toISOString()
  }, { onConflict:'key' });
  if (result.error) throw result.error;
  return value;
}

async function preparePreview(supabase, token, channelIds, range, job) {
  const reports = [];
  const entries = [];
  for (const channelId of channelIds) {
    const report = await loadChannelRange(token, channelId, range.start_at, range.end_at, job);
    reports.push({
      channel:report.channel,
      messages_scanned:report.messages_scanned,
      checkout_matches:report.checkout_matches,
      skipped:report.skipped,
      empty_webhook_embeds:report.empty_webhook_embeds,
      truncated:report.truncated
    });
    entries.push(...report.entries);
  }

  job.phase = 'checking_duplicates';
  job.progress_message = 'Checking Discord message IDs and checkout references for duplicates…';
  const existing = await existingRecoveryKeys(supabase, entries);
  let importable = 0;
  let duplicates = 0;
  let unsafe = 0;
  for (const entry of entries) {
    if (existing.sourceKeys.has(entry.source_key)) {
      entry.action = 'skip_existing';
      entry.duplicate_reason = 'same Discord message already recovered';
      duplicates++;
    } else if (existing.externalIds.has(normalizeOrderRef(entry.order_number))) {
      entry.action = 'skip_existing';
      entry.duplicate_reason = 'checkout reference already exists';
      duplicates++;
    } else if (!entry.checkout_account_email) {
      entry.action = 'skip_unsafe';
      entry.duplicate_reason = 'missing Amazon account email; user ownership cannot be verified';
      unsafe++;
    } else {
      entry.action = 'recover';
      importable++;
    }
  }
  return {
    start_at:range.start_at,
    end_at:range.end_at,
    channels:reports,
    messages_scanned:Number(job.messages_scanned || 0),
    supported_checkouts:entries.length,
    importable,
    duplicates,
    unsafe,
    missing_account_email:entries.filter(entry => !entry.checkout_account_email).length,
    truncated:reports.some(report => report.truncated),
    message_content_warning:reports.some(report => report.empty_webhook_embeds > 0 && report.checkout_matches === 0),
    entries
  };
}

async function recoverEntries(supabase, entries, recoverDiscordCheckout) {
  const existing = await existingRecoveryKeys(supabase, entries);
  const fresh = entries.filter(entry =>
    entry.checkout_account_email &&
    !existing.sourceKeys.has(entry.source_key) &&
    !existing.externalIds.has(normalizeOrderRef(entry.order_number))
  );
  const results = [];
  const failures = [];
  for (const entry of fresh) {
    try {
      results.push(await recoverDiscordCheckout(entry));
    } catch (error) {
      failures.push({ source_key:entry.source_key, checkout_at:entry.checkout_at, error:clean(error.message || error, 700) });
    }
  }
  return {
    recovered_orders:results.filter(result => !result?.duplicate).length,
    duplicates_skipped:(entries.length - fresh.length) + results.filter(result => result?.duplicate).length,
    failed_orders:failures.length,
    failures:failures.slice(0, 100),
    mailbox_scans_queued:results.filter(result => result?.mailbox_scan_queued).length,
    affected_users:[...new Set(results.map(result => result?.user_id).filter(Boolean))].length,
    waiting_for_email_verification:true
  };
}

function registerDiscordCheckoutRecovery({ app, supabase, auth, recoverDiscordCheckout }) {
  const { token, token_source:tokenSource, bot_label:botLabel } = getHistoryCheckerBotConfig();

  app.get('/orders/discord-checkout-recovery/config', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    try {
      const saved = await loadConfig(supabase);
      return res.json({
        configured:Boolean(token),
        token_configured:Boolean(token),
        token_source:tokenSource,
        existing_bot:true,
        bot_label:botLabel,
        required_permissions:['View Channel','Read Message History'],
        message_content_intent_required:true,
        saved_channels:discordHistoryHelpers.channelIdsFromInput(saved.channels || []),
        auto_enabled:saved.auto_enabled === true,
        last_auto_run:saved.last_auto_run || null
      });
    } catch (error) {
      return res.status(500).json({ error:error.message || String(error) });
    }
  });

  app.post('/orders/discord-checkout-recovery/config', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const channels = discordHistoryHelpers.channelIdsFromInput(req.body?.channels);
    if (!channels.length) return res.status(400).json({ error:'Enter at least one private checkout channel ID.' });
    if (channels.length > 10) return res.status(400).json({ error:'Save at most 10 private checkout channels.' });
    try {
      const prior = await loadConfig(supabase);
      const saved = await saveConfig(supabase, { ...prior, channels, auto_enabled:req.body?.auto_enabled === true });
      return res.json({ success:true, saved_channels:channels, auto_enabled:saved.auto_enabled });
    } catch (error) {
      return res.status(500).json({ error:error.message || String(error) });
    }
  });

  app.post('/orders/discord-checkout-recovery/preview', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    if (!token) return res.status(503).json({ error:'The existing history checker bot token is not configured. Restore DISCORD_HISTORY_BOT_TOKEN in Render.' });
    if (typeof recoverDiscordCheckout !== 'function') return res.status(503).json({ error:'Checkout recovery is not available on this server build.' });
    const channelIds = discordHistoryHelpers.channelIdsFromInput(req.body?.channels);
    if (!channelIds.length) return res.status(400).json({ error:'Enter at least one private checkout channel ID.' });
    if (channelIds.length > 10) return res.status(400).json({ error:'Preview at most 10 private checkout channels.' });
    let range;
    try { range = safeRange(req.body?.start_at, req.body?.end_at); }
    catch (error) { return res.status(400).json({ error:error.message }); }

    const id = crypto.randomUUID();
    const now = Date.now();
    const job = {
      id,
      user_id:String(req.user_id),
      status:'running',
      phase:'reading_discord',
      started_at:new Date(now).toISOString(),
      expires_at:new Date(now + PREVIEW_TTL_MS).toISOString(),
      finished_at:null,
      channel_ids:channelIds,
      messages_scanned:0,
      matches_found:0,
      current_channel:null,
      progress_message:'The existing history checker bot is reading the private checkout channel…',
      result:null,
      import_result:null,
      entries:[],
      error:null
    };
    recoveryJobs.set(id, job);
    try {
      const prior = await loadConfig(supabase);
      await saveConfig(supabase, { ...prior, channels:channelIds });
    } catch (_) {}
    res.status(202).json({ success:true, job:jobView(job) });

    setImmediate(async () => {
      try {
        const result = await preparePreview(supabase, token, channelIds, range, job);
        job.entries = result.entries;
        job.result = result;
        job.status = 'preview_ready';
        job.phase = 'awaiting_approval';
        job.finished_at = new Date().toISOString();
        job.progress_message = `Preview ready: ${result.importable} missed checkout(s) can be recovered; ${result.duplicates} duplicate(s) will be skipped.`;
      } catch (error) {
        job.status = 'error';
        job.phase = 'preview_failed';
        job.finished_at = new Date().toISOString();
        if (Number(error.status) === 403) job.error = `${error.message}. Give the existing history checker bot View Channel and Read Message History in this channel.`;
        else if (Number(error.status) === 404) job.error = `${error.message}. Check the channel ID and make sure the existing history checker bot can view that server.`;
        else job.error = clean(error.message || error, 1000);
      }
    });
  });

  app.get('/orders/discord-checkout-recovery/status', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const job = recoveryJobs.get(clean(req.query?.job_id, 100));
    if (!job || String(job.user_id) !== String(req.user_id)) return res.json({ job:{ status:'idle' } });
    return res.json({ job:jobView(job) });
  });

  app.post('/orders/discord-checkout-recovery/import', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const job = recoveryJobs.get(clean(req.body?.job_id, 100));
    if (!job || String(job.user_id) !== String(req.user_id)) return res.status(404).json({ error:'That preview expired or the server restarted. Run Preview again.' });
    if (new Date(job.expires_at).getTime() < Date.now()) return res.status(410).json({ error:'That preview expired. Run Preview again.' });
    if (job.status !== 'preview_ready') return res.status(409).json({ error:'Wait for the preview to finish before recovering.' });
    job.status = 'running';
    job.phase = 'recovering';
    job.finished_at = null;
    job.progress_message = 'Creating pending Amazon checkouts and queueing exact mailbox checks…';
    res.status(202).json({ success:true, job:jobView(job) });

    setImmediate(async () => {
      try {
        const candidates = job.entries.filter(entry => entry.action === 'recover');
        job.import_result = await recoverEntries(supabase, candidates, recoverDiscordCheckout);
        job.status = 'complete';
        job.phase = 'complete';
        job.finished_at = new Date().toISOString();
        job.progress_message = `Recovered ${job.import_result.recovered_orders} pending checkout(s). IMAP checks are running; only confirmed orders will post publicly and charge credits.`;
      } catch (error) {
        job.status = 'error';
        job.phase = 'recovery_failed';
        job.finished_at = new Date().toISOString();
        job.error = clean(error.message || error, 1000);
      }
    });
  });

  let autoRunning = false;
  const autoRecover = async () => {
    if (autoRunning || !token || typeof recoverDiscordCheckout !== 'function') return;
    autoRunning = true;
    try {
      const config = await loadConfig(supabase);
      const channels = discordHistoryHelpers.channelIdsFromInput(config.channels || []);
      if (config.auto_enabled !== true || !channels.length) return;
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const startAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const entries = [];
      for (const channelId of channels) {
        const report = await loadChannelRange(token, channelId, startAt, endAt, null);
        entries.push(...report.entries);
      }
      const result = await recoverEntries(supabase, entries, recoverDiscordCheckout);
      await saveConfig(supabase, {
        ...config,
        last_auto_run:{ at:new Date().toISOString(), status:'complete', scanned_checkouts:entries.length, ...result }
      });
    } catch (error) {
      try {
        const config = await loadConfig(supabase);
        await saveConfig(supabase, { ...config, last_auto_run:{ at:new Date().toISOString(), status:'error', error:clean(error.message || error, 700) } });
      } catch (_) {}
      console.error('[HISTORY CHECKER AMAZON RECOVERY] Automatic safety-net scan failed:', error.message || error);
    } finally {
      autoRunning = false;
    }
  };

  if (token && typeof recoverDiscordCheckout === 'function') {
    setTimeout(() => autoRecover().catch(() => {}), 45000).unref?.();
    setInterval(() => autoRecover().catch(() => {}), Math.max(60000, Number(process.env.DISCORD_CHECKOUT_RECOVERY_INTERVAL_MS || 60000))).unref?.();
    setInterval(() => {
      const now = Date.now();
      for (const [id, job] of recoveryJobs.entries()) {
        if (new Date(job.expires_at).getTime() + PREVIEW_TTL_MS < now) recoveryJobs.delete(id);
      }
    }, 15 * 60 * 1000).unref?.();
  }
}

module.exports = {
  registerDiscordCheckoutRecovery,
  __test:{ safeRange, publicEntry, normalizeOrderRef, loadChannelRange, existingRecoveryKeys }
};

