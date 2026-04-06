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
  return String(value || '').trim().toLowerCase();
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

  const searchUrls = {
    target: `https://www.target.com/s?searchTerm=${encodeURIComponent(cleanSku)}`,
    walmart: `https://www.walmart.com/search?q=${encodeURIComponent(cleanSku)}`,
    samsclub: `https://www.samsclub.com/s/${encodeURIComponent(cleanSku)}`,
    'sam\'s club': `https://www.samsclub.com/s/${encodeURIComponent(cleanSku)}`,
    amazon: `https://www.amazon.com/s?k=${encodeURIComponent(cleanSku)}`
  };

  const url = searchUrls[cleanSite];
  if (!url) return null;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  if (cleanSite === 'target') {
    const structured = productInfoFromJsonLd(html, 'https://www.target.com');
    let title = structured.title || $('a[data-test="product-title"]').first().text().trim();
    let href = structured.product_url || $('a[data-test="product-title"]').first().attr('href') || $('meta[property="og:url"]').attr('content') || '';
    let image = structured.image_url || $('meta[property="og:image"]').attr('content') || $('img[alt]').filter((_, el) => ($(el).attr('alt') || '').trim() === title).first().attr('src') || '';
    let priceText = structured.price || $('[data-test="current-price"]').first().text().trim() || $('[class*="styles__CurrentPriceFontSize"]').first().text().trim();
    if (href && href.startsWith('/')) href = `https://www.target.com${href}`;
    if (image) image = absolutizeUrl(image, 'https://www.target.com');
    return {
      title,
      image_url: image,
      description: structured.description || $('meta[name="description"]').attr('content') || '',
      product_url: href,
      price: typeof priceText === 'number' ? priceText : parseMoney(priceText),
      metadata: { source: 'target_search' }
    };
  }

  if (cleanSite === 'walmart') {
    const structured = productInfoFromJsonLd(html, 'https://www.walmart.com');
    let title = structured.title || $('a[data-testid="product-title"]').first().text().trim() || $('span[data-automation-id="product-title"]').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
    let href = structured.product_url || $('a[data-testid="product-title"]').first().attr('href') || $('a[href*="/ip/"]').first().attr('href') || $('meta[property="og:url"]').attr('content') || '';
    let image = structured.image_url || $('meta[property="og:image"]').attr('content') || $('img[data-testid="productTileImage"]').first().attr('src') || $('img[loading="lazy"]').first().attr('src') || '';
    let priceText = structured.price || $('[data-automation-id="product-price"]').first().text().trim() || $('div[data-testid="price-wrap"] span').first().text().trim();
    if (href && href.startsWith('/')) href = `https://www.walmart.com${href}`;
    if (image) image = absolutizeUrl(image, 'https://www.walmart.com');
    return {
      title,
      image_url: image,
      description: structured.description || $('meta[name="description"]').attr('content') || '',
      product_url: href,
      price: typeof priceText === 'number' ? priceText : parseMoney(priceText),
      metadata: { source: 'walmart_search' }
    };
  }

  if (cleanSite === 'amazon') {
    const first = $('div[data-component-type="s-search-result"]').first();
    const title = first.find('h2 span').first().text().trim();
    let href = first.find('h2 a').attr('href') || '';
    const image = first.find('img.s-image').attr('src') || '';
    const priceText = first.find('.a-price .a-offscreen').first().text().trim();
    if (href && href.startsWith('/')) href = `https://www.amazon.com${href}`;
    return {
      title,
      image_url: image,
      description: '',
      product_url: href,
      price: parseMoney(priceText),
      metadata: { source: 'amazon_search' }
    };
  }

  if (cleanSite === 'samsclub' || cleanSite === "sam's club") {
    const title = $('a[data-testid="product-title"]').first().text().trim() || $('img[alt]').first().attr('alt') || '';
    let href = $('a[href*="/p/"]').first().attr('href') || '';
    const image = $('img').filter((_, el) => String($(el).attr('src') || '').includes('image')).first().attr('src') || '';
    const priceText = $('[data-testid="price"]').first().text().trim();
    if (href && href.startsWith('/')) href = `https://www.samsclub.com${href}`;
    return {
      title,
      image_url: image,
      description: '',
      product_url: href,
      price: parseMoney(priceText),
      metadata: { source: 'samsclub_search' }
    };
  }

  return null;
}

async function resolveCatalogOrSiteProduct(supabase, site, sku) {
  const catalog = await maybeFetchCatalogProduct(supabase, site, sku);
  if (catalog?.title || catalog?.image_url) return catalog;
  try {
    const siteLookup = await bestEffortLookupBySku(site, sku);
    return siteLookup || null;
  } catch {
    return catalog || null;
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

  const storefrontProductId = String(metadata.storefront_product_id || '').trim();
  const quantity = Math.max(1, Number(metadata.quantity || 1) || 1);
  const stripeSessionId = String(session.id || '').trim();
  if (!storefrontProductId || !stripeSessionId) {
    return { skipped: 'missing_product_or_session' };
  }

  const { data: existing } = await supabase
    .from('storefront_sales')
    .select('id')
    .eq('stripe_session_id', stripeSessionId)
    .maybeSingle();
  if (existing?.id) return { duplicate: true, sale_id: existing.id };

  const { data: product, error: productError } = await supabase
    .from('storefront_products')
    .select('*')
    .eq('id', storefrontProductId)
    .maybeSingle();
  if (productError || !product) throw new Error(productError?.message || 'Storefront product not found');

  if (quantity > Number(product.stock_on_hand || 0)) {
    throw new Error('Stripe sale quantity exceeds stock on hand');
  }

  const amountSubtotal = Number(session.amount_subtotal || 0);
  const amountTotal = Number(session.amount_total || 0);
  const shippingCents = Number(session.total_details?.amount_shipping || 0);
  const taxCents = Number(session.total_details?.amount_tax || 0);
  const saleSubtotalExShipping = Math.max(0, amountSubtotal - shippingCents);
  const saleUnitPriceCents = quantity > 0 ? Math.round(saleSubtotalExShipping / quantity) : 0;

  const { allocatedCostCents, allocations } = await allocateCostFIFO({
    supabase,
    storefrontProductId,
    quantity
  });

  const shippingAddress = session.customer_details?.address || session.shipping_details?.address || {};

  const { data: sale, error: saleError } = await supabase
    .from('storefront_sales')
    .insert({
      storefront_product_id: storefrontProductId,
      stripe_session_id: stripeSessionId,
      quantity,
      sale_unit_price_cents: saleUnitPriceCents,
      sale_subtotal_cents: saleSubtotalExShipping,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      total_cents: amountTotal,
      allocated_cost_cents: allocatedCostCents,
      customer_email: session.customer_details?.email || session.customer_email || null,
      shipping_zip: shippingAddress.postal_code || null,
      shipping_state: shippingAddress.state || null,
      metadata: {
        stripe_payment_intent: session.payment_intent || null,
        allocations,
        raw_session: session
      },
      sold_at: new Date().toISOString()
    })
    .select('*')
    .single();
  if (saleError) throw new Error(saleError.message);

  const updatedProduct = await recalculateProductInventory(supabase, storefrontProductId);
  return { recorded: true, sale, product: updatedProduct };
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

function registerShopRoutes({
  app,
  supabase,
  stripe,
  auth,
  admin,
  getCurrentUser,
  buildAppUrl,
  SUPER_ADMIN_EMAIL
}) {
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
      const purchaseUnitPriceCents = req.body?.purchase_unit_price != null ? dollarsToCents(req.body.purchase_unit_price) : (live?.price != null ? dollarsToCents(live.price) : null);
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
      const productId = req.body?.product_id || req.body?.storefront_product_id || req.body?.inventory_id;
      const quantity = Math.max(1, Number(req.body?.quantity || 1) || 1);

      const { data: item, error } = await supabase
        .from('storefront_products')
        .select('*')
        .eq('id', productId)
        .eq('status', 'active')
        .single();
      if (error || !item) return res.status(404).json({ error: 'Product not found' });
      if (quantity > Number(item.stock_on_hand || 0)) return res.status(400).json({ error: 'Not enough inventory available' });
      if (!Number.isFinite(Number(item.sale_price_cents)) || Number(item.sale_price_cents) <= 0) {
        return res.status(400).json({ error: 'This product does not have a valid sale price yet' });
      }

      const shipping = shippingTierForQuantity(quantity);
      const successUrl = buildAppUrl('/shop.html?checkout=success');
      const cancelUrl = buildAppUrl('/shop.html?checkout=cancel');

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        shipping_address_collection: { allowed_countries: ['US'] },
        automatic_tax: { enabled: true },
        line_items: [
          {
            quantity,
            price_data: {
              currency: process.env.STRIPE_CURRENCY || 'usd',
              unit_amount: Number(item.sale_price_cents),
              product_data: {
                name: item.title,
                description: item.description || `${item.primary_site} SKU ${item.primary_sku}`,
                images: item.image_url ? [item.image_url] : []
              }
            }
          },
          {
            quantity: 1,
            price_data: {
              currency: process.env.STRIPE_CURRENCY || 'usd',
              unit_amount: shipping.amount_cents,
              product_data: {
                name: `Shipping (${shipping.label})`
              }
            }
          }
        ],
        metadata: {
          checkout_type: 'storefront_purchase',
          storefront_product_id: String(item.id),
          site: String(item.primary_site || ''),
          sku: String(item.primary_sku || ''),
          quantity: String(quantity)
        }
      });

      res.json({ url: session.url, id: session.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return {
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
