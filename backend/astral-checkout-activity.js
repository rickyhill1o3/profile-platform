const crypto = require('crypto');

const PREFIX = 'astral-checkout-activity:';
const GROUPS = new Set(['ricky', 'johnathan']);

function fieldText(value) {
  return String(value ?? '').replace(/[\\`*|]/g, '').trim();
}

function amazonOrderRef(value) {
  const ref = fieldText(value).replace(/^#\s*/, '');
  return /^\d{3}-\d{7}-\d{7}$/.test(ref) ? ref : '';
}

function parseAstralCheckout(message, embed, embedIndex, channel) {
  // Distinguish an original bot/webhook post from an ordinary Discord message.
  if ((!message.webhook_id && message.author?.bot !== true) ||
      ![message.author?.username, embed.author?.name, embed.footer?.text].some(value => /^astral cloud$/i.test(fieldText(value)))) return undefined;
  if (!/^successful checkout!?$/i.test(fieldText(embed.title))) return { skip_reason:'not_successful_checkout' };

  const fields = new Map((Array.isArray(embed.fields) ? embed.fields : []).map(field => [fieldText(field.name).toLowerCase(), fieldText(field.value)]));
  const group = String(fields.get('product group') || '').toLowerCase();
  if (!GROUPS.has(group)) return { skip_reason:'unrecognized_astral_group' };

  // An ASIN and an Amazon link (or explicit retailer field) identify the retailer.
  const sku = String(fields.get('asin') || fields.get('sku') || '').toUpperCase();
  const urls = (String(fields.get('links') || '') + ' ' + String(embed.url || '')).match(/https:\/\/[^\s<>()]+/gi) || [];
  const amazonLink = urls.some(raw => {
    try {
      const url = new URL(raw);
      return /^(?:www\.)?amazon\.com$/i.test(url.hostname) && url.pathname.toUpperCase().split('/').includes(sku);
    } catch (_) { return false; }
  });
  if (!/^[A-Z0-9]{10}$/.test(sku) || (!amazonLink && (fields.get('site') || fields.get('store') || '').toLowerCase() !== 'amazon')) {
    return { skip_reason:'unsupported_store' };
  }

  const rawQty = fields.get('quantity') || fields.get('qty') || '';
  const quantity = /^\d{1,6}$/.test(rawQty) ? Number(rawQty) : 0;
  if (quantity < 1) return { skip_reason:'missing_astral_quantity' };
  const time = new Date(message.timestamp || 0);
  if (!Number.isFinite(time.getTime()) || !message.id) return { skip_reason:'invalid_timestamp' };

  const title = fieldText(embed.description || fields.get('product') || fields.get('product name')).replace(/\s+/g, ' ').slice(0, 300);
  const product = title && !/[@<>]|https?:\/\//i.test(title) ? title : sku;
  const ref = ['order id', 'order number', 'purchase id'].map(key => amazonOrderRef(fields.get(key))).find(Boolean) || null;
  const id = crypto.createHash('sha256').update(`astral:${message.id}:${embedIndex}`).digest('hex').slice(0, 32);
  return {
    activity_only:true, activity_id:id, source_key:`astral:${id}`, activity_group:group,
    checkout_at:time.toISOString(), guild_name:channel.guild_name || null, channel_name:channel.name || null,
    store:'amazon', retailer_order_number:ref, order_number:ref,
    product_name:product, sku, quantity
  };
}

function activitySetting(entry) {
  const key = `${PREFIX}${entry.checkout_at}:${entry.activity_id}`;
  // Allowlist data here: no raw embeds, group labels, masked accounts or private links.
  return { key, updated_at:new Date().toISOString(), value_json:{
    id:entry.activity_id, created_at:entry.checkout_at, sku:entry.sku,
    product_name:entry.product_name, quantity:entry.quantity, retailer_order_number:entry.retailer_order_number
  } };
}

async function saveAstralCheckoutActivity(supabase, entries) {
  const rows = [...new Map(entries.map(activitySetting).map(row => [row.key, row])).values()];
  let added = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const { data, error } = await supabase.from('app_settings')
      .upsert(rows.slice(i, i + 100), { onConflict:'key', ignoreDuplicates:true }).select('key');
    if (error) throw new Error(`Could not save Astral activity: ${error.message}`);
    added += data?.length || 0;
  }
  return { added, duplicates:rows.length - added };
}

async function existingAstralActivityKeys(supabase, entries) {
  const keys = entries.map(entry => activitySetting(entry).key);
  const found = new Set();
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await supabase.from('app_settings').select('key').in('key', keys.slice(i, i + 100));
    if (error) throw new Error(`Could not check existing Astral activity: ${error.message}`);
    for (const row of data || []) found.add(row.key);
  }
  return new Set(entries.filter(entry => found.has(activitySetting(entry).key)).map(entry => entry.activity_id));
}

async function loadAstralCheckoutActivity(supabase, { from, to, limit = Infinity } = {}) {
  const rows = [];
  while (rows.length < limit) {
    const size = Math.min(500, limit - rows.length);
    let query = supabase.from('app_settings').select('value_json').like('key', `${PREFIX}%`);
    if (from) query = query.gte('key', `${PREFIX}${from}`);
    if (to) query = query.lt('key', `${PREFIX}${new Date(Date.parse(to) + 1).toISOString()}`);
    const { data, error } = await query.order('key', { ascending:false }).range(rows.length, rows.length + size - 1);
    if (error) throw new Error(`Could not load Astral activity: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < size) break;
  }
  return rows.filter(row => row.value_json?.id && row.value_json?.sku).map(({ value_json: item }) => ({
    id:`astral-${item.id}`, created_at:item.created_at, type:'checkout_activity', status:'bot_reported',
    site:'amazon', sku:item.sku, product_name:item.product_name, external_order_id:item.retailer_order_number,
    parsed_items:[{ sku:item.sku, title:item.product_name, quantity:item.quantity, site:'amazon' }]
  }));
}

function isAstralActivity(row) {
  return row?.type === 'checkout_activity' && row.status === 'bot_reported' && row.site === 'amazon';
}

function removeDuplicateAstralActivity(rows) {
  const refs = new Set();
  const ids = new Set();
  for (const row of rows) {
    if (isAstralActivity(row) || String(row.site || '').toLowerCase() !== 'amazon') continue;
    const payload = row.payload || {};
    const rawFields = Array.isArray(payload.embeds) ? payload.embeds[0]?.fields : payload.embed?.fields;
    const fields = Array.isArray(rawFields) ? rawFields : [];
    for (const raw of [row.external_order_id, payload.external_order_id, payload.order_number, payload.order_id, payload.purchase_id, payload.purchaseId,
      ...fields.filter(field => /^(?:purchase id|order id|order number|order)$/i.test(fieldText(field.name))).map(field => field.value)]) {
      const ref = amazonOrderRef(raw);
      if (ref) refs.add(ref);
    }
  }
  return rows.filter(row => {
    if (!isAstralActivity(row)) return true;
    const ref = amazonOrderRef(row.external_order_id);
    if (ids.has(row.id) || (ref && refs.has(ref))) return false;
    ids.add(row.id);
    if (ref) refs.add(ref);
    return true;
  });
}

module.exports = { parseAstralCheckout, saveAstralCheckoutActivity, existingAstralActivityKeys, loadAstralCheckoutActivity, isAstralActivity, removeDuplicateAstralActivity };
