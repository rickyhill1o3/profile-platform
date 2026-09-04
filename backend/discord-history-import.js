const crypto = require('crypto');

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const LATEST_ALLOWED_CUTOFF = '2026-04-18T18:07:00.000Z'; // 4/18/2026 2:07 PM America/New_York
const ALLOWED_STORES = new Set([
  'pokemoncenter', 'supreme', 'target', 'walmart',
  'shopifyhazbinhotel', 'shopifytaylorswift', 'boxlunch'
]);
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewJobs = new Map();

function clean(value, max = 4000) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/^\|\||\|\|$/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim()
    .slice(0, max);
}

function lower(value) { return clean(value).toLowerCase(); }
function normalizedFieldName(value) { return lower(value).replace(/[^a-z0-9]+/g, ' ').trim(); }
function normalizeOrderRef(value) { return clean(value, 200).replace(/^#+/, '').replace(/[^a-z0-9]/gi, '').toUpperCase(); }

function money(value) {
  const match = clean(value, 300).replace(/,/g, '').match(/-?\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function positiveWholeNumber(value, fallback = 1) {
  const match = clean(value, 200).match(/\d+/);
  const parsed = match ? Number(match[0]) : Number(fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.round(parsed)) : 1;
}

function normalizeStore(value) {
  const compact = lower(value).replace(/[^a-z0-9]/g, '');
  if (!compact) return '';
  if (compact.includes('pokemoncenter') || compact === 'pokemon' || compact === 'pokemoncenterus') return 'pokemoncenter';
  if (compact.includes('supreme')) return 'supreme';
  if (compact.includes('target')) return 'target';
  if (compact.includes('walmart')) return 'walmart';
  if (compact.includes('boxlunch')) return 'boxlunch';
  if (compact.includes('hazbinhotel')) return 'shopifyhazbinhotel';
  if (compact.includes('taylorswift')) return 'shopifytaylorswift';
  return '';
}

function fieldList(embed = {}) {
  return (Array.isArray(embed.fields) ? embed.fields : []).map((field) => ({
    name: clean(field?.name, 300),
    normalized: normalizedFieldName(field?.name),
    value: clean(field?.value, 4000)
  }));
}

function firstField(fields, patterns) {
  const row = fields.find(field => patterns.some(pattern => pattern.test(field.normalized)));
  return row?.value || '';
}

function parseEmbedItems(embed = {}) {
  const fields = fieldList(embed);
  const indexed = new Map();
  const get = index => {
    const key = Math.max(1, Number(index || 1));
    if (!indexed.has(key)) indexed.set(key, {});
    return indexed.get(key);
  };

  for (const field of fields) {
    const name = field.normalized;
    let match = name.match(/^product\s+(\d+)\s+(name|price|quantity|qty|sku|size)$/);
    if (!match) match = name.match(/^(product|price|quantity|qty|sku|size)\s+(\d+)$/);
    if (match) {
      const index = /^product\s+\d+/.test(name) ? Number(match[1]) : Number(match[2]);
      const kind = /^product\s+\d+/.test(name) ? match[2] : match[1];
      const row = get(index);
      if (kind === 'product' || kind === 'name') row.product_name = field.value;
      else if (kind === 'price') row.price = money(field.value);
      else if (kind === 'quantity' || kind === 'qty') row.quantity = positiveWholeNumber(field.value);
      else row[kind] = field.value;
      continue;
    }

    match = name.match(/^product\s*(\d*)\s*(name|price|quantity|qty|sku|size)$/);
    if (match) {
      const row = get(Number(match[1] || 1));
      const kind = match[2];
      if (kind === 'name') row.product_name = field.value;
      else if (kind === 'price') row.price = money(field.value);
      else if (kind === 'quantity' || kind === 'qty') row.quantity = positiveWholeNumber(field.value);
      else row[kind] = field.value;
      continue;
    }

    if (/^product$/.test(name)) get(1).product_name = field.value;
    else if (/^(price|product price|total price)$/.test(name)) get(1).price = money(field.value);
    else if (/^(quantity|qty|total quantity)$/.test(name)) get(1).quantity = positiveWholeNumber(field.value);
    else if (/^sku$/.test(name)) get(1).sku = field.value;
    else if (/^size$/.test(name)) get(1).size = field.value;
  }

  const rows = [...indexed.entries()].sort((a, b) => a[0] - b[0]).map(([index, item]) => ({
    index,
    product_name: clean(item.product_name, 500),
    sku: clean(item.sku, 200) || null,
    size: clean(item.size, 200) || null,
    quantity: positiveWholeNumber(item.quantity || 1),
    price: item.price == null ? null : Number(item.price)
  })).filter(item => item.product_name || item.sku || item.price != null);

  if (!rows.length) {
    const product = firstField(fields, [/^product$/, /^product name$/, /^product .* name$/]);
    const sku = firstField(fields, [/^sku$/, /^product sku$/]);
    const price = money(firstField(fields, [/^price$/, /^product price$/, /^total price$/]));
    const quantity = positiveWholeNumber(firstField(fields, [/^quantity$/, /^qty$/, /^total quantity$/]) || 1);
    if (product || sku || price != null) rows.push({ index:1, product_name:product || sku, sku:sku || null, size:null, quantity, price });
  }
  return rows;
}

function inferStore(embed = {}, fields = fieldList(embed)) {
  const explicit = firstField(fields, [/^site$/, /^store$/, /^retailer$/]);
  const haystack = [
    explicit, embed.title, embed.description, embed.url,
    embed.author?.name, embed.footer?.text,
    ...fields.flatMap(field => [field.name, field.value])
  ].join(' ');
  return normalizeStore(explicit) || normalizeStore(haystack);
}

function extractOrderNumber(store, embed = {}, fields = fieldList(embed)) {
  const labeled = firstField(fields, [
    /^order id$/, /^order number$/, /^order no$/, /^order$/, /^confirmation number$/, /^purchase id$/
  ]);
  const labeledRef = normalizeOrderRef(labeled);
  if (labeledRef && labeledRef.length >= 4 && !/^(?:NONE|NULL|NA|N\/A|PENDING|UNKNOWN)$/.test(labeledRef)) {
    return clean(labeled, 200).replace(/^#+/, '').replace(/[.,]$/, '');
  }

  const haystack = [embed.title, embed.description, ...fields.flatMap(field => [field.name, field.value])].join('\n');
  const patterns = store === 'pokemoncenter'
    ? [/\b(P\d{8,12})\b/i]
    : store === 'boxlunch'
      ? [/\b(DL[A-Z0-9-]{5,30})\b/i, /\border\s*(?:number|id|#)?\s*[:#-]?\s*([A-Z0-9-]{6,30})\b/i]
      : store === 'supreme'
        ? [/\border\s*(?:number|id|#)?\s*[:#-]?\s*(\d{6,20})\b/i]
        : [/\border\s*(?:number|id|#)?\s*[:#-]?\s*([A-Z0-9-]{6,30})\b/i];
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (match?.[1]) return clean(match[1], 200).replace(/^#+/, '').replace(/[.,]$/, '');
  }
  return '';
}

function isSuccessfulCheckoutEmbed(embed = {}) {
  const heading = `${clean(embed.title, 500)} ${clean(embed.author?.name, 500)} ${clean(embed.description, 1000)}`.toLowerCase();
  if (/declin|failed|failure|error|cancel/.test(heading)) return false;
  return /successful\s+checkout|checkout\s+success/.test(heading);
}

function parseCheckoutEmbed(message = {}, embed = {}, embedIndex = 0, channel = {}) {
  if (!isSuccessfulCheckoutEmbed(embed)) return { skip_reason:'not_successful_checkout' };
  const fields = fieldList(embed);
  const store = inferStore(embed, fields);
  if (!ALLOWED_STORES.has(store)) return { skip_reason:'unsupported_store', detected_store:store || 'unknown' };

  const items = parseEmbedItems(embed);
  const orderNumber = extractOrderNumber(store, embed, fields);
  const totalQuantity = Math.max(1, items.reduce((sum, item) => sum + positiveWholeNumber(item.quantity || 1), 0));
  const explicitTotal = money(firstField(fields, [/^total price$/, /^order total$/, /^total$/]));
  const calculatedTotal = items.length && items.every(item => item.price != null)
    ? Math.round(items.reduce((sum, item) => sum + Number(item.price || 0) * positiveWholeNumber(item.quantity || 1), 0) * 100) / 100
    : null;
  const purchasePrice = explicitTotal ?? calculatedTotal ?? money(firstField(fields, [/^price$/, /^product price$/]));
  const checkoutAccount = lower(firstField(fields, [/^account$/, /^email$/, /^checkout email$/, /^login email$/]));
  const profileName = firstField(fields, [/^profile$/, /^profile name$/]);
  const sku = items.find(item => item.sku)?.sku || firstField(fields, [/^sku$/, /^product sku$/]);
  const productName = items.find(item => item.product_name)?.product_name || firstField(fields, [/^product$/, /^product name$/]) || `${store} checkout`;
  const timestamp = new Date(message.timestamp || message.created_at || 0);
  if (!Number.isFinite(timestamp.getTime())) return { skip_reason:'invalid_timestamp' };

  const guildId = clean(message.guild_id || channel.guild_id, 50);
  const channelId = clean(message.channel_id || channel.id, 50);
  const sourceKey = `${guildId || 'unknown'}:${channelId}:${message.id}:${embedIndex}`;
  const syntheticOrderId = `DISCORD-${message.id}-${embedIndex + 1}`;
  const externalOrderId = orderNumber || syntheticOrderId;
  return {
    source_key:sourceKey,
    guild_id:guildId || null,
    guild_name:clean(channel.guild_name, 200) || null,
    channel_id:channelId,
    channel_name:clean(channel.name, 200) || null,
    message_id:clean(message.id, 50),
    embed_index:embedIndex,
    message_url:guildId ? `https://discord.com/channels/${guildId}/${channelId}/${message.id}` : null,
    checkout_at:timestamp.toISOString(),
    store,
    order_number:externalOrderId,
    retailer_order_number:orderNumber || null,
    has_retailer_order_number:Boolean(orderNumber),
    checkout_account_email:checkoutAccount.includes('@') ? checkoutAccount : null,
    profile_name:clean(profileName, 300) || null,
    product_name:clean(productName, 500),
    sku:clean(sku, 200) || null,
    quantity:totalQuantity,
    purchase_price:purchasePrice,
    items,
    author_name:clean(message.author?.username || message.author?.global_name, 200) || null,
    webhook_id:clean(message.webhook_id, 50) || null,
    embed
  };
}

function timestampSnowflake(isoTimestamp) {
  const ms = BigInt(new Date(isoTimestamp).getTime());
  return ((ms - 1420070400000n) << 22n).toString();
}

function channelIdsFromInput(input) {
  const source = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return [...new Set(source.map(value => clean(value, 100)).filter(value => /^\d{17,21}$/.test(value)))];
}

function safeCutoff(value) {
  const requested = new Date(value || LATEST_ALLOWED_CUTOFF);
  if (!Number.isFinite(requested.getTime())) throw new Error('The Discord history cutoff is invalid.');
  if (requested.getTime() > new Date(LATEST_ALLOWED_CUTOFF).getTime()) {
    throw new Error('The cutoff cannot be later than April 18, 2026 at 2:07 PM Eastern. This protects website orders from being imported twice.');
  }
  return requested.toISOString();
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function discordGet(token, apiPath, attempt = 0) {
  const response = await fetch(`${DISCORD_API_BASE}${apiPath}`, {
    headers:{ Authorization:`Bot ${token}`, 'User-Agent':'The Shore Shack Historical Order Importer/1.0' }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 429 && attempt < 8) {
    const retryMs = Math.max(500, Math.min(30000, Number(body.retry_after || 1) * 1000));
    await delay(retryMs);
    return discordGet(token, apiPath, attempt + 1);
  }
  if (!response.ok) {
    const message = clean(body.message || response.statusText || 'Discord request failed', 500);
    const error = new Error(`Discord API ${response.status}: ${message}`);
    error.status = response.status;
    error.discord_code = body.code || null;
    throw error;
  }
  return body;
}

async function loadChannelHistory(token, channelId, cutoffAt, job) {
  const channel = await discordGet(token, `/channels/${encodeURIComponent(channelId)}`);
  const guild = channel.guild_id ? await discordGet(token, `/guilds/${encodeURIComponent(channel.guild_id)}`).catch(() => null) : null;
  const channelInfo = { id:String(channel.id || channelId), name:channel.name || channelId, guild_id:channel.guild_id || null, guild_name:guild?.name || null };
  const maxMessages = Math.max(100, Math.min(100000, Number(process.env.DISCORD_HISTORY_MAX_MESSAGES_PER_CHANNEL || 50000)));
  let before = timestampSnowflake(cutoffAt);
  let scanned = 0;
  const entries = [];
  const skipped = { not_successful_checkout:0, unsupported_store:0, invalid_timestamp:0 };
  let emptyWebhookEmbeds = 0;
  let truncated = false;

  while (scanned < maxMessages) {
    const page = await discordGet(token, `/channels/${encodeURIComponent(channelId)}/messages?limit=100&before=${encodeURIComponent(before)}`);
    if (!Array.isArray(page) || !page.length) break;
    scanned += page.length;
    job.messages_scanned += page.length;
    job.current_channel = `${channelInfo.guild_name || 'Discord'} / #${channelInfo.name}`;
    job.progress_message = `Scanned ${job.messages_scanned.toLocaleString()} message(s); found ${job.matches_found.toLocaleString()} supported checkout(s).`;

    for (const message of page) {
      const messageTime = new Date(message.timestamp || 0).getTime();
      if (!Number.isFinite(messageTime) || messageTime >= new Date(cutoffAt).getTime()) continue;
      const embeds = Array.isArray(message.embeds) ? message.embeds : [];
      if (!embeds.length && message.webhook_id && !clean(message.content)) emptyWebhookEmbeds++;
      embeds.forEach((embed, index) => {
        const parsed = parseCheckoutEmbed(message, embed, index, channelInfo);
        if (parsed.skip_reason) skipped[parsed.skip_reason] = (skipped[parsed.skip_reason] || 0) + 1;
        else { entries.push(parsed); job.matches_found++; }
      });
    }
    before = String(page[page.length - 1].id || '');
    if (!before || page.length < 100) break;
  }
  if (scanned >= maxMessages) truncated = true;
  return { channel:channelInfo, scanned, entries, skipped, empty_webhook_embeds:emptyWebhookEmbeds, truncated };
}

async function existingImportKeys(supabase, userId, entries) {
  const sourceKeys = new Set();
  let offset = 0;
  while (true) {
    const page = await supabase.from('orders').select('id,metadata').eq('user_id', userId).eq('source', 'discord_history')
      .order('created_at', { ascending:true }).range(offset, offset + 999);
    if (page.error) throw page.error;
    for (const row of page.data || []) if (row.metadata?.discord_source_key) sourceKeys.add(String(row.metadata.discord_source_key));
    if ((page.data || []).length < 1000) break;
    offset += 1000;
  }

  const externalIds = new Set();
  const wanted = [...new Set(entries.map(entry => entry.order_number).filter(Boolean))];
  const variants = [...new Set(wanted.flatMap(value => [value, `#${String(value).replace(/^#+/, '')}`]))];
  for (let i = 0; i < variants.length; i += 100) {
    const result = await supabase.from('orders').select('external_order_id').in('external_order_id', variants.slice(i, i + 100));
    if (result.error) throw result.error;
    for (const row of result.data || []) externalIds.add(normalizeOrderRef(row.external_order_id));
  }
  return { sourceKeys, externalIds };
}

function publicEntry(entry) {
  return {
    source_key:entry.source_key, checkout_at:entry.checkout_at, guild_name:entry.guild_name,
    channel_name:entry.channel_name, store:entry.store, order_number:entry.order_number,
    retailer_order_number:entry.retailer_order_number, checkout_account_email:entry.checkout_account_email,
    profile_name:entry.profile_name, product_name:entry.product_name, quantity:entry.quantity,
    purchase_price:entry.purchase_price, action:entry.action, duplicate_reason:entry.duplicate_reason || null,
    message_url:entry.message_url
  };
}

function jobView(job) {
  if (!job) return { status:'idle' };
  const result = job.result ? {
    ...job.result,
    entries:(job.result.entries || []).slice(0, 250).map(publicEntry)
  } : null;
  return {
    id:job.id, status:job.status, phase:job.phase, started_at:job.started_at,
    finished_at:job.finished_at || null, expires_at:job.expires_at,
    messages_scanned:job.messages_scanned || 0, matches_found:job.matches_found || 0,
    current_channel:job.current_channel || null, progress_message:job.progress_message || null,
    error:job.error || null, result, import_result:job.import_result || null
  };
}

function orderInsertRow(userId, entry) {
  const metadata = {
    discord_history_import:true,
    discord_source_key:entry.source_key,
    discord_guild_id:entry.guild_id,
    discord_guild_name:entry.guild_name,
    discord_channel_id:entry.channel_id,
    discord_channel_name:entry.channel_name,
    discord_message_id:entry.message_id,
    discord_message_url:entry.message_url,
    discord_embed_index:entry.embed_index,
    checkout_account_email:entry.checkout_account_email,
    account_email:entry.checkout_account_email,
    profile_name:entry.profile_name,
    profile:entry.profile_name,
    order_number:entry.retailer_order_number || entry.order_number,
    retailer_order_number:entry.retailer_order_number,
    has_retailer_order_number:entry.has_retailer_order_number,
    quantity:entry.quantity,
    purchase_price:entry.purchase_price,
    items:entry.items,
    imported_without_credit_charge:true,
    historical_checkout_at:entry.checkout_at
  };
  return {
    user_id:userId,
    external_order_id:entry.order_number,
    source:'discord_history',
    status:'success',
    site:entry.store,
    sku:entry.sku || '',
    product_name:entry.product_name || `${entry.store} checkout`,
    countdown_id:null,
    credits_charged:0,
    metadata,
    raw_payload:{
      source:'discord_history',
      timestamp:entry.checkout_at,
      guild_id:entry.guild_id,
      channel_id:entry.channel_id,
      message_id:entry.message_id,
      author:{ username:entry.author_name },
      webhook_id:entry.webhook_id,
      embeds:[entry.embed]
    },
    created_at:entry.checkout_at
  };
}

async function insertOrdersWithFallback(supabase, rows) {
  const inserted = [];
  const errors = [];
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const result = await supabase.from('orders').insert(batch).select('*');
    if (!result.error) { inserted.push(...(result.data || [])); continue; }
    for (const row of batch) {
      const one = await supabase.from('orders').insert(row).select('*').single();
      if (one.error) errors.push({ external_order_id:row.external_order_id, error:clean(one.error.message || one.error, 500) });
      else if (one.data) inserted.push(one.data);
    }
  }
  return { inserted, errors };
}

function configKey(userId) { return `discord_history_import:${userId}`; }

function registerDiscordHistoryImport({ app, supabase, auth, finalizeImportedOrders }) {
  const token = clean(process.env.DISCORD_HISTORY_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN, 500);
  const clientId = clean(process.env.DISCORD_HISTORY_BOT_CLIENT_ID || process.env.DISCORD_BOT_CLIENT_ID || process.env.DISCORD_CLIENT_ID, 100);
  const inviteUrl = clientId ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot&permissions=66560` : null;

  app.get('/orders/discord-history/config', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    let saved = null;
    try {
      const result = await supabase.from('app_settings').select('value_json').eq('key', configKey(req.user_id)).maybeSingle();
      if (!result.error) saved = result.data?.value_json || null;
    } catch (_) {}
    return res.json({
      configured:Boolean(token && clientId), token_configured:Boolean(token), client_id_configured:Boolean(clientId),
      invite_url:inviteUrl, required_permissions:['View Channel','Read Message History'],
      message_content_intent_required:true, latest_allowed_cutoff:LATEST_ALLOWED_CUTOFF,
      latest_allowed_cutoff_label:'April 18, 2026 at 2:07 PM Eastern', saved_channels:channelIdsFromInput(saved?.channels || [])
    });
  });

  app.post('/orders/discord-history/preview', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    if (!token) return res.status(503).json({ error:'Add DISCORD_HISTORY_BOT_TOKEN (or DISCORD_BOT_TOKEN) to Render first.' });
    const channelIds = channelIdsFromInput(req.body?.channels);
    if (!channelIds.length) return res.status(400).json({ error:'Enter at least one Discord checkout channel ID.' });
    if (channelIds.length > 10) return res.status(400).json({ error:'Preview at most 10 checkout channels at a time.' });
    let cutoffAt;
    try { cutoffAt = safeCutoff(req.body?.cutoff_at || LATEST_ALLOWED_CUTOFF); }
    catch (error) { return res.status(400).json({ error:error.message }); }

    const id = crypto.randomUUID();
    const now = Date.now();
    const job = {
      id, user_id:String(req.user_id), status:'running', phase:'reading_discord',
      started_at:new Date(now).toISOString(), expires_at:new Date(now + PREVIEW_TTL_MS).toISOString(),
      finished_at:null, cutoff_at:cutoffAt, channel_ids:channelIds,
      messages_scanned:0, matches_found:0, current_channel:null,
      progress_message:'Connecting to Discord…', result:null, import_result:null, entries:[], error:null
    };
    previewJobs.set(id, job);
    try {
      await supabase.from('app_settings').upsert({
        key:configKey(req.user_id), value_json:{ channels:channelIds, cutoff_at:cutoffAt }, updated_at:new Date().toISOString()
      }, { onConflict:'key' });
    } catch (_) {}
    res.status(202).json({ success:true, job:jobView(job) });

    setImmediate(async () => {
      try {
        const reports = [];
        const entries = [];
        for (const channelId of channelIds) {
          const report = await loadChannelHistory(token, channelId, cutoffAt, job);
          reports.push({
            channel:report.channel, messages_scanned:report.scanned, checkout_matches:report.entries.length,
            skipped:report.skipped, empty_webhook_embeds:report.empty_webhook_embeds, truncated:report.truncated
          });
          entries.push(...report.entries);
        }

        job.phase = 'checking_duplicates';
        job.progress_message = 'Checking the website for orders that already exist…';
        const existing = await existingImportKeys(supabase, req.user_id, entries);
        let importable = 0, duplicates = 0;
        for (const entry of entries) {
          if (existing.sourceKeys.has(entry.source_key)) {
            entry.action = 'skip_existing'; entry.duplicate_reason = 'same Discord message already imported'; duplicates++;
          } else if (existing.externalIds.has(normalizeOrderRef(entry.order_number))) {
            entry.action = 'skip_existing'; entry.duplicate_reason = 'retailer/Discord order ID already exists'; duplicates++;
          } else { entry.action = 'import'; importable++; }
        }
        job.entries = entries;
        job.result = {
          cutoff_at:cutoffAt,
          cutoff_label:'April 18, 2026 at 2:07 PM Eastern',
          channels:reports,
          messages_scanned:job.messages_scanned,
          supported_checkouts:entries.length,
          importable,
          duplicates,
          missing_retailer_order_number:entries.filter(entry => !entry.has_retailer_order_number).length,
          truncated:reports.some(report => report.truncated),
          message_content_warning:reports.some(report => report.empty_webhook_embeds > 0 && report.checkout_matches === 0),
          entries
        };
        job.status = 'preview_ready'; job.phase = 'awaiting_approval';
        job.finished_at = new Date().toISOString();
        job.progress_message = `Preview ready: ${importable} new order(s), ${duplicates} duplicate(s) skipped.`;
      } catch (error) {
        job.status = 'error'; job.phase = 'preview_failed'; job.finished_at = new Date().toISOString();
        if (Number(error.status) === 403) job.error = `${error.message}. Give the bot View Channel and Read Message History in every checkout channel.`;
        else if (Number(error.status) === 404) job.error = `${error.message}. Check the channel ID and make sure the bot is installed in that server.`;
        else job.error = clean(error.message || error, 1000);
      }
    });
  });

  app.get('/orders/discord-history/status', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const job = previewJobs.get(clean(req.query?.job_id, 100));
    if (!job || String(job.user_id) !== String(req.user_id)) return res.json({ job:{ status:'idle' } });
    return res.json({ job:jobView(job) });
  });

  app.post('/orders/discord-history/import', auth, async (req, res) => {
    if (req.role !== 'super_admin') return res.status(403).json({ error:'Super admin only.' });
    const job = previewJobs.get(clean(req.body?.job_id, 100));
    if (!job || String(job.user_id) !== String(req.user_id)) return res.status(404).json({ error:'That preview expired or the server restarted. Run Preview again.' });
    if (new Date(job.expires_at).getTime() < Date.now()) return res.status(410).json({ error:'That preview expired. Run Preview again before importing.' });
    if (job.status !== 'preview_ready') return res.status(409).json({ error:'Wait for the preview to finish before importing.' });
    job.status = 'running'; job.phase = 'importing'; job.finished_at = null;
    job.progress_message = 'Rechecking duplicates before creating historical orders…';
    res.status(202).json({ success:true, job:jobView(job) });

    setImmediate(async () => {
      try {
        const candidates = job.entries.filter(entry => entry.action === 'import');
        const existing = await existingImportKeys(supabase, req.user_id, candidates);
        const fresh = candidates.filter(entry => !existing.sourceKeys.has(entry.source_key) && !existing.externalIds.has(normalizeOrderRef(entry.order_number)));
        const skippedSincePreview = candidates.length - fresh.length;
        job.progress_message = `Creating ${fresh.length.toLocaleString()} historical service order(s)…`;
        const insertResult = await insertOrdersWithFallback(supabase, fresh.map(entry => orderInsertRow(req.user_id, entry)));

        job.phase = 'building_order_tracker';
        job.progress_message = `Created ${insertResult.inserted.length.toLocaleString()} service order(s). Building Order Tracker records…`;
        let finalized = { tracker_orders:0, email_repair_queued:0 };
        if (insertResult.inserted.length && typeof finalizeImportedOrders === 'function') {
          finalized = await finalizeImportedOrders(req.user_id, insertResult.inserted);
        }
        job.import_result = {
          imported_orders:insertResult.inserted.length,
          duplicate_orders_skipped:(job.result?.duplicates || 0) + skippedSincePreview,
          failed_orders:insertResult.errors.length,
          failures:insertResult.errors.slice(0, 100),
          tracker_orders:Number(finalized?.tracker_orders || 0),
          email_repair_queued:Number(finalized?.email_repair_queued || 0),
          imported_without_credit_charge:true
        };
        job.status = 'complete'; job.phase = 'complete'; job.finished_at = new Date().toISOString();
        job.progress_message = `Imported ${insertResult.inserted.length} historical order(s); queued ${job.import_result.email_repair_queued} for exact email lookup.`;
      } catch (error) {
        job.status = 'error'; job.phase = 'import_failed'; job.finished_at = new Date().toISOString();
        job.error = clean(error.message || error, 1000);
      }
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of previewJobs.entries()) if (new Date(job.expires_at).getTime() + PREVIEW_TTL_MS < now) previewJobs.delete(id);
  }, 15 * 60 * 1000).unref?.();
}

module.exports = {
  registerDiscordHistoryImport,
  __test:{ clean, normalizeStore, parseEmbedItems, parseCheckoutEmbed, timestampSnowflake, channelIdsFromInput, safeCutoff, orderInsertRow }
};
