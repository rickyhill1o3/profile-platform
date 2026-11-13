const net = require('net');
const dns = require('dns').promises;
const sharp = require('sharp');

const RECAP_TIME_ZONE = 'America/New_York';
// Render 720p-class frames so Discord does not have to upscale the animation.
// The SVG artwork still uses the original 800x450 coordinate system via viewBox.
const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 675;
const DISCORD_SAFE_GIF_BYTES = Math.floor(9.5 * 1024 * 1024);

function cleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/\|\|/g, '')
    .replace(/\*\*/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalize(value) {
  return cleanText(value, 1000).toLowerCase().replace(/pok[eé]mon/g, 'pokemon').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeSite(value) {
  const site = normalize(value).replace(/\s+/g, '');
  if (site.includes('pokemoncenter') || site === 'pokemon') return 'pokemoncenter';
  if (site.includes('samsclub') || site === 'sams') return 'samsclub';
  return site || 'store';
}

function numberFrom(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  const number = Number(cleaned[0]);
  return Number.isFinite(number) ? number : null;
}

function positivePrice(value) {
  const number = numberFrom(value);
  return number !== null && number > 0 ? Math.round(number * 100) / 100 : null;
}

function positiveQuantity(value) {
  const number = numberFrom(value);
  return number !== null && number > 0 ? Math.max(1, Math.round(number)) : 1;
}

function embedFields(payload = {}) {
  const embed = Array.isArray(payload.embeds) ? (payload.embeds[0] || {}) : (payload.embed || {});
  const fields = {};
  for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
    const key = normalize(field?.name);
    if (key) fields[key] = cleanText(field?.value, 2000);
  }
  return { embed, fields };
}

function firstField(fields, names) {
  const wanted = names.map(normalize);
  for (const [key, value] of Object.entries(fields || {})) {
    if (wanted.includes(key)) return value;
  }
  return '';
}

function checkoutEventIsSuccessful(row = {}) {
  const status = normalize(row.status);
  if (['duplicate skipped', 'received', 'processing', 'pending email verification'].includes(status)) return false;
  if (status.includes('error') || status.includes('failed') || status.includes('declined')) return false;

  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const { embed, fields } = embedFields(payload);
  const type = normalize(`${row.type || ''} ${row.webhook_type || ''} ${row.category || ''}`);
  if (!type.includes('checkout')) return false;
  const haystack = normalize([
    row.status, row.error, row.error_message, embed.title, embed.description,
    embed?.author?.name, Object.entries(fields).map(([key, value]) => `${key} ${value}`).join(' '),
    payload.title, payload.status, payload.message, payload.error
  ].join(' '));
  if (/payment declined|decision manager|failed|failure|error|out of stock|cancelled|canceled|rejected|insufficient|login required|captcha|account locked|verification required/.test(haystack)) return false;
  return ['processed', 'success', 'successful', 'confirmed', 'completed'].includes(status)
    || /successful checkout|checkout success|successfully checked out|order confirmed|confirmed order|status success|status confirmed/.test(haystack);
}

function itemNameFromRow(row, item, payload, fields, embed) {
  const candidates = [
    item?.title, item?.product_name, item?.product,
    row.product_name, row.product,
    payload.product_name, payload?.product?.name,
    firstField(fields, ['product', 'product (1)', 'product name', 'item', 'item (1)', 'title']),
    embed.description
  ];
  for (const candidate of candidates) {
    const value = cleanText(candidate, 500);
    if (!value || /^https?:\/\//i.test(value)) continue;
    if (/^(successful checkout|checkout success)!?$/i.test(value)) continue;
    return value;
  }
  return 'Successful checkout';
}

function itemSkuFromRow(row, item, payload, fields) {
  return cleanText(
    item?.sku || item?.tcin || item?.asin || row.sku || payload.sku || payload.product_sku
    || firstField(fields, ['sku', 'tcin', 'asin', 'product id', 'offer id']),
    160
  );
}

function eventItems(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const { embed, fields } = embedFields(payload);
  const parsed = Array.isArray(row.parsed_items) && row.parsed_items.length ? row.parsed_items : [{}];
  const globalQuantity = positiveQuantity(payload.quantity ?? payload.qty ?? firstField(fields, ['quantity', 'qty']));
  const globalPrice = positivePrice(payload.price ?? firstField(fields, ['price', 'product price', 'item price', 'checkout price']));
  const site = normalizeSite(row.site || payload.site || payload.source || firstField(fields, ['site', 'store']));

  return parsed.map((item, index) => ({
    event_id: row.id || null,
    site: normalizeSite(item?.site || site),
    product: itemNameFromRow(row, item, payload, fields, embed),
    sku: itemSkuFromRow(row, item, payload, fields),
    quantity: positiveQuantity(item?.quantity ?? item?.qty ?? (parsed.length === 1 ? globalQuantity : 1)),
    webhook_price: positivePrice(item?.price ?? item?.priceNumber ?? (parsed.length === 1 ? globalPrice : null)),
    image: cleanText(
      item?.image || item?.image_url || item?.thumbnail || item?.thumbnail_url
      || payload.image || payload.image_url || payload.thumbnail_url
      || payload?.product?.image || payload?.product?.image_url
      || embed?.thumbnail?.url || embed?.image?.url,
      2000
    ),
    checkout_at: row.created_at || null,
    index
  }));
}

function canonicalProductName(value) {
  return normalize(value)
    .replace(/\bpokemon (trading card games?|tcg)\b/g, 'pokemon')
    .replace(/\btrading card games?\b/g, '')
    .replace(/\bevolutions\b/g, 'evolution')
    .replace(/\belite trainer boxes\b/g, 'elite trainer box')
    .replace(/\bbooster bundles\b/g, 'booster bundle')
    .replace(/\bcollections\b/g, 'collection')
    .replace(/\b(target|walmart|pokemon center|amazon|sams club)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function catalogMaps(catalogRows = []) {
  const bySiteSku = new Map();
  const bySku = new Map();
  const bySiteName = new Map();
  const byName = new Map();
  for (const row of catalogRows || []) {
    const sku = normalize(row.sku);
    const name = canonicalProductName(row.product_name || row.name || row.title);
    const site = normalizeSite(row.site || row.store || row.primary_site);
    if (sku) {
      bySiteSku.set(`${site}:${sku}`, row);
      if (!bySku.has(sku)) bySku.set(sku, row);
    }
    if (name) {
      bySiteName.set(`${site}:${name}`, row);
      if (!byName.has(name)) byName.set(name, row);
    }
  }
  return { bySiteSku, bySku, bySiteName, byName };
}

function findCatalogRow(item, maps) {
  const sku = normalize(item.sku);
  const name = canonicalProductName(item.product);
  return (sku && maps.bySiteSku.get(`${item.site}:${sku}`))
    || (sku && maps.bySku.get(sku))
    || (name && maps.bySiteName.get(`${item.site}:${name}`))
    || (name && maps.byName.get(name))
    || null;
}

function buildReleaseRecapSummary({ events = [], catalogRows = [], trackedTotalsByEventId = {}, from, to, timeZone = RECAP_TIME_ZONE } = {}) {
  const maps = catalogMaps(catalogRows);
  const successfulEvents = (events || []).filter(checkoutEventIsSuccessful);
  const resolvedItems = successfulEvents.flatMap(eventItems).map((item) => {
    const catalog = findCatalogRow(item, maps);
    const catalogPrice = positivePrice(catalog?.default_max_price ?? catalog?.price ?? catalog?.retail_price);
    const unitPrice = item.webhook_price || catalogPrice;
    return {
      ...item,
      product: cleanText(catalog?.product_name || item.product, 500),
      sku: cleanText(item.sku || catalog?.sku, 160),
      image: cleanText(item.image || catalog?.image_url || catalog?.image, 2000),
      unit_price: unitPrice,
      price_source: item.webhook_price ? 'webhook' : (catalogPrice ? 'catalog' : 'unresolved'),
      line_total: unitPrice ? Math.round(unitPrice * item.quantity * 100) / 100 : null
    };
  });

  const grouped = new Map();
  for (const item of resolvedItems) {
    const nameKey = canonicalProductName(item.product);
    const skuKey = normalize(item.sku);
    const key = nameKey && nameKey !== 'successful checkout' ? `product:${nameKey}` : `sku:${skuKey}`;
    if (!key || key === 'sku:') continue;
    const existing = grouped.get(key) || {
      key,
      site: item.site,
      product: item.product,
      sku: item.sku,
      image: item.image,
      checkout_count: 0,
      item_count: 0,
      total_spend: 0,
      resolved_item_count: 0,
      unresolved_item_count: 0,
      unit_price: item.unit_price,
      price_source: item.price_source,
      latest_checkout_at: item.checkout_at
    };
    existing.checkout_count += 1;
    existing.item_count += item.quantity;
    if (item.line_total !== null) {
      existing.total_spend += item.line_total;
      existing.resolved_item_count += item.quantity;
    } else {
      existing.unresolved_item_count += item.quantity;
    }
    if (!existing.image && item.image) existing.image = item.image;
    if (!existing.sku && item.sku) existing.sku = item.sku;
    if (!existing.unit_price && item.unit_price) {
      existing.unit_price = item.unit_price;
      existing.price_source = item.price_source;
    }
    if (new Date(item.checkout_at || 0) > new Date(existing.latest_checkout_at || 0)) existing.latest_checkout_at = item.checkout_at;
    grouped.set(key, existing);
  }

  const products = [...grouped.values()]
    .map(product => ({ ...product, total_spend: Math.round(product.total_spend * 100) / 100 }))
    .sort((a, b) => b.item_count - a.item_count || b.checkout_count - a.checkout_count || a.product.localeCompare(b.product));
  const checkoutCount = successfulEvents.length;
  const itemCount = resolvedItems.reduce((sum, item) => sum + item.quantity, 0);
  const itemsByEvent = new Map();
  for (const item of resolvedItems) {
    const key = String(item.event_id || '');
    if (!itemsByEvent.has(key)) itemsByEvent.set(key, []);
    itemsByEvent.get(key).push(item);
  }
  const trackedEntryFor = eventId => {
    const raw = trackedTotalsByEventId instanceof Map
      ? trackedTotalsByEventId.get(String(eventId))
      : trackedTotalsByEventId?.[String(eventId)];
    if (raw && typeof raw === 'object') return { total: positivePrice(raw.total), status: normalize(raw.status), matched: true };
    return { total: positivePrice(raw), status: '', matched: raw !== undefined && raw !== null };
  };
  let retailerConfirmedSpend = 0;
  let catalogEstimatedSpend = 0;
  let retailerConfirmedCheckoutCount = 0;
  let catalogEstimatedCheckoutCount = 0;
  let unresolvedCheckoutCount = 0;
  let canceledCheckoutCount = 0;
  for (const event of successfulEvents) {
    const tracked = trackedEntryFor(event.id);
    if (['canceled', 'cancelled', 'refunded'].includes(tracked.status)) {
      canceledCheckoutCount += 1;
      continue;
    }
    if (tracked.total) {
      retailerConfirmedSpend += tracked.total;
      retailerConfirmedCheckoutCount += 1;
      continue;
    }
    const items = itemsByEvent.get(String(event.id || '')) || [];
    const eventEstimate = items.reduce((sum, item) => sum + (item.line_total || 0), 0);
    const hasUnresolved = items.some(item => item.line_total === null);
    if (eventEstimate > 0) {
      catalogEstimatedSpend += eventEstimate;
      catalogEstimatedCheckoutCount += 1;
    }
    if (hasUnresolved || eventEstimate <= 0) unresolvedCheckoutCount += 1;
  }
  retailerConfirmedSpend = Math.round(retailerConfirmedSpend * 100) / 100;
  catalogEstimatedSpend = Math.round(catalogEstimatedSpend * 100) / 100;
  const totalSpend = Math.round((retailerConfirmedSpend + catalogEstimatedSpend) * 100) / 100;
  const resolvedItemCount = resolvedItems.reduce((sum, item) => sum + (item.line_total !== null ? item.quantity : 0), 0);
  const unresolvedItems = resolvedItems.filter(item => item.line_total === null).map(item => ({
    site: item.site,
    sku: item.sku,
    product: item.product,
    quantity: item.quantity
  }));

  const start = new Date(from);
  const end = new Date(to);
  const rangeLabel = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
    ? `${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(start)} – ${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(end)}`
    : '';

  return {
    from: Number.isFinite(start.getTime()) ? start.toISOString() : null,
    to: Number.isFinite(end.getTime()) ? end.toISOString() : null,
    time_zone: timeZone,
    range_label: rangeLabel,
    checkout_count: checkoutCount,
    item_count: itemCount,
    unique_product_count: products.length,
    total_spend: totalSpend,
    retailer_confirmed_spend: retailerConfirmedSpend,
    catalog_estimated_spend: catalogEstimatedSpend,
    retailer_confirmed_checkout_count: retailerConfirmedCheckoutCount,
    catalog_estimated_checkout_count: catalogEstimatedCheckoutCount,
    unresolved_checkout_count: unresolvedCheckoutCount,
    canceled_checkout_count: canceledCheckoutCount,
    resolved_item_count: resolvedItemCount,
    unresolved_item_count: Math.max(0, itemCount - resolvedItemCount),
    unresolved_items: unresolvedItems,
    products
  };
}

function xmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function wrapText(value, maxChars = 32, maxLines = 3) {
  const words = cleanText(value, 500).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current || `${current} ${word}`.length <= maxChars) current = current ? `${current} ${word}` : word;
    else { lines.push(current); current = word; }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(' ').length > lines.join(' ').length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.\s]+$/, '')}…`;
  return lines;
}

function textLinesSvg(lines, x, y, { size = 30, weight = 700, fill = '#f8fafc', lineHeight = 1.2, anchor = 'start' } = {}) {
  return (lines || []).map((line, index) => `<text x="${x}" y="${y + (index * size * lineHeight)}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${xmlEscape(line)}</text>`).join('');
}

function summarySvg(summary) {
  const money = `$${Number(summary.total_spend || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const checkoutNote = `${summary.checkout_count} successful checkout${summary.checkout_count === 1 ? '' : 's'} in this release`;
  return Buffer.from(`<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 800 450" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#091426"/><stop offset="0.55" stop-color="#15245a"/><stop offset="1" stop-color="#4c1d95"/></linearGradient><radialGradient id="glow"><stop stop-color="#38bdf8" stop-opacity=".32"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient></defs>
    <rect width="800" height="450" rx="28" fill="url(#bg)"/><circle cx="130" cy="80" r="220" fill="url(#glow)"/><text x="48" y="56" font-family="Arial" font-size="15" font-weight="800" fill="#7dd3fc" letter-spacing="2">THE SHORE SHACK • RELEASE RECAP</text>
    <text x="48" y="136" font-family="Arial" font-size="58" font-weight="900" fill="#ffffff">${xmlEscape(money)}</text><text x="50" y="163" font-family="Arial" font-size="16" font-weight="700" fill="#cbd5e1">ACTUAL TOTAL SPEND</text>
    <g transform="translate(48 205)"><rect width="214" height="102" rx="18" fill="#ffffff" fill-opacity=".09"/><text x="22" y="36" font-family="Arial" font-size="13" font-weight="800" fill="#93c5fd">CHECKOUTS</text><text x="22" y="78" font-family="Arial" font-size="36" font-weight="900" fill="#fff">${summary.checkout_count}</text></g>
    <g transform="translate(278 205)"><rect width="214" height="102" rx="18" fill="#ffffff" fill-opacity=".09"/><text x="22" y="36" font-family="Arial" font-size="13" font-weight="800" fill="#93c5fd">TOTAL ITEMS</text><text x="22" y="78" font-family="Arial" font-size="36" font-weight="900" fill="#fff">${summary.item_count}</text></g>
    <g transform="translate(508 205)"><rect width="244" height="102" rx="18" fill="#ffffff" fill-opacity=".09"/><text x="22" y="36" font-family="Arial" font-size="13" font-weight="800" fill="#93c5fd">UNIQUE PRODUCTS</text><text x="22" y="78" font-family="Arial" font-size="36" font-weight="900" fill="#fff">${summary.unique_product_count}</text></g>
    <text x="48" y="356" font-family="Arial" font-size="16" font-weight="700" fill="#e2e8f0">${xmlEscape(summary.range_label || '')}</text><text x="48" y="390" font-family="Arial" font-size="14" fill="#86efac">${xmlEscape(checkoutNote)}</text>
    <text x="752" y="418" text-anchor="end" font-family="Arial" font-size="12" fill="#94a3b8">Community totals • no customer information</text>
  </svg>`);
}

function isPrivateIp(hostname) {
  if (!hostname) return true;
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  if (net.isIP(hostname) === 4) {
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
  }
  if (net.isIP(hostname) === 6) return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
  return false;
}

async function isSafeImageHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host || isPrivateIp(host)) return false;
  if (net.isIP(host)) return true;
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(result => !isPrivateIp(String(result.address || '').toLowerCase()));
  } catch (_) {
    return false;
  }
}

async function fetchProductImageDataUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || !await isSafeImageHostname(parsed.hostname)) return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(parsed.href, { signal: controller.signal, headers: { 'User-Agent': 'The Shore Shack Release Recap/1.0' } });
    clearTimeout(timer);
    if (!response.ok) return '';
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 8 * 1024 * 1024) return '';
    const input = Buffer.from(await response.arrayBuffer());
    if (!input.length || input.length > 8 * 1024 * 1024) return '';
    const png = await sharp(input, { failOn: 'error', limitInputPixels: 25_000_000 })
      .resize({ width: 640, height: 560, fit: 'contain', kernel: sharp.kernel.lanczos3, withoutEnlargement: false, background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function productSvg(summary, product, imageDataUrl, position) {
  const titleLines = wrapText(product.product, 30, 3);
  const skuLine = product.sku ? `SKU ${product.sku}` : 'SUCCESSFUL CHECKOUTS';
  const image = imageDataUrl
    ? `<image href="${imageDataUrl}" x="58" y="103" width="315" height="282" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="76" y="124" width="278" height="238" rx="24" fill="#fff" fill-opacity=".08"/><text x="215" y="237" text-anchor="middle" font-family="Arial" font-size="20" font-weight="800" fill="#94a3b8">PRODUCT IMAGE</text><text x="215" y="267" text-anchor="middle" font-family="Arial" font-size="14" fill="#64748b">not available</text>`;
  return Buffer.from(`<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 800 450" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071426"/><stop offset=".55" stop-color="#0f2850"/><stop offset="1" stop-color="#312e81"/></linearGradient><radialGradient id="burst"><stop stop-color="#38bdf8" stop-opacity=".28"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient></defs>
    <rect width="800" height="450" rx="28" fill="url(#bg)"/><circle cx="210" cy="235" r="250" fill="url(#burst)"/><rect x="36" y="82" width="356" height="326" rx="26" fill="#ffffff" fill-opacity=".94"/>${image}
    <text x="430" y="55" font-family="Arial" font-size="14" font-weight="800" fill="#7dd3fc" letter-spacing="1.5">CHECKOUT HIGHLIGHT ${position}/${summary.unique_product_count}</text>
    ${textLinesSvg(titleLines, 430, 112, { size: 30, lineHeight: 1.18 })}
    <rect x="430" y="234" width="${Math.max(96, 28 + product.site.length * 9)}" height="34" rx="17" fill="#2563eb"/><text x="445" y="257" font-family="Arial" font-size="14" font-weight="800" fill="#fff">${xmlEscape(product.site.toUpperCase())}</text>
    <text x="430" y="318" font-family="Arial" font-size="54" font-weight="900" fill="#86efac">×${product.item_count}</text><text x="430" y="347" font-family="Arial" font-size="14" font-weight="800" fill="#cbd5e1">ITEM${product.item_count === 1 ? '' : 'S'} • ${product.checkout_count} CHECKOUT${product.checkout_count === 1 ? '' : 'S'}</text>
    <text x="430" y="390" font-family="Arial" font-size="16" font-weight="700" fill="#e2e8f0">${xmlEscape(skuLine)}</text>
    <circle cx="430" cy="418" r="4" fill="#38bdf8"/><text x="446" y="423" font-family="Arial" font-size="12" fill="#94a3b8">${xmlEscape(summary.range_label || '')}</text>
  </svg>`);
}

async function buildReleaseRecapGif(summary = {}) {
  if (!summary || !Array.isArray(summary.products) || !summary.products.length) throw new Error('No successful checkout products were found in this release window.');
  const frames = [await sharp(summarySvg(summary)).png().toBuffer()];
  for (let index = 0; index < summary.products.length; index += 1) {
    const product = summary.products[index];
    const imageDataUrl = await fetchProductImageDataUrl(product.image);
    frames.push(await sharp(productSvg(summary, product, imageDataUrl, index + 1)).png().toBuffer());
  }
  const delay = [2400, ...summary.products.map(() => 1650)];
  const encode = (inputFrames, options) => sharp(inputFrames, { join: { animated: true } })
    .gif({ loop: 0, delay, effort: 7, ...options })
    .toBuffer();

  // Prefer a full 256-colour palette with low palette/frame error. If a long release recap
  // exceeds Discord's standard upload-safe size, retain the HD dimensions and make a modest
  // palette compromise before falling back to a still-sharper-than-before 960x540 encode.
  let animation = await encode(frames, {
    colours: 256,
    dither: 0.75,
    interFrameMaxError: 3,
    interPaletteMaxError: 3
  });
  if (animation.length <= DISCORD_SAFE_GIF_BYTES) return animation;

  animation = await encode(frames, {
    colours: 192,
    dither: 0.65,
    interFrameMaxError: 6,
    interPaletteMaxError: 6
  });
  if (animation.length <= DISCORD_SAFE_GIF_BYTES) return animation;

  const fallbackFrames = await Promise.all(frames.map(frame => sharp(frame)
    .resize({ width: 960, height: 540, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()));
  return encode(fallbackFrames, {
    colours: 192,
    dither: 0.65,
    interFrameMaxError: 6,
    interPaletteMaxError: 6
  });
}

function buildReleaseRecapCaption(summary = {}, animationUrl = '') {
  return String(animationUrl || '').trim();
}

module.exports = {
  RECAP_TIME_ZONE,
  checkoutEventIsSuccessful,
  eventItems,
  buildReleaseRecapSummary,
  buildReleaseRecapGif,
  buildReleaseRecapCaption,
  normalizeSite,
  canonicalProductName
};
