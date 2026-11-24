'use strict';

const ASIN_AT_END = /(?:^|\s)([A-Z0-9]{10})\s*$/i;
const MAX_PRICE_LINE = /^\$\s*([\d,]+(?:\.\d{1,2})?)\s*max\s*$/i;

function decodeTextEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCategory(products = []) {
  const titles = products.map((row) => String(row.title || '').toLowerCase());
  if (titles.length && titles.every((title) => title.includes('30th celebration'))) return '30th Celebration';
  return 'Uncategorized';
}

function cleanCategoryHeader(rawHeader, itemCount, products) {
  const raw = decodeTextEntities(rawHeader);
  if (!raw) return inferCategory(products);
  const countSuffix = String(Math.max(0, Number(itemCount || 0)));
  if (countSuffix && raw.endsWith(countSuffix)) {
    const withoutCount = raw.slice(0, -countSuffix.length).trim();
    if (withoutCount) return withoutCount;
  }
  return raw;
}

function parseAmazonCatalogPaste(input) {
  const text = String(input || '').replace(/\r/g, '');
  const errors = [];
  const sections = [{ header: '', products: [] }];
  let section = sections[0];
  let pendingProduct = null;

  text.split('\n').forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = decodeTextEntities(rawLine);
    if (!line || /^select\s+all$/i.test(line)) return;

    const priceMatch = line.match(MAX_PRICE_LINE);
    if (priceMatch) {
      if (!pendingProduct) {
        errors.push(`Line ${lineNumber}: price does not have a product directly above it.`);
        return;
      }
      const price = Number(priceMatch[1].replace(/,/g, ''));
      if (!Number.isFinite(price) || price <= 0) {
        errors.push(`Line ${lineNumber}: invalid maximum price.`);
      } else {
        pendingProduct.max_price = Number(price.toFixed(2));
      }
      pendingProduct = null;
      return;
    }

    const asinMatch = line.match(ASIN_AT_END);
    if (asinMatch) {
      if (pendingProduct && pendingProduct.max_price === null) {
        errors.push(`Line ${pendingProduct.line}: ${pendingProduct.sku} is missing its maximum price.`);
      }
      const sku = asinMatch[1].toUpperCase();
      const title = line.slice(0, asinMatch.index).trim();
      if (!title) errors.push(`Line ${lineNumber}: ${sku} is missing a product name.`);
      pendingProduct = { sku, title, max_price: null, line: lineNumber };
      section.products.push(pendingProduct);
      return;
    }

    if (pendingProduct && pendingProduct.max_price === null) {
      errors.push(`Line ${pendingProduct.line}: ${pendingProduct.sku} is missing its maximum price.`);
      pendingProduct = null;
    }
    section = { header: line, products: [] };
    sections.push(section);
  });

  if (pendingProduct && pendingProduct.max_price === null) {
    errors.push(`Line ${pendingProduct.line}: ${pendingProduct.sku} is missing its maximum price.`);
  }

  const products = [];
  const categories = [];
  const seen = new Set();
  sections.filter((row) => row.products.length).forEach((row) => {
    const category = cleanCategoryHeader(row.header, row.products.length, row.products);
    categories.push({ name: category, count: row.products.length });
    row.products.forEach((product) => {
      if (seen.has(product.sku)) {
        errors.push(`Duplicate ASIN: ${product.sku}.`);
        return;
      }
      seen.add(product.sku);
      if (product.max_price === null) return;
      products.push({
        sku: product.sku,
        product_name: product.title,
        default_max_price: product.max_price,
        category
      });
    });
  });

  if (!products.length) errors.push('No Amazon products were found.');
  if (products.length > 1000) errors.push('The pasted catalog is limited to 1,000 products per replacement.');

  return { products, categories, errors };
}

module.exports = {
  cleanCategoryHeader,
  decodeTextEntities,
  parseAmazonCatalogPaste
};
