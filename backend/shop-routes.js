
function parseMultiSkuValue(rawValue) {
    if (!rawValue) return [];

    return rawValue
        .split(/[\n,]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function countEffectiveSkus(product) {
    if (!product) return 0;

    if (Array.isArray(product.multiSkus) && product.multiSkus.length) {
        return product.multiSkus.length;
    }

    if (typeof product.sku === 'string') {
        return parseMultiSkuValue(product.sku).length || 1;
    }

    return 1;
}

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

function dollarsToCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.round(num * 100));
}

function centsToDollars(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number((num / 100).toFixed(2));
}

function normalizeSite(value = '') {
  const site = String(value || '').trim().toLowerCase();
  if (site === "sam's club" || site === 'sams club' || site === 'samclub') return 'samsclub';
  return site;
}

function normalizeSku(value = '') {
  return String(value || '').trim();
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeCanonicalKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function canonicalKeyFromTitle(title, fallbackSite = '', fallbackSku = '') {
  const normalized = normalizeCanonicalKey(title);
  if (normalized && normalized.length >= 8) return normalized;
  return normalizeCanonicalKey(`${fallbackSite}-${fallbackSku}`);
}

function isSuperAdminUser(user, superAdminEmail) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return String(user.email || '').trim().toLowerCase() === String(superAdminEmail || '').trim().toLowerCase();
}

function extractDescription(metadata = {}) {
  return metadata?.description || metadata?.product_description || metadata?.short_description || '';
}

function isPlaceholderPrice(value) {
  const num = Number(value);
  return !Number.isFinite(num) || num >= 900;
}

function parseMoney(value) {
  const text = String(value || '').replace(/[^0-9.]/g, '');
  const num = Number(text);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function absolutizeUrl(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base).toString();
  } catch {
    return String(url || '');
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function flattenJsonLd(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== 'object') return [];
  const graph = Array.isArray(value['@graph']) ? value['@graph'] : [];
  return [value, ...graph.flatMap(flattenJsonLd)];
}

function productInfoFromJsonLd(html, baseUrl) {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]').map((_, el) => $(el).contents().text()).get();
  const items = blocks.flatMap((block) => flattenJsonLd(safeJsonParse(block)));
  const candidates = items.filter((item) => {
    const kind = String(item?.['@type'] || '').toLowerCase();
    return kind.includes('product');
  });
  const item = candidates.find(Boolean) || {};
  const imageValue = Array.isArray(item.image) ? item.image[0] : item.image;
  const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  return {
    title: item.name || '',
    description: item.description || '',
    image_url: absolutizeUrl(imageValue || '', baseUrl),
    product_url: absolutizeUrl(item.url || '', baseUrl),
    price: parseMoney(offer?.price || item.price || '')
  };
}

async function fetchHtml(url) {
  const response = await globalThis.fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) {
    throw new Error(`Lookup failed (${response.status})`);
  }
  return await response.text();
}

async function tryLookupUrls(urls) {
  for (const url of urls.filter(Boolean)) {
    try {
      const html = await fetchHtml(url);
      if (html && html.length > 1000) return { url, html };
    } catch {}
  }
  return null;
}

function extractMeta($, name) {
  return $('meta[property="' + name + '"]').attr('content') || $('meta[name="' + name + '"]').attr('content') || '';
}

async function maybeFetchCatalogProduct(supabase, site, sku) {
  if (!site || !sku) return null;
  const { data } = await supabase
    .from('catalog_products')
    .select('id, site, sku, product_name, image_url, product_url, default_max_price, metadata')
    .eq('site', site)
    .ilike('sku', sku)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    title: data.product_name || '',
    image_url: data.image_url || data.metadata?.image_url || '',
    description: extractDescription(data.metadata),
    product_url: data.product_url || data.metadata?.product_url || '',
    price: Number.isFinite(Number(data.default_max_price)) ? Number(data.default_max_price) : null,
    metadata: data.metadata || {}
  };
}



async function ensureCatalogForSite(supabase, site) {
  if (!site) return null;
  const existing = await supabase
    .from('product_catalogs')
    .select('id, site, name')
    .eq('site', site)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) return existing.data;

  const created = await supabase
    .from('product_catalogs')
    .insert({
      site,
      name: `${site.charAt(0).toUpperCase() + site.slice(1)} webhook cache`,
      is_active: true,
      export_date: new Date().toISOString()
    })
    .select('id, site, name')
    .single();
  if (created.error) throw new Error(created.error.message);
  return created.data;
}

async function cacheCatalogProductFromWebhook({ supabase, site, sku, title, imageUrl, productUrl, description, price, metadata = {} }) {
  const cleanSite = normalizeSite(site);
  const cleanSku = normalizeSku(sku);
  if (!cleanSite || !cleanSku) return { skipped: 'missing_site_or_sku' };

  const meaningfulTitle = normalizeText(title);
  const meaningfulImage = normalizeText(imageUrl);
  const meaningfulUrl = normalizeText(productUrl);
  const meaningfulDescription = normalizeText(description);
  const cleanPrice = Number.isFinite(Number(price)) && !isPlaceholderPrice(price)
    ? Number(Number(price).toFixed(2))
    : null;

  if (!(meaningfulTitle || meaningfulImage || meaningfulUrl || meaningfulDescription || cleanPrice != null)) {
    return { skipped: 'no_product_details' };
  }

  const catalog = await ensureCatalogForSite(supabase, cleanSite);
  const existing = await supabase
    .from('catalog_products')
    .select('*')
    .eq('site', cleanSite)
    .ilike('sku', cleanSku)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const prior = existing.data || {};
  const priorMeta = typeof prior.metadata === 'object' && prior.metadata ? prior.metadata : {};
  const mergedMeta = {
    ...priorMeta,
    ...metadata,
    description: meaningfulDescription || priorMeta.description || '',
    image_url: meaningfulImage || prior.image_url || priorMeta.image_url || '',
    product_url: meaningfulUrl || prior.product_url || priorMeta.product_url || '',
    last_cached_at: new Date().toISOString(),
    source: metadata.source || priorMeta.source || 'webhook_cache'
  };

  const payload = {
    catalog_id: catalog.id,
    site: cleanSite,
    sku: cleanSku,
    product_name: meaningfulTitle || prior.product_name || `${cleanSite.toUpperCase()} ${cleanSku}`,
    brand: prior.brand || cleanSite.charAt(0).toUpperCase() + cleanSite.slice(1),
    image_url: meaningfulImage || prior.image_url || '',
    product_url: meaningfulUrl || prior.product_url || '',
    default_max_price: cleanSite === 'walmart'
      ? (prior.default_max_price ?? null)
      : (cleanPrice ?? prior.default_max_price ?? null),
    credit_cost: prior.credit_cost ?? 0,
    release_mode_default: prior.release_mode_default || 'current',
    is_enabled: prior.is_enabled !== false,
    metadata: mergedMeta,
    updated_at: new Date().toISOString()
  };

  if (prior.id) {
    const updated = await supabase
      .from('catalog_products')
      .update(payload)
      .eq('id', prior.id)
      .select('*')
      .single();
    if (updated.error) throw new Error(updated.error.message);
    return { cached: true, updated: true, product: updated.data };
  }

  const created = await supabase
    .from('catalog_products')
    .insert(payload)
    .select('*')
    .single();
  if (created.error) throw new Error(created.error.message);
  return { cached: true, created: true, product: created.data };
}

async function lookupWebhookCachedProduct(supabase, site, sku) {
  const cleanSite = normalizeSite(site);
  const cleanSku = normalizeSku(sku);
  if (!cleanSite || !cleanSku) return null;

  const orderLookup = await supabase
    .from('orders')
    .select('product_name, raw_payload, metadata')
    .eq('site', cleanSite)
    .ilike('sku', cleanSku)
    .order('created_at', { ascending: false })
    .limit(10);
  if (orderLookup.error) throw new Error(orderLookup.error.message);

  for (const row of orderLookup.data || []) {
    const raw = row.raw_payload || {};
    const meta = row.metadata || {};
    const title = normalizeText(raw.product_name || raw.product?.name || row.product_name || meta.product_name || '');
    const imageUrl = normalizeText(raw.image_url || raw.product?.image_url || meta.image_url || '');
    const productUrl = normalizeText(raw.product_url || raw.url || meta.product_url || '');
    const description = normalizeText(raw.description || raw.product?.description || meta.description || '');
    const price = Number.isFinite(Number(raw.price)) ? Number(raw.price) : null;
    if (title || imageUrl || productUrl || description || price != null) {
      return {
        title,
        image_url: imageUrl,
        description,
        product_url: productUrl,
        price: cleanSite === 'walmart' ? null : price,
        metadata: { source: 'orders_webhook_cache', lookup_strategy: 'orders_cache' }
      };
    }
  }

  const receiptLookup = await supabase
    .from('storefront_receipts')
    .select('receipt_data')
    .eq('site', cleanSite)
    .eq('sku', cleanSku)
    .order('created_at', { ascending: false })
    .limit(10);
  if (receiptLookup.error) throw new Error(receiptLookup.error.message);

  for (const row of receiptLookup.data || []) {
    const receiptData = row.receipt_data || {};
    const raw = receiptData.raw_payload || {};
    const title = normalizeText(raw.product_name || raw.product?.name || receiptData.title || '');
    const imageUrl = normalizeText(raw.image_url || raw.product?.image_url || receiptData.image_url || '');
    const productUrl = normalizeText(raw.product_url || raw.url || receiptData.product_url || '');
    const description = normalizeText(raw.description || receiptData.description || '');
    const price = Number.isFinite(Number(raw.price)) ? Number(raw.price) : null;
    if (title || imageUrl || productUrl || description || price != null) {
      return {
        title,
        image_url: imageUrl,
        description,
        product_url: productUrl,
        price: cleanSite === 'walmart' ? null : price,
        metadata: { source: 'storefront_receipt_cache', lookup_strategy: 'receipt_cache' }
      };
    }
  }

  return null;
}

async function bestEffortLookupBySku(site, sku) {
  const cleanSite = normalizeSite(site);
  const cleanSku = normalizeSku(sku);
  if (!cleanSite || !cleanSku) return null;

  if (cleanSite === 'supreme') {
    return {
      title: `Supreme ${cleanSku}`,
      image_url: '',
      description: '',
      product_url: '',
      price: null,
      metadata: { source: 'manual_supreme' }
    };
  }

  const lookupCandidates = {
    target: [
      `https://www.target.com/p/-/A-${encodeURIComponent(cleanSku)}`,
      `https://www.target.com/s?searchTerm=${encodeURIComponent(cleanSku)}`
    ],
    walmart: [
      `https://www.walmart.com/ip/${encodeURIComponent(cleanSku)}`,
      `https://www.walmart.com/search?q=${encodeURIComponent(cleanSku)}`
    ],
    samsclub: [
      `https://www.samsclub.com/p/${encodeURIComponent(cleanSku)}`,
      `https://www.samsclub.com/s/${encodeURIComponent(cleanSku)}`
    ],
    amazon: [`https://www.amazon.com/s?k=${encodeURIComponent(cleanSku)}`]
  };

  const result = await tryLookupUrls(lookupCandidates[cleanSite] || []);
  if (!result) return null;

  const { url, html } = result;
  const $ = cheerio.load(html);

  if (cleanSite === 'target') {
    const structured = productInfoFromJsonLd(html, 'https://www.target.com');
    let title = structured.title || extractMeta($, 'og:title') || $('a[data-test="product-title"]').first().text().trim() || $('h1').first().text().trim();
    let href = structured.product_url || extractMeta($, 'og:url') || $('link[rel="canonical"]').attr('href') || $('a[data-test="product-title"]').first().attr('href') || url;
    let image = structured.image_url || extractMeta($, 'og:image') || $('img[src*="target.scene7"]').first().attr('src') || $('img').first().attr('src') || '';
    const description = structured.description || extractMeta($, 'description') || '';
    const priceText = structured.price || $('[data-test="current-price"]').first().text().trim() || $('[class*="CurrentPrice"]').first().text().trim();
    return {
      title,
      image_url: absolutizeUrl(image, 'https://www.target.com'),
      description,
      product_url: absolutizeUrl(href, 'https://www.target.com'),
      price: typeof priceText === 'number' ? priceText : parseMoney(priceText),
      metadata: { source: url.includes('/p/-/A-') ? 'target_direct' : 'target_search' }
    };
  }

  if (cleanSite === 'walmart') {
    const structured = productInfoFromJsonLd(html, 'https://www.walmart.com');
    let title = structured.title || extractMeta($, 'og:title') || $('h1').first().text().trim() || $('span[data-automation-id="product-title"]').first().text().trim();
    let href = structured.product_url || extractMeta($, 'og:url') || $('link[rel="canonical"]').attr('href') || $('a[href*="/ip/"]').first().attr('href') || url;
    let image = structured.image_url || extractMeta($, 'og:image') || $('img').filter((_, el) => String($(el).attr('src') || '').includes('i5.walmartimages.com')).first().attr('src') || $('img').first().attr('src') || '';
    const description = structured.description || extractMeta($, 'description') || '';
    return {
      title,
      image_url: absolutizeUrl(image, 'https://www.walmart.com'),
      description,
      product_url: absolutizeUrl(href, 'https://www.walmart.com'),
      price: null,
      metadata: { source: url.includes('/ip/') ? 'walmart_direct' : 'walmart_search' }
    };
  }

  if (cleanSite === 'amazon') {
    const first = $('div[data-component-type="s-search-result"]').first();
    const title = first.find('h2 span').first().text().trim();
    let href = first.find('h2 a').attr('href') || '';
    const image = first.find('img.s-image').attr('src') || '';
    const priceText = first.find('.a-price .a-offscreen').first().text().trim();
    if (href && href.startsWith('/')) href = `https://www.amazon.com${href}`;
    return { title, image_url: image, description: '', product_url: href, price: parseMoney(priceText), metadata: { source: 'amazon_search' } };
  }

  if (cleanSite === 'samsclub') {
    const structured = productInfoFromJsonLd(html, 'https://www.samsclub.com');
    let title = structured.title || extractMeta($, 'og:title') || $('h1').first().text().trim() || $('a[data-testid="product-title"]').first().text().trim();
    let href = structured.product_url || extractMeta($, 'og:url') || $('link[rel="canonical"]').attr('href') || $('a[href*="/p/"]').first().attr('href') || url;
    let image = structured.image_url || extractMeta($, 'og:image') || $('img[src*="image"]').first().attr('src') || $('img').first().attr('src') || '';
    const description = structured.description || extractMeta($, 'description') || '';
    const priceText = structured.price || $('[data-testid="price"]').first().text().trim() || $('[class*="Price"]').first().text().trim();
    return {
      title,
      image_url: absolutizeUrl(image, 'https://www.samsclub.com'),
      description,
      product_url: absolutizeUrl(href, 'https://www.samsclub.com'),
      price: typeof priceText === 'number' ? priceText : parseMoney(priceText),
      metadata: { source: url.includes('/p/') ? 'samsclub_direct' : 'samsclub_search' }
    };
  }

  return null;
}

async function resolveCatalogOrSiteProduct(supabase, site, sku) {
  const cleanSite = normalizeSite(site);
  const cleanSku = normalizeSku(sku);

  const catalog = await maybeFetchCatalogProduct(supabase, cleanSite, cleanSku);
  if (catalog?.title || catalog?.image_url || catalog?.product_url) {
    return { ...catalog, metadata: { ...(catalog.metadata || {}), lookup_strategy: 'catalog' } };
  }

  const webhookCache = await lookupWebhookCachedProduct(supabase, cleanSite, cleanSku);
  if (webhookCache?.title || webhookCache?.image_url || webhookCache?.product_url) {
    return webhookCache;
  }

  if (cleanSite === 'walmart') {
    return {
      title: '',
      image_url: '',
      description: '',
      product_url: cleanSku ? `https://www.walmart.com/ip/${encodeURIComponent(cleanSku)}` : '',
      price: null,
      metadata: {
        source: 'walmart_manual',
        lookup_strategy: 'catalog_webhook_or_manual',
        note: 'Walmart live scraping is disabled. This lookup uses your catalog cache or past webhook/order data first, then falls back to a product URL only.'
      }
    };
  }

  try {
    const siteLookup = await bestEffortLookupBySku(cleanSite, cleanSku);
    return siteLookup || null;
  } catch {
    return webhookCache || catalog || null;
  }
}

async function getPriceOverride(supabase, site, sku) {
  if (!site || !sku) return null;
  const { data } = await supabase
    .from('storefront_price_overrides')
    .select('*')
    .eq('site', site)
    .eq('sku', sku)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

function deriveWebhookPricing(payload = {}, normalized = {}) {
  const quantity = Math.max(1, Number(normalized.quantity || payload.quantity || 1) || 1);

  const explicitUnit = [
    payload.unit_price,
    payload.purchase_unit_price,
    payload.item_price,
    payload.metadata?.unit_price,
    payload.metadata?.purchase_unit_price,
    normalized.unit_price,
    normalized.purchase_unit_price
  ].find((v) => Number.isFinite(Number(v)));

  if (explicitUnit !== undefined) {
    const unitPrice = Number(explicitUnit);
    return {
      quantity,
      purchase_unit_price: unitPrice,
      purchase_total_price: Number((unitPrice * quantity).toFixed(2))
    };
  }

  const rawTotal = [
    payload.price,
    payload.purchase_price,
    normalized.price,
    payload.metadata?.price,
    payload.metadata?.purchase_price
  ].find((v) => Number.isFinite(Number(v)));

  if (rawTotal !== undefined) {
    const totalPrice = Number(rawTotal);
    return {
      quantity,
      purchase_total_price: totalPrice,
      purchase_unit_price: quantity > 0 ? Number((totalPrice / quantity).toFixed(2)) : totalPrice
    };
  }

  return { quantity, purchase_total_price: null, purchase_unit_price: null };
}

async function resolveStorefrontSalePrice({ supabase, site, sku, payload, normalized, siteLookupPrice = null }) {
  const override = await getPriceOverride(supabase, site, sku);
  const pricing = deriveWebhookPricing(payload, normalized);
  const purchaseUnitCents = dollarsToCents(pricing.purchase_unit_price);

  if (override?.sale_price_cents != null) {
    return {
      pricing_source: 'manual_override',
      manual_override_id: override.id,
      sale_price_cents: Number(override.sale_price_cents),
      purchase_unit_price_cents: purchaseUnitCents,
      quantity: pricing.quantity
    };
  }

  if (purchaseUnitCents == null && Number.isFinite(Number(siteLookupPrice))) {
    const livePriceCents = dollarsToCents(siteLookupPrice);
    return {
      pricing_source: 'site_lookup_30pct',
      manual_override_id: null,
      sale_price_cents: livePriceCents != null ? Math.round(livePriceCents * 1.3) : null,
      purchase_unit_price_cents: livePriceCents,
      quantity: pricing.quantity
    };
  }

  if (purchaseUnitCents == null) {
    return {
      pricing_source: 'missing_purchase_price',
      manual_override_id: null,
      sale_price_cents: null,
      purchase_unit_price_cents: null,
      quantity: pricing.quantity
    };
  }

  return {
    pricing_source: 'purchase_plus_30pct',
    manual_override_id: null,
    sale_price_cents: Math.round(purchaseUnitCents * 1.3),
    purchase_unit_price_cents: purchaseUnitCents,
    quantity: pricing.quantity
  };
}

async function findExistingProductForSource({ supabase, site, sku, canonicalKey }) {
  const { data: linkedReceipt } = await supabase
    .from('storefront_receipts')
    .select('storefront_product_id')
    .eq('site', site)
    .eq('sku', sku)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (linkedReceipt?.storefront_product_id) {
    const { data: linkedProduct } = await supabase
      .from('storefront_products')
      .select('*')
      .eq('id', linkedReceipt.storefront_product_id)
      .maybeSingle();
    if (linkedProduct?.id) return linkedProduct;
  }

  if (canonicalKey) {
    const { data: byCanonical } = await supabase
      .from('storefront_products')
      .select('*')
      .eq('canonical_key', canonicalKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byCanonical?.id) return byCanonical;
  }

  return null;
}

async function recalculateProductInventory(supabase, storefrontProductId) {
  const { data: receipts, error: receiptError } = await supabase
    .from('storefront_receipts')
    .select('quantity_purchased, quantity_remaining, purchase_total_price_cents')
    .eq('storefront_product_id', storefrontProductId);
  if (receiptError) throw new Error(receiptError.message);

  const { data: sales, error: salesError } = await supabase
    .from('storefront_sales')
    .select('quantity, sale_subtotal_cents, tax_cents, shipping_cents, total_cents, allocated_cost_cents')
    .eq('storefront_product_id', storefrontProductId);
  if (salesError) throw new Error(salesError.message);

  const totalPurchased = (receipts || []).reduce((sum, row) => sum + Number(row.quantity_purchased || 0), 0);
  const stockOnHand = (receipts || []).reduce((sum, row) => sum + Number(row.quantity_remaining || 0), 0);
  const totalPurchaseCost = (receipts || []).reduce((sum, row) => sum + Number(row.purchase_total_price_cents || 0), 0);
  const totalSold = (sales || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const totalRevenue = (sales || []).reduce((sum, row) => sum + Number(row.sale_subtotal_cents || 0), 0);
  const totalTaxCollected = (sales || []).reduce((sum, row) => sum + Number(row.tax_cents || 0), 0);
  const totalShippingCollected = (sales || []).reduce((sum, row) => sum + Number(row.shipping_cents || 0), 0);
  const totalPayoutGross = (sales || []).reduce((sum, row) => sum + Number(row.total_cents || 0), 0);
  const totalAllocatedCost = (sales || []).reduce((sum, row) => sum + Number(row.allocated_cost_cents || 0), 0);

  const { data: updated, error: updateError } = await supabase
    .from('storefront_products')
    .update({
      total_purchased_qty: totalPurchased,
      total_sold_qty: totalSold,
      stock_on_hand: stockOnHand,
      total_purchase_cost_cents: totalPurchaseCost,
      total_sales_revenue_cents: totalRevenue,
      total_tax_collected_cents: totalTaxCollected,
      total_shipping_collected_cents: totalShippingCollected,
      total_gross_collected_cents: totalPayoutGross,
      total_allocated_cost_cents: totalAllocatedCost,
      updated_at: new Date().toISOString()
    })
    .eq('id', storefrontProductId)
    .select('*')
    .single();

  if (updateError) throw new Error(updateError.message);
  return updated;
}

async function upsertStorefrontProduct({
  supabase,
  site,
  sku,
  title,
  description,
  imageUrl,
  productUrl,
  salePriceCents,
  pricingSource,
  purchaseUnitPriceCents,
  manualPriceOverrideId,
  metadata = {}
}) {
  const canonicalKey = canonicalKeyFromTitle(title, site, sku);
  const existing = await findExistingProductForSource({ supabase, site, sku, canonicalKey });

  const payload = {
    canonical_key: canonicalKey,
    title,
    description: description || '',
    image_url: imageUrl || '',
    primary_site: site,
    primary_sku: sku,
    source_product_url: productUrl || '',
    sale_price_cents: salePriceCents,
    pricing_source: pricingSource,
    purchase_reference_unit_cents: purchaseUnitPriceCents,
    manual_price_override_id: manualPriceOverrideId || null,
    status: 'active',
    metadata
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from('storefront_products')
      .update({
        ...payload,
        title: existing.title || payload.title,
        description: payload.description || existing.description || '',
        image_url: payload.image_url || existing.image_url || '',
        source_product_url: payload.source_product_url || existing.source_product_url || '',
        sale_price_cents: payload.sale_price_cents ?? existing.sale_price_cents,
        pricing_source: payload.pricing_source || existing.pricing_source,
        purchase_reference_unit_cents: payload.purchase_reference_unit_cents ?? existing.purchase_reference_unit_cents,
        manual_price_override_id: payload.manual_price_override_id || existing.manual_price_override_id || null,
        metadata: { ...(existing.metadata || {}), ...(metadata || {}) },
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const { data, error } = await supabase
    .from('storefront_products')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function createReceipt({
  supabase,
  storefrontProductId,
  site,
  sku,
  sourceOrderId,
  sourceUserId,
  quantity,
  purchaseUnitPriceCents,
  purchaseTotalPriceCents,
  receiptData = {}
}) {
  const { data, error } = await supabase
    .from('storefront_receipts')
    .insert({
      storefront_product_id: storefrontProductId,
      site,
      sku,
      source_order_id: sourceOrderId || null,
      source_user_id: sourceUserId || null,
      quantity_purchased: quantity,
      quantity_remaining: quantity,
      purchase_unit_price_cents: purchaseUnitPriceCents,
      purchase_total_price_cents: purchaseTotalPriceCents,
      receipt_data: receiptData,
      purchased_at: new Date().toISOString()
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function maybeCacheWebhookProductFromOrder({ supabase, payload, normalized, user, superAdminEmail }) {
  const site = normalizeSite(normalized.site || payload.site || '');
  const sku = normalizeSku(normalized.sku || payload.sku || payload.product_sku || '');
  if (!site || !sku) return { skipped: 'missing_site_or_sku' };

  const raw = payload || {};
  const rawProduct = raw.product || {};
  const title = normalizeText(
    normalized.product_name || raw.product_name || rawProduct.name || raw.metadata?.product_name || ''
  );
  const imageUrl = normalizeText(
    normalized.image_url || raw.image_url || rawProduct.image_url || raw.metadata?.image_url || ''
  );
  const productUrl = normalizeText(
    normalized.product_url || raw.product_url || raw.url || rawProduct.url || raw.metadata?.product_url || ''
  );
  const description = normalizeText(
    normalized.description || raw.description || rawProduct.description || raw.metadata?.description || ''
  );
  const price = Number.isFinite(Number(raw.purchase_unit_price))
    ? Number(raw.purchase_unit_price)
    : (Number.isFinite(Number(raw.price)) ? Number(raw.price) : null);

  return await cacheCatalogProductFromWebhook({
    supabase,
    site,
    sku,
    title,
    imageUrl,
    productUrl,
    description,
    price,
    metadata: {
      source: 'webhook_cache',
      cached_from_user_id: user?.id || null,
      cached_from_user_email: user?.email || null,
      external_order_id: normalized.external_order_id || raw.external_order_id || null,
      webhook_site: site,
      webhook_sku: sku
    }
  });
}

async function maybeAutoListStorefrontFromOrder({ supabase, payload, normalized, user, superAdminEmail }) {
  if (!isSuperAdminUser(user, superAdminEmail)) {
    return { skipped: 'not_super_admin' };
  }

  const site = normalizeSite(normalized.site || payload.site || '');
  const sku = normalizeSku(normalized.sku || payload.sku || payload.product_sku || '');
  if (!site || !sku) {
    return { skipped: 'missing_site_or_sku' };
  }

  if (site === 'walmart' && String(payload?.status || payload?.order_status || payload?.metadata?.status || '').toLowerCase().includes('cancel')) {
    return { skipped: 'walmart_payload_marked_canceled' };
  }

  const siteProduct = await resolveCatalogOrSiteProduct(supabase, site, sku);
  const pricing = await resolveStorefrontSalePrice({
    supabase,
    site,
    sku,
    payload,
    normalized,
    siteLookupPrice: siteProduct?.price
  });
  if (pricing.sale_price_cents == null) {
    return { skipped: 'could_not_resolve_sale_price', pricing };
  }

  const quantity = Math.max(1, Number(normalized.quantity || payload.quantity || 1) || 1);
  const purchasePricing = deriveWebhookPricing(payload, normalized);
  const purchaseUnitPriceCents = dollarsToCents(purchasePricing.purchase_unit_price) ?? pricing.purchase_unit_price_cents;
  const purchaseTotalPriceCents = dollarsToCents(purchasePricing.purchase_total_price) ?? (purchaseUnitPriceCents != null ? purchaseUnitPriceCents * quantity : null);
  const title = normalizeText(normalized.product_name || siteProduct?.title || `${site.toUpperCase()} ${sku}`);
  const imageUrl = normalizeText(normalized.image_url || siteProduct?.image_url || '');
  const description = normalizeText(siteProduct?.description || normalized.description || '');
  const productUrl = normalizeText(normalized.product_url || siteProduct?.product_url || '');

  const product = await upsertStorefrontProduct({
    supabase,
    site,
    sku,
    title,
    description,
    imageUrl,
    productUrl,
    salePriceCents: pricing.sale_price_cents,
    pricingSource: pricing.pricing_source,
    purchaseUnitPriceCents,
    manualPriceOverrideId: pricing.manual_override_id,
    metadata: {
      auto_listed: true,
      last_source_site: site,
      last_source_sku: sku,
      lookup_source: siteProduct?.metadata?.source || 'catalog_or_fallback'
    }
  });

  const receipt = await createReceipt({
    supabase,
    storefrontProductId: product.id,
    site,
    sku,
    sourceOrderId: normalized.external_order_id,
    sourceUserId: user.id,
    quantity,
    purchaseUnitPriceCents,
    purchaseTotalPriceCents,
    receiptData: {
      webhook_site: site,
      webhook_external_order_id: normalized.external_order_id,
      raw_payload: payload
    }
  });

  const updatedProduct = await recalculateProductInventory(supabase, product.id);
  return { listed: true, product: updatedProduct, receipt, pricing, site_lookup: siteProduct };
}

function shippingTierForQuantity(quantity) {
  if (quantity <= 2) return { label: '1-2 items', amount_cents: 895 };
  if (quantity <= 4) return { label: '3-4 items', amount_cents: 1295 };
  if (quantity <= 10) return { label: '5-10 items', amount_cents: 1995 };
  return { label: '11+ items', amount_cents: 2995 };
}

async function allocateCostFIFO({ supabase, storefrontProductId, quantity }) {
  let remaining = quantity;
  let allocatedCostCents = 0;
  const allocations = [];

  const { data: receipts, error } = await supabase
    .from('storefront_receipts')
    .select('*')
    .eq('storefront_product_id', storefrontProductId)
    .gt('quantity_remaining', 0)
    .order('purchased_at', { ascending: true });
  if (error) throw new Error(error.message);

  for (const receipt of receipts || []) {
    if (remaining <= 0) break;
    const available = Number(receipt.quantity_remaining || 0);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    const unitCost = Number(receipt.purchase_unit_price_cents || 0);
    const newRemaining = available - take;

    const { error: updateError } = await supabase
      .from('storefront_receipts')
      .update({ quantity_remaining: newRemaining, updated_at: new Date().toISOString() })
      .eq('id', receipt.id);
    if (updateError) throw new Error(updateError.message);

    allocatedCostCents += unitCost * take;
    allocations.push({ receipt_id: receipt.id, quantity: take, unit_cost_cents: unitCost });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error('Not enough inventory lots available to allocate this sale');
  }

  return { allocatedCostCents, allocations };
}

async function recordStorefrontSaleFromStripeSession({ supabase, session }) {
  const metadata = session?.metadata || {};
  if (String(metadata.checkout_type || '') !== 'storefront_purchase') {
    return { skipped: 'not_storefront_checkout' };
  }

  const stripeSessionId = String(session.id || '').trim();
  if (!stripeSessionId) {
    return { skipped: 'missing_session_id' };
  }

  const { data: anyExisting } = await supabase
    .from('storefront_sales')
    .select('id, storefront_product_id')
    .eq('stripe_session_id', stripeSessionId)
    .limit(1);
  if (Array.isArray(anyExisting) && anyExisting.length) {
    return { duplicate: true, sale_id: anyExisting[0].id };
  }

  const parsedCart = String(metadata.cart_items || '').trim()
    ? String(metadata.cart_items).split(',').map((entry) => {
        const [productId, qty] = String(entry || '').split(':');
        return {
          storefront_product_id: String(productId || '').trim(),
          quantity: Math.max(1, Number(qty || 1) || 1)
        };
      }).filter((entry) => entry.storefront_product_id)
    : [];

  const saleItems = parsedCart.length
    ? parsedCart
    : [{
        storefront_product_id: String(metadata.storefront_product_id || '').trim(),
        quantity: Math.max(1, Number(metadata.quantity || 1) || 1)
      }].filter((entry) => entry.storefront_product_id);

  if (!saleItems.length) {
    return { skipped: 'missing_product_or_session' };
  }

  const productIds = saleItems.map((entry) => entry.storefront_product_id);
  const { data: productRows, error: productError } = await supabase
    .from('storefront_products')
    .select('*')
    .in('id', productIds);
  if (productError) throw new Error(productError.message);
  const productsById = new Map((productRows || []).map((row) => [String(row.id), row]));

  for (const entry of saleItems) {
    const product = productsById.get(String(entry.storefront_product_id));
    if (!product) throw new Error('Storefront product not found');
    if (entry.quantity > Number(product.stock_on_hand || 0)) {
      throw new Error(`Stripe sale quantity exceeds stock on hand for ${product.title || product.id}`);
    }
  }

  const amountSubtotal = Number(session.amount_subtotal || 0);
  const amountTotal = Number(session.amount_total || 0);
  const shippingCents = Number(session.total_details?.amount_shipping || 0);
  const taxCents = Number(session.total_details?.amount_tax || 0);
  const saleSubtotalExShipping = Math.max(0, amountSubtotal - shippingCents);

  const lineSubtotalByProduct = saleItems.map((entry) => {
    const product = productsById.get(String(entry.storefront_product_id));
    return {
      ...entry,
      product,
      subtotal_cents: Number(product.sale_price_cents || 0) * Number(entry.quantity || 0)
    };
  });
  const subtotalBase = lineSubtotalByProduct.reduce((sum, entry) => sum + Number(entry.subtotal_cents || 0), 0) || 1;

  const shippingAddress = session.customer_details?.address || session.shipping_details?.address || {};
  const insertedSales = [];

  for (let index = 0; index < lineSubtotalByProduct.length; index += 1) {
    const entry = lineSubtotalByProduct[index];
    const isLast = index === lineSubtotalByProduct.length - 1;
    const priorShipping = insertedSales.reduce((sum, row) => sum + Number(row.shipping_cents || 0), 0);
    const priorTax = insertedSales.reduce((sum, row) => sum + Number(row.tax_cents || 0), 0);
    const lineShipping = isLast ? Math.max(0, shippingCents - priorShipping) : Math.round((entry.subtotal_cents / subtotalBase) * shippingCents);
    const lineTax = isLast ? Math.max(0, taxCents - priorTax) : Math.round((entry.subtotal_cents / subtotalBase) * taxCents);
    const saleUnitPriceCents = entry.quantity > 0 ? Math.round(entry.subtotal_cents / entry.quantity) : 0;

    const { allocatedCostCents, allocations } = await allocateCostFIFO({
      supabase,
      storefrontProductId: entry.storefront_product_id,
      quantity: entry.quantity
    });

    const { data: sale, error: saleError } = await supabase
      .from('storefront_sales')
      .insert({
        storefront_product_id: entry.storefront_product_id,
        stripe_session_id: stripeSessionId,
        quantity: entry.quantity,
        sale_unit_price_cents: saleUnitPriceCents,
        sale_subtotal_cents: entry.subtotal_cents,
        shipping_cents: lineShipping,
        tax_cents: lineTax,
        total_cents: entry.subtotal_cents + lineShipping + lineTax,
        allocated_cost_cents: allocatedCostCents,
        customer_email: session.customer_details?.email || session.customer_email || null,
        shipping_zip: shippingAddress.postal_code || null,
        shipping_state: shippingAddress.state || null,
        metadata: {
          stripe_payment_intent: session.payment_intent || null,
          allocations,
          raw_session: session,
          cart_items: saleItems,
          fulfillment_status: 'paid',
          customer_name: session.customer_details?.name || null,
          shipping_name: session.shipping_details?.name || session.customer_details?.name || null,
          shipping_address: shippingAddress
        },
        sold_at: new Date().toISOString()
      })
      .select('*')
      .single();
    if (saleError) throw new Error(saleError.message);
    insertedSales.push(sale);
  }

  await Promise.all(saleItems.map((entry) => recalculateProductInventory(supabase, entry.storefront_product_id)));
  const emailResult = await sendStorefrontOrderConfirmation({ sales: insertedSales });
  return { recorded: true, sales: insertedSales, email: emailResult };
}

function withMoney(product) {
  return {
    ...product,
    sale_price: centsToDollars(product.sale_price_cents),
    stock_on_hand: Number(product.stock_on_hand || 0),
    total_purchase_cost: centsToDollars(product.total_purchase_cost_cents),
    total_sales_revenue: centsToDollars(product.total_sales_revenue_cents),
    total_tax_collected: centsToDollars(product.total_tax_collected_cents),
    total_shipping_collected: centsToDollars(product.total_shipping_collected_cents),
    total_gross_collected: centsToDollars(product.total_gross_collected_cents),
    total_allocated_cost: centsToDollars(product.total_allocated_cost_cents),
    gross_profit: centsToDollars(Number(product.total_sales_revenue_cents || 0) - Number(product.total_allocated_cost_cents || 0))
  };
}

function buildCsv(rows) {
  const escapeCell = (value) => {
    const text = String(value ?? '');
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  return rows.map((row) => row.map(escapeCell).join(',')).join('\n');
}

function loadSeedTargetList() {
  const candidates = [
    path.join(__dirname, 'seed-target-list.json'),
    path.join(process.cwd(), 'seed-target-list.json'),
    path.join(process.cwd(), 'all.json')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
  }
  return null;
}


function htmlEscape(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function mapSalesToOrder(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const first = rows[0] || {};
  const metadata = first.metadata || {};
  return {
    session_id: first.stripe_session_id || first.id,
    order_number: metadata.order_number || first.stripe_session_id || first.id,
    placed_at: first.sold_at || first.created_at,
    customer_email: first.customer_email || '',
    shipping_name: metadata.shipping_name || metadata.customer_name || '',
    subtotal: centsToDollars(rows.reduce((sum, row) => sum + Number(row.sale_subtotal_cents || 0), 0)),
    shipping: centsToDollars(rows.reduce((sum, row) => sum + Number(row.shipping_cents || 0), 0)),
    tax: centsToDollars(rows.reduce((sum, row) => sum + Number(row.tax_cents || 0), 0)),
    total: centsToDollars(rows.reduce((sum, row) => sum + Number(row.total_cents || 0), 0)),
    refunded_total: centsToDollars(rows.reduce((sum, row) => sum + Number(row.metadata?.refunded_amount_cents || 0), 0)),
    remaining_total: centsToDollars(rows.reduce((sum, row) => sum + Math.max(0, Number(row.total_cents || 0) - Number(row.metadata?.refunded_amount_cents || 0)), 0)),
    payment_intent: metadata.stripe_payment_intent || metadata.raw_session?.payment_intent || '',
    status: metadata.fulfillment_status || 'paid',
    tracking_number: metadata.tracking_number || '',
    tracking_carrier: metadata.tracking_carrier || '',
    tracking_url: metadata.tracking_url || '',
    customer_email_status: metadata.customer_confirmation_email_status || 'not_attempted',
    customer_email_sent_at: metadata.customer_confirmation_email_sent_at || '',
    customer_email_error: metadata.customer_confirmation_email_error || '',
    admin_email_status: metadata.admin_sale_email_status || 'not_attempted',
    admin_email_sent_at: metadata.admin_sale_email_sent_at || '',
    admin_email_error: metadata.admin_sale_email_error || '',
    customer_email_subject: metadata.customer_confirmation_email_subject || '',
    customer_email_preview: metadata.customer_confirmation_email_preview || '',
    admin_email_subject: metadata.admin_sale_email_subject || '',
    admin_email_preview: metadata.admin_sale_email_preview || '',
    items: rows.map((row) => {
      const quantity = Number(row.quantity || 0);
      const refundedQuantity = Number(row.metadata?.refunded_quantity || 0);
      return {
        sale_id: row.id,
        product_id: row.storefront_product_id,
        title: row.storefront_products?.title || row.metadata?.product_title || 'Storefront item',
        quantity,
        refunded_quantity: refundedQuantity,
        refundable_quantity: Math.max(0, quantity - refundedQuantity),
        sku: row.storefront_products?.primary_sku || '',
        unit_price: centsToDollars(row.sale_unit_price_cents || 0),
        subtotal: centsToDollars(row.sale_subtotal_cents || 0),
        shipping: centsToDollars(row.shipping_cents || 0),
        tax: centsToDollars(row.tax_cents || 0),
        total: centsToDollars(row.total_cents || 0),
        refunded_amount: centsToDollars(row.metadata?.refunded_amount_cents || 0)
      };
    }),
    refund_history: rows.flatMap((row) => Array.isArray(row.metadata?.refund_history) ? row.metadata.refund_history : [])
  };
}

function registerShopRoutes({
  app,
  supabase,
  stripe,
  auth,
  admin,
  getCurrentUser,
  buildAppUrl,
  sendEmail,
  SUPER_ADMIN_EMAIL,
  validateDiscountCode
}) {
  async function updateSalesEmailMetadata(sales, patch) {
    for (const sale of sales || []) {
      const merged = { ...(sale.metadata || {}), ...patch };
      const { error } = await supabase.from('storefront_sales').update({ metadata: merged }).eq('id', sale.id);
      if (error) console.error('Storefront email metadata update failed:', error.message || error);
      sale.metadata = merged;
    }
  }

  function buildOrderEmailContent(sales = []) {
    const order = mapSalesToOrder(sales);
    const itemLines = (order?.items || []).map((item) => `${item.title} × ${item.quantity}`);
    const itemHtml = (order?.items || []).map((item) => `<li>${htmlEscape(item.title)} × ${Number(item.quantity || 0)}</li>`).join('');
    const orderNumber = order?.order_number || 'Storefront order';
    const total = `$${Number(order?.total || 0).toFixed(2)}`;
    return {
      order,
      customerSubject: `Thank you for your purchase — ${orderNumber}`,
      customerText: ['Thank you for shopping with The Shore Shack.','',`Order: ${orderNumber}`,...itemLines,`Total: ${total}`,'','We received your order and will email tracking information after it ships.'].join('\n'),
      customerHtml: `<h2>Thank you for your purchase!</h2><p>We received your order from The Shore Shack.</p><p><strong>Order:</strong> ${htmlEscape(orderNumber)}</p><ul>${itemHtml}</ul><p><strong>Total:</strong> ${htmlEscape(total)}</p><p>We will email tracking information after your order ships.</p>`,
      adminSubject: `New storefront sale — ${orderNumber}`,
      adminText: ['A new storefront sale was completed.','',`Order: ${orderNumber}`,`Customer: ${order?.customer_email || 'No customer email provided'}`,...itemLines,`Total: ${total}`].join('\n'),
      adminHtml: `<h2>New storefront sale</h2><p><strong>Order:</strong> ${htmlEscape(orderNumber)}</p><p><strong>Customer:</strong> ${htmlEscape(order?.customer_email || 'No customer email provided')}</p><ul>${itemHtml}</ul><p><strong>Total:</strong> ${htmlEscape(total)}</p>`
    };
  }

  async function sendStorefrontOrderConfirmation({ sales = [] }) {
    const content = buildOrderEmailContent(sales);
    const now = new Date().toISOString();
    const customerEmail = String(content.order?.customer_email || '').trim();
    const customer = { attempted: Boolean(customerEmail), success: false, to: customerEmail, error: '' };
    const adminResult = { attempted: Boolean(SUPER_ADMIN_EMAIL), success: false, to: SUPER_ADMIN_EMAIL, error: '' };
    if (customerEmail) {
      try { await sendEmail({ to: customerEmail, subject: content.customerSubject, text: content.customerText, html: content.customerHtml }); customer.success = true; }
      catch (err) { customer.error = err.message || String(err); }
    } else customer.error = 'No customer email was supplied by Stripe.';
    if (SUPER_ADMIN_EMAIL) {
      try { await sendEmail({ to: SUPER_ADMIN_EMAIL, subject: content.adminSubject, text: content.adminText, html: content.adminHtml }); adminResult.success = true; }
      catch (err) { adminResult.error = err.message || String(err); }
    }
    await updateSalesEmailMetadata(sales, {
      customer_confirmation_email_status: customer.success ? 'sent' : 'failed', customer_confirmation_email_sent_at: customer.success ? now : null,
      customer_confirmation_email_error: customer.error || null, customer_confirmation_email_subject: content.customerSubject, customer_confirmation_email_preview: content.customerText,
      admin_sale_email_status: adminResult.success ? 'sent' : 'failed', admin_sale_email_sent_at: adminResult.success ? now : null,
      admin_sale_email_error: adminResult.error || null, admin_sale_email_subject: content.adminSubject, admin_sale_email_preview: content.adminText
    });
    return { customer, admin: adminResult };
  }

  async function sendStorefrontTrackingEmail({ sales = [], trackingNumber, trackingCarrier, trackingUrl }) {
    const order = mapSalesToOrder(sales);
    const to = String(order?.customer_email || '').trim();
    if (!to) return { attempted: false, success: false, error: 'No customer email was supplied by Stripe.' };
    const subject = `Your Shore Shack order has shipped — ${order.order_number || order.session_id}`;
    const text = ['Your order has shipped.','',`Carrier: ${trackingCarrier || 'Carrier not provided'}`,`Tracking number: ${trackingNumber}`,trackingUrl ? `Track your package: ${trackingUrl}` : ''].filter(Boolean).join('\n');
    const html = `<h2>Your order has shipped</h2><p><strong>Carrier:</strong> ${htmlEscape(trackingCarrier || 'Carrier not provided')}</p><p><strong>Tracking number:</strong> ${htmlEscape(trackingNumber)}</p>${trackingUrl ? `<p><a href="${htmlEscape(trackingUrl)}">Track your package</a></p>` : ''}`;
    try { await sendEmail({ to, subject, text, html }); return { attempted: true, success: true, to }; }
    catch (err) { return { attempted: true, success: false, to, error: err.message || String(err) }; }
  }

  app.get('/public/store/products', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('storefront_products')
        .select('*')
        .gt('stock_on_hand', 0)
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });

      const visibleProducts = (data || []).filter((row) => {
        const status = String(row?.status || 'active').trim().toLowerCase();
        return status === 'active' && Number(row?.stock_on_hand || 0) > 0;
      });

      res.json({ products: visibleProducts.map(withMoney) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/store/products', auth, admin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('storefront_products')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ products: (data || []).map(withMoney) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/store/receipts', auth, admin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('storefront_receipts')
        .select('*, storefront_products(title, canonical_key)')
        .order('purchased_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      res.json({
        receipts: (data || []).map((row) => ({
          ...row,
          purchase_unit_price: centsToDollars(row.purchase_unit_price_cents),
          purchase_total_price: centsToDollars(row.purchase_total_price_cents)
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/store/pricing', auth, admin, async (req, res) => {
    try {
      let query = supabase.from('storefront_price_overrides').select('*').order('updated_at', { ascending: false });
      if (req.query.site) query = query.eq('site', normalizeSite(req.query.site));
      if (req.query.sku) query = query.eq('sku', normalizeSku(req.query.sku));
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      res.json({
        overrides: (data || []).map((row) => ({
          ...row,
          sale_price: centsToDollars(row.sale_price_cents)
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/pricing', auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const site = normalizeSite(req.body?.site);
      const sku = normalizeSku(req.body?.sku);
      const salePrice = Number(req.body?.sale_price);
      if (!site || !sku) return res.status(400).json({ error: 'site and sku are required' });
      if (!Number.isFinite(salePrice) || salePrice < 0) return res.status(400).json({ error: 'sale_price must be a valid number' });

      const payload = {
        site,
        sku,
        sale_price_cents: dollarsToCents(salePrice),
        is_active: true,
        created_by_user_id: currentUser.id,
        notes: normalizeText(req.body?.notes) || null,
        updated_at: new Date().toISOString()
      };

      const { data: existing } = await supabase
        .from('storefront_price_overrides')
        .select('id')
        .eq('site', site)
        .eq('sku', sku)
        .maybeSingle();

      let override;
      if (existing?.id) {
        const { data, error } = await supabase
          .from('storefront_price_overrides')
          .update(payload)
          .eq('id', existing.id)
          .select('*')
          .single();
        if (error) return res.status(500).json({ error: error.message });
        override = data;
      } else {
        const { data, error } = await supabase
          .from('storefront_price_overrides')
          .insert(payload)
          .select('*')
          .single();
        if (error) return res.status(500).json({ error: error.message });
        override = data;
      }

      const { data: linkedReceipts } = await supabase
        .from('storefront_receipts')
        .select('storefront_product_id')
        .eq('site', site)
        .eq('sku', sku);
      const productIds = [...new Set((linkedReceipts || []).map((row) => row.storefront_product_id).filter(Boolean))];
      for (const productId of productIds) {
        await supabase
          .from('storefront_products')
          .update({
            sale_price_cents: payload.sale_price_cents,
            pricing_source: 'manual_override',
            manual_price_override_id: override.id,
            updated_at: new Date().toISOString()
          })
          .eq('id', productId);
      }

      res.json({ success: true, override: { ...override, sale_price: centsToDollars(override.sale_price_cents) } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/store/lookup-product', auth, admin, async (req, res) => {
    try {
      const site = normalizeSite(req.query?.site);
      const sku = normalizeSku(req.query?.sku);
      if (!site || !sku) return res.status(400).json({ error: 'site and sku are required' });
      const product = await resolveCatalogOrSiteProduct(supabase, site, sku);
      if (!product || !(product.title || product.image_url || product.product_url)) {
        return res.status(404).json({ error: 'Could not find product details for that site and SKU' });
      }
      const responseProduct = { ...product };
      if (site === 'walmart') responseProduct.price = null;
      res.json({ success: true, product: responseProduct });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/products/manual', auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const site = normalizeSite(req.body?.site || 'manual');
      const sku = normalizeSku(req.body?.sku || req.body?.title || `manual-${Date.now()}`);
      const quantity = Math.max(1, Number(req.body?.quantity || 1) || 1);
      const live = site && sku ? await resolveCatalogOrSiteProduct(supabase, site, sku) : null;

      const title = normalizeText(req.body?.title || live?.title || `${site.toUpperCase()} ${sku}`);
      const imageUrl = normalizeText(req.body?.image_url || live?.image_url || '');
      const description = normalizeText(req.body?.description || live?.description || '');
      const sourceProductUrl = normalizeText(req.body?.source_product_url || live?.product_url || '');
      const shouldUseLivePrice = site !== 'walmart';
      const purchaseUnitPriceCents = req.body?.purchase_unit_price != null ? dollarsToCents(req.body.purchase_unit_price) : (shouldUseLivePrice && live?.price != null ? dollarsToCents(live.price) : null);
      const purchaseTotalPriceCents = purchaseUnitPriceCents != null ? purchaseUnitPriceCents * quantity : null;
      const salePriceCents = req.body?.sale_price != null
        ? dollarsToCents(req.body.sale_price)
        : (purchaseUnitPriceCents != null ? Math.round(purchaseUnitPriceCents * 1.3) : null);

      const product = await upsertStorefrontProduct({
        supabase,
        site,
        sku,
        title,
        description,
        imageUrl,
        productUrl: sourceProductUrl,
        salePriceCents,
        pricingSource: req.body?.sale_price != null ? 'manual_override' : 'purchase_plus_30pct',
        purchaseUnitPriceCents,
        metadata: { manual_entry: true, lookup_source: live?.metadata?.source || null }
      });

      const receipt = await createReceipt({
        supabase,
        storefrontProductId: product.id,
        site,
        sku,
        sourceOrderId: req.body?.source_order_id || null,
        sourceUserId: currentUser.id,
        quantity,
        purchaseUnitPriceCents,
        purchaseTotalPriceCents,
        receiptData: {
          manual_entry: true,
          notes: normalizeText(req.body?.notes)
        }
      });

      const updatedProduct = await recalculateProductInventory(supabase, product.id);
      res.json({ success: true, product: withMoney(updatedProduct), receipt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/admin/store/products/:id', auth, admin, async (req, res) => {
    try {
      const productId = String(req.params.id || '').trim();
      if (!productId) return res.status(400).json({ error: 'product id is required' });

      const { data: existing, error: existingError } = await supabase
        .from('storefront_products')
        .select('*')
        .eq('id', productId)
        .maybeSingle();
      if (existingError || !existing) return res.status(404).json({ error: existingError?.message || 'Product not found' });

      const updates = { updated_at: new Date().toISOString() };
      if (req.body?.title != null) updates.title = normalizeText(req.body.title) || existing.title;
      if (req.body?.description != null) updates.description = normalizeText(req.body.description);
      if (req.body?.image_url != null) updates.image_url = normalizeText(req.body.image_url);
      if (req.body?.source_product_url != null) updates.source_product_url = normalizeText(req.body.source_product_url);
      if (req.body?.status != null) updates.status = normalizeText(req.body.status) || existing.status || 'active';
      if (req.body?.sale_price != null && req.body.sale_price !== '') {
        const salePriceCents = dollarsToCents(req.body.sale_price);
        if (salePriceCents == null) return res.status(400).json({ error: 'sale_price must be a valid number' });
        updates.sale_price_cents = salePriceCents;
        updates.pricing_source = 'manual_override';
      }

      const requestedStock = req.body?.stock_on_hand;
      if (requestedStock != null && requestedStock !== '') {
        const targetStock = Math.max(0, Number(requestedStock) || 0);
        const currentStock = Number(existing.stock_on_hand || 0);
        if (targetStock > currentStock) {
          const delta = targetStock - currentStock;
          await createReceipt({
            supabase,
            storefrontProductId: existing.id,
            site: existing.primary_site || 'manual_adjustment',
            sku: existing.primary_sku || existing.id,
            sourceOrderId: 'MANUAL-STOCK-ADJUSTMENT',
            sourceUserId: null,
            quantity: delta,
            purchaseUnitPriceCents: existing.purchase_reference_unit_cents || null,
            purchaseTotalPriceCents: existing.purchase_reference_unit_cents != null ? Number(existing.purchase_reference_unit_cents) * delta : null,
            receiptData: { manual_stock_adjustment: true, action: 'increase' }
          });
        } else if (targetStock < currentStock) {
          let remove = currentStock - targetStock;
          const { data: receipts, error: receiptError } = await supabase
            .from('storefront_receipts')
            .select('*')
            .eq('storefront_product_id', existing.id)
            .gt('quantity_remaining', 0)
            .order('purchased_at', { ascending: false });
          if (receiptError) return res.status(500).json({ error: receiptError.message });
          for (const receipt of receipts || []) {
            if (remove <= 0) break;
            const available = Number(receipt.quantity_remaining || 0);
            const take = Math.min(remove, available);
            const { error: receiptUpdateError } = await supabase
              .from('storefront_receipts')
              .update({ quantity_remaining: available - take, updated_at: new Date().toISOString() })
              .eq('id', receipt.id);
            if (receiptUpdateError) return res.status(500).json({ error: receiptUpdateError.message });
            remove -= take;
          }
          if (remove > 0) return res.status(400).json({ error: 'Could not reduce stock to the requested amount' });
        }
      }

      const { data: updatedRow, error: updateError } = await supabase
        .from('storefront_products')
        .update(updates)
        .eq('id', existing.id)
        .select('*')
        .single();
      if (updateError) return res.status(500).json({ error: updateError.message });

      const recalculated = await recalculateProductInventory(supabase, existing.id);
      const finalProduct = {
        ...recalculated,
        title: updatedRow.title,
        description: updatedRow.description,
        image_url: updatedRow.image_url,
        source_product_url: updatedRow.source_product_url,
        status: updatedRow.status,
        sale_price_cents: updatedRow.sale_price_cents,
        pricing_source: updatedRow.pricing_source
      };
      res.json({ success: true, product: withMoney(finalProduct) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/products/:id/refresh-details', auth, admin, async (req, res) => {
    try {
      const productId = String(req.params.id || '').trim();
      const { data: existing, error } = await supabase.from('storefront_products').select('*').eq('id', productId).maybeSingle();
      if (error || !existing) return res.status(404).json({ error: error?.message || 'Product not found' });

      const live = await resolveCatalogOrSiteProduct(supabase, existing.primary_site, existing.primary_sku);
      if (!live) return res.status(404).json({ error: 'Could not refresh product details from source site' });

      const { data: updated, error: updateError } = await supabase
        .from('storefront_products')
        .update({
          title: normalizeText(live.title || existing.title),
          description: normalizeText(live.description || existing.description || ''),
          image_url: normalizeText(live.image_url || existing.image_url || ''),
          source_product_url: normalizeText(live.product_url || existing.source_product_url || ''),
          purchase_reference_unit_cents: existing.purchase_reference_unit_cents ?? dollarsToCents(live.price),
          updated_at: new Date().toISOString(),
          metadata: { ...(existing.metadata || {}), last_refresh_lookup_source: live.metadata?.source || null }
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (updateError) return res.status(500).json({ error: updateError.message });
      res.json({ success: true, product: withMoney(updated) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/admin/store/products/:id', auth, admin, async (req, res) => {
    try {
      const productId = String(req.params.id || '').trim();
      const { data: existing, error } = await supabase.from('storefront_products').select('*').eq('id', productId).maybeSingle();
      if (error || !existing) return res.status(404).json({ error: error?.message || 'Product not found' });

      const { data: sales } = await supabase.from('storefront_sales').select('id').eq('storefront_product_id', productId).limit(1);
      if (sales?.length) {
        const { data: updated, error: updateError } = await supabase
          .from('storefront_products')
          .update({ status: 'deleted', updated_at: new Date().toISOString() })
          .eq('id', productId)
          .select('*')
          .single();
        if (updateError) return res.status(500).json({ error: updateError.message });
        return res.json({ success: true, mode: 'soft_delete', product: withMoney(updated) });
      }

      const { error: receiptDeleteError } = await supabase.from('storefront_receipts').delete().eq('storefront_product_id', productId);
      if (receiptDeleteError) return res.status(500).json({ error: receiptDeleteError.message });
      const { error: deleteError } = await supabase.from('storefront_products').delete().eq('id', productId);
      if (deleteError) return res.status(500).json({ error: deleteError.message });
      res.json({ success: true, mode: 'hard_delete' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/products/:id/merge', auth, admin, async (req, res) => {
    try {
      const targetId = String(req.params.id || '');
      const sourceId = String(req.body?.source_product_id || '');
      if (!targetId || !sourceId || targetId === sourceId) {
        return res.status(400).json({ error: 'valid target id and source_product_id are required' });
      }

      const { error: moveReceiptsError } = await supabase
        .from('storefront_receipts')
        .update({ storefront_product_id: targetId, updated_at: new Date().toISOString() })
        .eq('storefront_product_id', sourceId);
      if (moveReceiptsError) return res.status(500).json({ error: moveReceiptsError.message });

      const { error: moveSalesError } = await supabase
        .from('storefront_sales')
        .update({ storefront_product_id: targetId, updated_at: new Date().toISOString() })
        .eq('storefront_product_id', sourceId);
      if (moveSalesError) return res.status(500).json({ error: moveSalesError.message });

      await supabase.from('storefront_products').update({ status: 'merged', updated_at: new Date().toISOString() }).eq('id', sourceId);
      const updated = await recalculateProductInventory(supabase, targetId);
      await recalculateProductInventory(supabase, sourceId).catch(() => null);

      res.json({ success: true, product: withMoney(updated) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/import-target-list', auth, admin, async (req, res) => {
    try {
      const payload = req.body?.products ? req.body : loadSeedTargetList();
      const products = Array.isArray(payload?.products) ? payload.products : [];
      if (!products.length) return res.status(400).json({ error: 'No target products were provided' });

      const imported = [];
      for (const row of products) {
        const site = 'target';
        const sku = normalizeSku(row.sku);
        if (!sku) continue;
        const preset = Number(row.userSetMaxPrice);
        const live = await resolveCatalogOrSiteProduct(supabase, site, sku).catch(() => null);
        const title = normalizeText(live?.title || `TARGET ${sku}`);
        const imageUrl = normalizeText(live?.image_url || '');
        const description = normalizeText(live?.description || '');
        const productUrl = normalizeText(live?.product_url || '');

        const validPreset = !isPlaceholderPrice(preset) ? preset : null;
        if (validPreset != null) {
          await supabase.from('storefront_price_overrides').upsert({
            site,
            sku,
            sale_price_cents: dollarsToCents(validPreset),
            is_active: true,
            updated_at: new Date().toISOString()
          }, { onConflict: 'site,sku' });
        }

        const existing = await findExistingProductForSource({
          supabase,
          site,
          sku,
          canonicalKey: canonicalKeyFromTitle(title, site, sku)
        });

        if (!existing?.id) {
          await supabase.from('storefront_products').insert({
            canonical_key: canonicalKeyFromTitle(title, site, sku),
            title,
            description,
            image_url: imageUrl,
            primary_site: site,
            primary_sku: sku,
            source_product_url: productUrl,
            sale_price_cents: validPreset != null ? dollarsToCents(validPreset) : null,
            pricing_source: validPreset != null ? 'manual_override' : 'pending_inventory',
            stock_on_hand: 0,
            status: 'active',
            metadata: { imported_from_target_seed: true, imported_without_stock: true }
          });
        }

        imported.push({ sku, title, preset_price: validPreset, live_price: live?.price || null });
      }

      res.json({ success: true, imported_count: imported.length, imported });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });



  app.get('/admin/store/orders', auth, admin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('storefront_sales')
        .select('*')
        .order('sold_at', { ascending: false })
        .limit(500);
      if (error) return res.status(500).json({ error: error.message });

      const productIds = [...new Set((data || []).map((row) => row.storefront_product_id).filter(Boolean))];
      let productMap = new Map();
      if (productIds.length) {
        const { data: products, error: productsError } = await supabase.from('storefront_products').select('id, title, image_url, primary_site, primary_sku').in('id', productIds);
        if (productsError) return res.status(500).json({ error: productsError.message });
        productMap = new Map((products || []).map((row) => [String(row.id), row]));
      }
      const hydratedRows = (data || []).map((row) => ({ ...row, storefront_products: productMap.get(String(row.storefront_product_id)) || null }));
      const grouped = new Map();
      for (const row of hydratedRows) {
        const key = String(row.stripe_session_id || row.id);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }

      const orders = Array.from(grouped.values()).map((rows) => mapSalesToOrder(rows)).filter(Boolean);
      const activeOnly = String(req.query.active_only || 'true').toLowerCase() !== 'false';
      const activeStatuses = new Set(['paid', 'processing', 'packed', 'shipped', 'partially_refunded', 'refunded']);
      const filtered = activeOnly ? orders.filter((order) => activeStatuses.has(String(order.status || '').toLowerCase())) : orders;
      res.json({ orders: filtered });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  async function loadHydratedStorefrontOrder(sessionId) {
    const { data: sales, error } = await supabase
      .from('storefront_sales')
      .select('*')
      .eq('stripe_session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    if (!sales || !sales.length) return [];
    const productIds = [...new Set(sales.map((row) => row.storefront_product_id).filter(Boolean))];
    const { data: products, error: productError } = productIds.length
      ? await supabase.from('storefront_products').select('id, title, image_url, primary_site, primary_sku').in('id', productIds)
      : { data: [], error: null };
    if (productError) throw new Error(productError.message);
    const productMap = new Map((products || []).map((row) => [String(row.id), row]));
    return sales.map((row) => ({ ...row, storefront_products: productMap.get(String(row.storefront_product_id)) || null }));
  }

  const REFUND_REASON_LABELS = {
    out_of_stock: 'We ran out of stock before we could fulfill the order',
    pricing_error: 'The item was listed at an incorrect price',
    damaged_inventory: 'The remaining inventory was damaged or unavailable',
    customer_request: 'Refund requested by the customer',
    duplicate_order: 'Duplicate order',
    cannot_fulfill: 'We are unable to fulfill this order',
    other: 'Other'
  };

  async function restoreInventoryForRefund(sale, quantityToRestore) {
    let remaining = Math.max(0, Number(quantityToRestore || 0));
    if (!remaining) return;
    const metadata = sale.metadata || {};
    const allocations = Array.isArray(metadata.allocations) ? metadata.allocations : [];
    const restoredByReceipt = { ...(metadata.refund_restored_by_receipt || {}) };
    for (const allocation of allocations) {
      if (remaining <= 0) break;
      const receiptId = String(allocation.receipt_id || '');
      if (!receiptId) continue;
      const allocated = Number(allocation.quantity || 0);
      const alreadyRestored = Number(restoredByReceipt[receiptId] || 0);
      const available = Math.max(0, allocated - alreadyRestored);
      const take = Math.min(remaining, available);
      if (!take) continue;
      const { data: receipt, error: readError } = await supabase.from('storefront_receipts').select('quantity_remaining').eq('id', receiptId).single();
      if (readError) throw new Error(readError.message);
      const { error: updateError } = await supabase.from('storefront_receipts').update({
        quantity_remaining: Number(receipt?.quantity_remaining || 0) + take,
        updated_at: new Date().toISOString()
      }).eq('id', receiptId);
      if (updateError) throw new Error(updateError.message);
      restoredByReceipt[receiptId] = alreadyRestored + take;
      remaining -= take;
    }
    if (remaining > 0) throw new Error('Could not restore all refunded units to their inventory receipts');
    return restoredByReceipt;
  }

  async function sendStorefrontRefundEmail({ sales, refundAmountCents, reasonLabel, refundedItems, fullOrder }) {
    const order = mapSalesToOrder(sales);
    const to = String(order?.customer_email || '').trim();
    if (!to) return { attempted: false, success: false, error: 'No customer email was supplied by Stripe.' };
    const amount = `$${(Number(refundAmountCents || 0) / 100).toFixed(2)}`;
    const itemLines = (refundedItems || []).map((item) => `${item.title} × ${item.quantity}`).join('\n');
    const subject = `${fullOrder ? 'Order refund' : 'Partial refund'} — ${order.order_number || order.session_id}`;
    const text = [
      `We issued a ${fullOrder ? 'full' : 'partial'} refund for your Shore Shack order.`,
      '',
      `Order: ${order.order_number || order.session_id}`,
      `Refund amount: ${amount}`,
      `Reason: ${reasonLabel}`,
      itemLines ? `Refunded items:\n${itemLines}` : '',
      '',
      'The refund has been submitted to your original payment method. Your bank may take several business days to post it.'
    ].filter(Boolean).join('\n');
    const htmlItems = (refundedItems || []).map((item) => `<li>${htmlEscape(item.title)} × ${Number(item.quantity || 0)}</li>`).join('');
    const html = `<h2>${fullOrder ? 'Order refund' : 'Partial refund'} issued</h2><p><strong>Order:</strong> ${htmlEscape(order.order_number || order.session_id)}</p><p><strong>Refund amount:</strong> ${htmlEscape(amount)}</p><p><strong>Reason:</strong> ${htmlEscape(reasonLabel)}</p>${htmlItems ? `<p><strong>Refunded items:</strong></p><ul>${htmlItems}</ul>` : ''}<p>The refund was submitted to your original payment method. Your bank may take several business days to post it.</p>`;
    try {
      await sendEmail({ to, subject, text, html });
      return { attempted: true, success: true, to, subject, preview: text };
    } catch (err) {
      return { attempted: true, success: false, to, subject, preview: text, error: err.message || String(err) };
    }
  }

  app.post('/admin/store/orders/:sessionId/refund', auth, admin, async (req, res) => {
    try {
      if (!stripe) return res.status(400).json({ error: 'Stripe is not configured yet' });
      const sessionId = String(req.params.sessionId || '').trim();
      const fullOrder = req.body?.full_order === true;
      const reasonCode = String(req.body?.reason_code || 'other').trim();
      const customReason = normalizeText(req.body?.custom_reason);
      const reasonLabel = reasonCode === 'other' && customReason ? customReason : (REFUND_REASON_LABELS[reasonCode] || customReason || REFUND_REASON_LABELS.other);
      const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const sales = await loadHydratedStorefrontOrder(sessionId);
      if (!sales.length) return res.status(404).json({ error: 'Order not found' });
      const paymentIntent = sales[0]?.metadata?.stripe_payment_intent || sales[0]?.metadata?.raw_session?.payment_intent;
      if (!paymentIntent) return res.status(400).json({ error: 'Stripe payment intent was not stored for this order' });

      const requestedBySale = new Map(requestedItems.map((item) => [String(item.sale_id || ''), Math.max(0, Number(item.quantity || 0) || 0)]));
      const calculations = [];
      for (const sale of sales) {
        const originalQty = Number(sale.quantity || 0);
        const alreadyRefundedQty = Number(sale.metadata?.refunded_quantity || 0);
        const refundableQty = Math.max(0, originalQty - alreadyRefundedQty);
        const qty = fullOrder ? refundableQty : Math.min(refundableQty, requestedBySale.get(String(sale.id)) || 0);
        if (!qty) continue;
        const subtotal = fullOrder && qty === refundableQty
          ? Math.max(0, Number(sale.sale_subtotal_cents || 0) - Number(sale.metadata?.refunded_subtotal_cents || 0))
          : Math.min(Math.max(0, Number(sale.sale_subtotal_cents || 0) - Number(sale.metadata?.refunded_subtotal_cents || 0)), Math.round((Number(sale.sale_subtotal_cents || 0) / Math.max(1, originalQty)) * qty));
        const tax = fullOrder && qty === refundableQty
          ? Math.max(0, Number(sale.tax_cents || 0) - Number(sale.metadata?.refunded_tax_cents || 0))
          : Math.min(Math.max(0, Number(sale.tax_cents || 0) - Number(sale.metadata?.refunded_tax_cents || 0)), Math.round((Number(sale.tax_cents || 0) / Math.max(1, originalQty)) * qty));
        const shipping = fullOrder ? Math.max(0, Number(sale.shipping_cents || 0) - Number(sale.metadata?.refunded_shipping_cents || 0)) : 0;
        calculations.push({ sale, qty, subtotal, tax, shipping, amount: subtotal + tax + shipping });
      }
      if (!calculations.length) return res.status(400).json({ error: 'Select at least one refundable item quantity' });
      const refundAmountCents = calculations.reduce((sum, row) => sum + row.amount, 0);
      if (refundAmountCents <= 0) return res.status(400).json({ error: 'This order has no refundable balance remaining' });

      const refund = await stripe.refunds.create({
        payment_intent: paymentIntent,
        amount: refundAmountCents,
        reason: reasonCode === 'customer_request' ? 'requested_by_customer' : undefined,
        metadata: { storefront_session_id: sessionId, reason_code: reasonCode, reason: reasonLabel.slice(0, 450) }
      });
      const now = new Date().toISOString();
      const refundedItems = [];
      for (const calc of calculations) {
        const sale = calc.sale;
        const restoredByReceipt = await restoreInventoryForRefund(sale, calc.qty);
        const historyEntry = {
          at: now,
          stripe_refund_id: refund.id,
          quantity: calc.qty,
          subtotal_cents: calc.subtotal,
          tax_cents: calc.tax,
          shipping_cents: calc.shipping,
          amount_cents: calc.amount,
          reason_code: reasonCode,
          reason: reasonLabel,
          full_order: fullOrder
        };
        const metadata = {
          ...(sale.metadata || {}),
          refunded_quantity: Number(sale.metadata?.refunded_quantity || 0) + calc.qty,
          refunded_subtotal_cents: Number(sale.metadata?.refunded_subtotal_cents || 0) + calc.subtotal,
          refunded_tax_cents: Number(sale.metadata?.refunded_tax_cents || 0) + calc.tax,
          refunded_shipping_cents: Number(sale.metadata?.refunded_shipping_cents || 0) + calc.shipping,
          refunded_amount_cents: Number(sale.metadata?.refunded_amount_cents || 0) + calc.amount,
          refund_restored_by_receipt: restoredByReceipt,
          refund_history: [...(Array.isArray(sale.metadata?.refund_history) ? sale.metadata.refund_history : []), historyEntry],
          fulfillment_status: fullOrder ? 'refunded' : 'partially_refunded'
        };
        const { error: updateError } = await supabase.from('storefront_sales').update({ metadata }).eq('id', sale.id);
        if (updateError) throw new Error(updateError.message);
        sale.metadata = metadata;
        refundedItems.push({ title: sale.storefront_products?.title || 'Storefront item', quantity: calc.qty, amount: centsToDollars(calc.amount) });
        await recalculateProductInventory(supabase, sale.storefront_product_id);
      }
      const email = await sendStorefrontRefundEmail({ sales, refundAmountCents, reasonLabel, refundedItems, fullOrder });
      await updateSalesEmailMetadata(sales, {
        refund_email_status: email.success ? 'sent' : 'failed',
        refund_email_sent_at: email.success ? now : null,
        refund_email_error: email.error || null,
        refund_email_subject: email.subject || null,
        refund_email_preview: email.preview || null
      });
      res.json({ success: true, refund: { id: refund.id, amount: centsToDollars(refundAmountCents), status: refund.status }, email, order: mapSalesToOrder(sales) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/orders/:sessionId/tracking', auth, admin, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim();
      if (!sessionId) return res.status(400).json({ error: 'Order session id is required' });
      const trackingNumber = normalizeText(req.body?.tracking_number);
      const trackingCarrier = normalizeText(req.body?.tracking_carrier);
      const trackingUrl = normalizeText(req.body?.tracking_url);
      const fulfillmentStatus = normalizeText(req.body?.status || 'shipped') || 'shipped';
      if (!trackingNumber) return res.status(400).json({ error: 'Tracking number is required' });

      const { data: sales, error } = await supabase
        .from('storefront_sales')
        .select('*')
        .eq('stripe_session_id', sessionId)
        .order('created_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      if (!sales || !sales.length) return res.status(404).json({ error: 'Order not found' });

      for (const sale of sales) {
        const mergedMetadata = {
          ...(sale.metadata || {}),
          tracking_number: trackingNumber,
          tracking_carrier: trackingCarrier,
          tracking_url: trackingUrl,
          fulfillment_status: fulfillmentStatus,
          tracking_updated_at: new Date().toISOString()
        };
        const { error: updateError } = await supabase
          .from('storefront_sales')
          .update({ metadata: mergedMetadata })
          .eq('id', sale.id);
        if (updateError) return res.status(500).json({ error: updateError.message });
      }

      const refreshed = sales.map((sale) => ({
        ...sale,
        metadata: {
          ...(sale.metadata || {}),
          tracking_number: trackingNumber,
          tracking_carrier: trackingCarrier,
          tracking_url: trackingUrl,
          fulfillment_status: fulfillmentStatus,
          tracking_updated_at: new Date().toISOString()
        }
      }));
      const emailResult = await sendStorefrontTrackingEmail({
        sales: refreshed,
        trackingNumber,
        trackingCarrier,
        trackingUrl
      });
      res.json({ success: true, order: mapSalesToOrder(refreshed), email: emailResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/store/orders/:sessionId/resend-confirmation', auth, admin, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim();
      const { data: sales, error } = await supabase.from('storefront_sales').select('*').eq('stripe_session_id', sessionId).order('created_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      if (!sales || !sales.length) return res.status(404).json({ error: 'Order not found' });
      const productIds = [...new Set(sales.map((row) => row.storefront_product_id).filter(Boolean))];
      const { data: products } = productIds.length ? await supabase.from('storefront_products').select('id, title, image_url, primary_site, primary_sku').in('id', productIds) : { data: [] };
      const map = new Map((products || []).map((row) => [String(row.id), row]));
      const hydrated = sales.map((row) => ({ ...row, storefront_products: map.get(String(row.storefront_product_id)) || null }));
      const email = await sendStorefrontOrderConfirmation({ sales: hydrated });
      res.json({ success: true, email, order: mapSalesToOrder(hydrated) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/admin/store/accounting/summary', auth, admin, async (req, res) => {
    try {
      const { data: products, error } = await supabase.from('storefront_products').select('*').neq('status', 'merged');
      if (error) return res.status(500).json({ error: error.message });

      const rows = (products || []).map(withMoney);
      const summary = rows.reduce((acc, row) => {
        acc.total_purchase_cost += row.total_purchase_cost;
        acc.total_sales_revenue += row.total_sales_revenue;
        acc.total_tax_collected += row.total_tax_collected;
        acc.total_shipping_collected += row.total_shipping_collected;
        acc.total_gross_collected += row.total_gross_collected;
        acc.total_allocated_cost += row.total_allocated_cost;
        acc.stock_units += Number(row.stock_on_hand || 0);
        acc.gross_profit += row.gross_profit;
        return acc;
      }, {
        total_purchase_cost: 0,
        total_sales_revenue: 0,
        total_tax_collected: 0,
        total_shipping_collected: 0,
        total_gross_collected: 0,
        total_allocated_cost: 0,
        stock_units: 0,
        gross_profit: 0
      });

      res.json({ summary, products: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/store/accounting/export.csv', auth, admin, async (req, res) => {
    try {
      const { data: products, error } = await supabase.from('storefront_products').select('*').neq('status', 'merged').order('title', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      const rows = (products || []).map(withMoney);
      const csv = buildCsv([
        ['title', 'primary_site', 'primary_sku', 'stock_on_hand', 'total_purchased_qty', 'total_sold_qty', 'sale_price', 'purchase_cost_total', 'sales_revenue_total', 'tax_collected_total', 'shipping_collected_total', 'gross_collected_total', 'allocated_cost_total', 'gross_profit'],
        ...rows.map((row) => [
          row.title,
          row.primary_site,
          row.primary_sku,
          row.stock_on_hand,
          row.total_purchased_qty,
          row.total_sold_qty,
          row.sale_price,
          row.total_purchase_cost,
          row.total_sales_revenue,
          row.total_tax_collected,
          row.total_shipping_collected,
          row.total_gross_collected,
          row.total_allocated_cost,
          row.gross_profit
        ])
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="storefront-accounting.csv"');
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


app.post('/public/store/checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured yet' });

    const requestedItems = Array.isArray(req.body?.items) && req.body.items.length
      ? req.body.items
      : [{
          product_id: req.body?.product_id || req.body?.storefront_product_id || req.body?.inventory_id,
          quantity: req.body?.quantity || 1
        }];

    const normalizedItems = requestedItems
      .map((entry) => ({
        product_id: String(entry?.product_id || '').trim(),
        quantity: Math.max(1, Number(entry?.quantity || 1) || 1)
      }))
      .filter((entry) => entry.product_id);

    if (!normalizedItems.length) {
      return res.status(400).json({ error: 'At least one product is required for checkout' });
    }

    const grouped = new Map();
    for (const entry of normalizedItems) {
      const current = grouped.get(entry.product_id) || 0;
      grouped.set(entry.product_id, current + entry.quantity);
    }
    const compactItems = Array.from(grouped.entries()).map(([product_id, quantity]) => ({ product_id, quantity }));
    const productIds = compactItems.map((entry) => entry.product_id);

    const { data: items, error } = await supabase
      .from('storefront_products')
      .select('*')
      .in('id', productIds)
      .eq('status', 'active');
    if (error) return res.status(500).json({ error: error.message });
    const productsById = new Map((items || []).map((item) => [String(item.id), item]));
    if (productsById.size !== compactItems.length) {
      return res.status(404).json({ error: 'One or more products could not be found' });
    }

    const lineItems = [];
    let totalQuantity = 0;
    let subtotalDollars = 0;
    for (const entry of compactItems) {
      const item = productsById.get(entry.product_id);
      if (entry.quantity > Number(item.stock_on_hand || 0)) {
        return res.status(400).json({ error: `Not enough inventory available for ${item.title}` });
      }
      if (!Number.isFinite(Number(item.sale_price_cents)) || Number(item.sale_price_cents) <= 0) {
        return res.status(400).json({ error: `${item.title} does not have a valid sale price yet` });
      }
      totalQuantity += entry.quantity;
      subtotalDollars += centsToDollars(Number(item.sale_price_cents) * entry.quantity);
      lineItems.push({
        quantity: entry.quantity,
        price_data: {
          currency: process.env.STRIPE_CURRENCY || 'usd',
          unit_amount: Number(item.sale_price_cents),
          product_data: {
            name: item.title,
            description: item.description || `${item.primary_site} SKU ${item.primary_sku}`,
            images: item.image_url ? [item.image_url] : []
          }
        }
      });
    }

    const shipping = shippingTierForQuantity(totalQuantity);
    const discountCode = String(req.body?.discount_code || '').trim().toUpperCase();
    const customerEmail = String(req.body?.customer_email || '').trim().toLowerCase();

    let validatedDiscount = null;
    if (discountCode && typeof validateDiscountCode === 'function') {
      validatedDiscount = await validateDiscountCode({
        code: discountCode,
        cartTotal: subtotalDollars,
        shippingTotal: centsToDollars(shipping.amount_cents),
        email: customerEmail
      });
      if (!validatedDiscount.ok) {
        return res.status(400).json({ error: validatedDiscount.error });
      }
    }

    if (!(validatedDiscount?.discount?.type === 'free_shipping')) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: process.env.STRIPE_CURRENCY || 'usd',
          unit_amount: shipping.amount_cents,
          product_data: { name: `Shipping (${shipping.label})` }
        }
      });
    }

    let discounts = undefined;
    if (validatedDiscount?.discount?.type === 'percent') {
      const coupon = await stripe.coupons.create({
        duration: 'once',
        percent_off: Number(validatedDiscount.discount.value),
        name: `${validatedDiscount.code} ${validatedDiscount.discount.value}% off`
      });
      discounts = [{ coupon: coupon.id }];
    } else if (validatedDiscount?.discount?.type === 'fixed') {
      const coupon = await stripe.coupons.create({
        duration: 'once',
        amount_off: dollarsToCents(validatedDiscount.discount.value),
        currency: process.env.STRIPE_CURRENCY || 'usd',
        name: `${validatedDiscount.code} $${Number(validatedDiscount.discount.value).toFixed(2)} off`
      });
      discounts = [{ coupon: coupon.id }];
    }

    const successUrl = buildAppUrl('/shop.html?checkout=success');
    const cancelUrl = buildAppUrl('/shop.html?checkout=cancel');
    const compactMetadata = compactItems.map((entry) => `${entry.product_id}:${entry.quantity}`).join(',');
    const firstItem = productsById.get(compactItems[0].product_id);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_creation: 'always',
      customer_email: customerEmail || undefined,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: true },
      line_items: lineItems,
      discounts,
      metadata: {
        checkout_type: 'storefront_purchase',
        storefront_product_id: String(firstItem.id),
        site: String(firstItem.primary_site || ''),
        sku: String(firstItem.primary_sku || ''),
        quantity: String(compactItems[0].quantity),
        cart_items: compactMetadata,
        discount_code: validatedDiscount?.code || '',
        customer_email: customerEmail || ''
      }
    });

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

return {

    maybeCacheWebhookProductFromOrder: async ({ payload, normalized, user }) =>
      maybeCacheWebhookProductFromOrder({
        supabase,
        payload,
        normalized,
        user,
        superAdminEmail: SUPER_ADMIN_EMAIL
      }),
    maybeAutoListStorefrontFromOrder: async ({ payload, normalized, user }) =>
      maybeAutoListStorefrontFromOrder({
        supabase,
        payload,
        normalized,
        user,
        superAdminEmail: SUPER_ADMIN_EMAIL
      }),
    recordStorefrontSaleFromStripeSession: async (session) =>
      recordStorefrontSaleFromStripeSession({ supabase, session })
  };
}

module.exports = registerShopRoutes;
