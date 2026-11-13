'use strict';

function parseRetailMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/(?:\$\s*)?([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}

const PRICE_KEYS = [
  'current_retail',
  'currentRetail',
  'formatted_current_price',
  'formattedCurrentPrice',
  'current_price',
  'currentPrice',
  'reg_retail',
  'regRetail',
  'regular_price',
  'regularPrice',
  'retail_price',
  'retailPrice',
  'offerPrice',
  'price'
];

const SKU_KEYS = new Set(['tcin', 'sku', 'product_id', 'productId', 'item_id', 'itemId']);

function objectContainsSku(value, sku) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SKU_KEYS.has(key) && String(item || '').trim() === sku);
}

function priceOnObject(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of PRICE_KEYS) {
    const amount = parseRetailMoney(value[key]);
    if (amount !== null) return amount;
  }
  const nestedPrice = value.price;
  if (nestedPrice && typeof nestedPrice === 'object') {
    for (const key of PRICE_KEYS) {
      const amount = parseRetailMoney(nestedPrice[key]);
      if (amount !== null) return amount;
    }
  }
  return null;
}

function findPriceInStructuredData(root, sku, { allowFallback = false } = {}) {
  const queue = [{ value: root, skuContext: false }];
  const seen = new Set();
  let fallback = null;
  while (queue.length) {
    const { value, skuContext } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const matchesSku = skuContext || objectContainsSku(value, sku);
    const amount = priceOnObject(value);
    if (amount !== null) {
      if (matchesSku) return amount;
      if (fallback === null) fallback = amount;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && typeof child === 'object') queue.push({ value: child, skuContext: matchesSku });
    }
  }
  return allowFallback ? fallback : null;
}

function scriptBodies(html) {
  const bodies = [];
  const expression = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = expression.exec(String(html || '')))) bodies.push(match[1]);
  return bodies;
}

function priceFromScriptJson(html, sku) {
  if (!sku) return null;
  for (const rawBody of scriptBodies(html)) {
    const body = String(rawBody || '').trim();
    if (!body || !body.includes(sku) || (!body.startsWith('{') && !body.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(body);
      const amount = findPriceInStructuredData(parsed, sku);
      if (amount !== null) return amount;
    } catch (_) {}
  }
  return null;
}

function priceFromEmbeddedText(html, sku) {
  if (!sku) return null;
  const normalized = String(html || '').replace(/\\"/g, '"').replace(/\\u0024/gi, '$');
  const skuIndex = normalized.indexOf(sku);
  if (skuIndex < 0) return null;
  let windowText = normalized.slice(skuIndex, skuIndex + 6000);
  const nextProductIndex = windowText.search(/["'](?:tcin|sku|product[_-]?id|item[_-]?id)["']\s*:\s*["'][^"']+/i);
  if (nextProductIndex > sku.length + 20) windowText = windowText.slice(0, nextProductIndex);
  const keyPattern = PRICE_KEYS.map(key => key.replace(/[A-Z]/g, letter => `[_-]?${letter.toLowerCase()}`)).join('|');
  const expression = new RegExp(`["'](?:${keyPattern})["']\\s*:\\s*(?:["']?\\$?\\s*)([0-9][0-9,.]*)`, 'gi');
  let nearest = null;
  let match;
  while ((match = expression.exec(windowText))) {
    const amount = parseRetailMoney(match[1]);
    if (amount === null) continue;
    const distance = match.index;
    if (!nearest || distance < nearest.distance) nearest = { amount, distance };
  }
  return nearest?.amount ?? null;
}

function extractTargetRetailPrice({ sku, offerPrice, metaPrice, domPrice, html } = {}) {
  for (const [source, value] of [
    ['json_ld_offer', offerPrice],
    ['product_price_meta', metaPrice],
    ['product_price_dom', domPrice]
  ]) {
    const price = parseRetailMoney(value);
    if (price !== null) return { price, source };
  }
  const scriptPrice = priceFromScriptJson(html, String(sku || '').trim());
  if (scriptPrice !== null) return { price: scriptPrice, source: 'target_embedded_json' };
  const embeddedPrice = priceFromEmbeddedText(html, String(sku || '').trim());
  if (embeddedPrice !== null) return { price: embeddedPrice, source: 'target_embedded_price' };
  return { price: null, source: 'not_found' };
}

module.exports = {
  parseRetailMoney,
  findPriceInStructuredData,
  extractTargetRetailPrice
};
