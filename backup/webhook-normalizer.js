
function clean(value = '') {
  return String(value || '')
    .replace(/\|\|/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function fieldMap(embed = {}) {
  const map = {};
  for (const field of embed.fields || []) {
    map[String(field.name || '').toLowerCase()] = clean(field.value);
  }
  return map;
}

function detectBot(payload = {}) {
  const username = String(payload.username || '').toLowerCase();
  const footer = String(payload?.embeds?.[0]?.footer?.text || '').toLowerCase();
  const author = String(payload?.embeds?.[0]?.author?.name || '').toLowerCase();

  if (username.includes('astral') || footer.includes('astral')) return 'astral';
  if (footer.includes('stellara') || author.includes('checked out')) return 'stellar';
  if (author.includes('refract') || footer.includes('prism technologies')) return 'refract';

  return 'unknown';
}

function detectStatus(embed = {}, fields = {}) {
  const title = clean(embed.title || embed.author?.name || '').toLowerCase();
  const orderStatus = clean(fields['order status'] || '').toLowerCase();
  const fraud = clean(fields['fraud status'] || '').toLowerCase();
  const description = clean(fields['status description'] || embed.description || '').toLowerCase();

  if (title.includes('successful') || title.includes('checked out')) return 'SUCCESS';
  if (title.includes('oos') || orderStatus.includes('oos')) return 'OOS';
  if (title.includes('payment declined') || fraud.includes('payment')) return 'PAYMENT_DECLINE';
  if (orderStatus.includes('cancel_fraud') || fraud.includes('failed')) return 'FRAUD';
  if (description.includes('policy')) return 'POLICY_CANCEL';
  if (title.includes('declined')) return 'DECLINED';

  return 'UNKNOWN';
}

function normalizeWebhookPayload(payload = {}) {
  const embed = Array.isArray(payload.embeds) ? payload.embeds[0] || {} : {};
  const fields = fieldMap(embed);

  return {
    bot: detectBot(payload),
    status: detectStatus(embed, fields),

    site: clean(fields.site),
    product: clean(fields.product || embed.description),
    sku: clean(fields.sku || fields['title/sku']),
    quantity: clean(fields.quantity),
    mode: clean(fields.mode),

    profile: clean(fields.profile),
    email: clean(fields.account || fields.email),
    proxy: clean(fields.proxy || fields['proxy details']),

    orderId: clean(fields['order id'] || fields['order number']),
    fraudStatus: clean(fields['fraud status']),
    orderStatus: clean(fields['order status']),

    image: embed.thumbnail?.url || '',
    footer: clean(embed.footer?.text),

    raw: payload
  };
}

module.exports = {
  normalizeWebhookPayload
};
