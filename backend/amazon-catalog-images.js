'use strict';

const cheerio = require('cheerio');

const AMAZON_ORIGIN = 'https://www.amazon.com';
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const AMAZON_IMAGE_HOSTS = new Set([
    'm.media-amazon.com',
    'images-na.ssl-images-amazon.com',
    'images-eu.ssl-images-amazon.com',
    'images.amazon.com'
]);
const MISSING_IMAGE_FILTER = 'image_url.is.null,image_url.eq.';
const IMAGE_BATCH_SIZE = 3;

function normalizeAmazonImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value.trim(), AMAZON_ORIGIN);
        if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
        if (!AMAZON_IMAGE_HOSTS.has(url.hostname) || !url.pathname.startsWith('/images/I/')) return '';
        url.hash = '';
        return url.href;
    } catch {
        return '';
    }
}

function imageFromElement(element) {
    const candidates = [element.attr('data-old-hires')];
    try {
        const sizes = JSON.parse(element.attr('data-a-dynamic-image') || '{}');
        if (sizes && typeof sizes === 'object' && !Array.isArray(sizes)) {
            const area = (size) => Array.isArray(size) ? (Number(size[0]) || 0) * (Number(size[1]) || 0) : 0;
            candidates.push(...Object.entries(sizes).sort((a, b) => area(b[1]) - area(a[1])).map(([url]) => url));
        }
    } catch { /* The normal image attributes are still usable. */ }
    candidates.push(element.attr('data-src'), element.attr('src'));
    return candidates.map(normalizeAmazonImageUrl).find(Boolean) || '';
}

function detailImage($, asin) {
    const inputAsin = String($('input#ASIN').first().attr('value') || '').trim().toUpperCase();
    const canonical = $('link[rel="canonical"]').first().attr('href') || '';
    const canonicalAsin = canonical.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?=[/?#]|$)/i)?.[1]?.toUpperCase();
    if ((ASIN_PATTERN.test(inputAsin) && inputAsin !== asin) || (canonicalAsin && canonicalAsin !== asin)) return '';

    for (const selector of ['#landingImage', '#imgBlkFront', '#ebooksImgBlkFront']) {
        const image = imageFromElement($(selector).first());
        if (image) return image;
    }
    if (inputAsin === asin || canonicalAsin === asin) {
        return normalizeAmazonImageUrl($('meta[property="og:image"]').first().attr('content'));
    }
    return '';
}

class AmazonImageLookupPaused extends Error {}

async function fetchAmazonImagePage(path, fetchImpl) {
    // Both URL paths are built from validated ASINs. Do not follow redirects or
    // fetch any URL provided by a catalog row or received in Amazon's HTML.
    const response = await fetchImpl(AMAZON_ORIGIN + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }
    });
    if ([401, 403, 429, 503].includes(response.status)) {
        throw new AmazonImageLookupPaused(`Amazon page lookup is unavailable (HTTP ${response.status}).`);
    }
    if (response.status === 404 || (response.status >= 300 && response.status < 400)) return null;
    if (!response.ok) throw new Error(`Amazon image lookup returned HTTP ${response.status}.`);

    const $ = cheerio.load(await response.text());
    if ($('#captchacharacters, form[action*="validateCaptcha"]').length) {
        throw new AmazonImageLookupPaused('Amazon is asking for verification. Direct lookups were stopped.');
    }
    return $;
}

async function lookupAmazonCatalogImage(rawAsin, fetchImpl = globalThis.fetch) {
    const asin = String(rawAsin || '').trim().toUpperCase();
    if (!ASIN_PATTERN.test(asin)) return '';

    const detail = await fetchAmazonImagePage(`/dp/${asin}`, fetchImpl);
    if (detail) {
        const image = detailImage(detail, asin);
        if (image) return image;
    }
    const search = await fetchAmazonImagePage(`/s?k=${asin}`, fetchImpl);
    if (!search) return '';
    const exact = search(`[data-component-type="s-search-result"][data-asin="${asin}"] img.s-image`);
    return exact.toArray().map((element) => imageFromElement(search(element))).find(Boolean) || '';
}

async function getActiveAmazonCatalog(supabase) {
    const { data: catalog, error: catalogError } = await supabase.from('product_catalogs')
        .select('id').eq('site', 'amazon').eq('is_active', true)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (catalogError) throw catalogError;
    return catalog;
}

async function findSavedAmazonImage(supabase, asin) {
    const best = (rows) => (rows || []).map((row) => normalizeAmazonImageUrl(row.image_url)).find(Boolean) || '';
    const catalog = await supabase.from('catalog_products').select('image_url')
        .eq('site', 'amazon').ilike('sku', asin).not('image_url', 'is', null).neq('image_url', '')
        .order('created_at', { ascending: false }).limit(10);
    const catalogImage = best(catalog.data);
    if (catalogImage) return catalogImage;

    const storefront = await supabase.from('storefront_products').select('image_url')
        .eq('primary_site', 'amazon').ilike('primary_sku', asin)
        .not('image_url', 'is', null).neq('image_url', '').limit(10);
    const storefrontImage = best(storefront.data);
    if (storefrontImage) return storefrontImage;

    const history = await supabase.from('webhook_events').select('parsed_items')
        .eq('type', 'checkout').eq('site', 'amazon').ilike('sku', asin)
        .in('status', ['processed', 'confirmed', 'success', 'successful', 'completed'])
        .order('created_at', { ascending: false }).limit(20);
    for (const row of history.data || []) {
        const items = Array.isArray(row.parsed_items) ? row.parsed_items : [];
        // Multi-item webhooks can have a shared thumbnail copied to each line.
        // Use only a single-item checkout with an exact ASIN match.
        if (items.length !== 1) continue;
        const item = items[0];
        if (String(item?.sku || '').trim().toUpperCase() !== asin) continue;
        const image = normalizeAmazonImageUrl(item.image || item.image_url);
        if (image) return image;
    }
    return '';
}

async function saveMissingAmazonImage(supabase, catalog, row, imageUrl, expectedName) {
    // Only write the image. Recheck the conditions so a concurrent catalog edit,
    // disable, or manually entered image cannot be overwritten.
    let query = supabase.from('catalog_products')
        .update({ image_url: imageUrl })
        .eq('id', row.id).eq('catalog_id', catalog.id).eq('site', 'amazon')
        .eq('sku', row.sku).eq('is_enabled', true).or(MISSING_IMAGE_FILTER);
    if (typeof expectedName === 'string') query = query.eq('product_name', expectedName);
    const { data: saved, error } = await query.select('id').maybeSingle();
    if (error) throw error;
    return Boolean(saved);
}

async function saveManualAmazonCatalogImage(supabase, rawAsin, rawImageUrl) {
    const asin = String(rawAsin || '').trim().toUpperCase();
    const imageUrl = normalizeAmazonImageUrl(rawImageUrl);
    if (!ASIN_PATTERN.test(asin)) return { status: 400, error: 'Enter a valid 10-character Amazon ASIN.' };
    if (!imageUrl) return { status: 400, error: 'Paste the direct Amazon product image URL, not the listing URL.' };

    const catalog = await getActiveAmazonCatalog(supabase);
    if (!catalog) return { status: 404, error: 'There is no active Amazon catalog.' };
    const { data, error } = await supabase.from('catalog_products').select('id, sku, image_url, metadata')
        .eq('catalog_id', catalog.id).eq('site', 'amazon').eq('is_enabled', true).ilike('sku', asin)
        .limit(2);
    if (error) throw error;
    const rows = (data || []).filter((row) => !row.metadata?.virtual);
    if (!rows.length) return { status: 404, error: `${asin} is not an active Amazon catalog product.` };
    if (rows.length > 1) return { status: 409, error: `More than one active item matches ${asin}. No image was changed.` };
    if (rows[0].image_url || !(await saveMissingAmazonImage(supabase, catalog, rows[0], imageUrl))) {
        return { status: 409, error: `${asin} already has an image or changed during the save. No image was overwritten.` };
    }
    return { status: 200, asin };
}

async function fillAmazonCatalogImageBatch(supabase, afterId, lookupImage = lookupAmazonCatalogImage, savedOnly = false) {
    const result = { checked: 0, updated: 0, skipped: 0, failed: [], next_after_id: afterId, done: true, paused: '', saved_only: savedOnly };
    const catalog = await getActiveAmazonCatalog(supabase);
    if (!catalog) return result;

    let query = supabase.from('catalog_products').select('id, sku, metadata')
        .eq('catalog_id', catalog.id).eq('site', 'amazon').eq('is_enabled', true)
        .or(MISSING_IMAGE_FILTER).order('id', { ascending: true }).limit(IMAGE_BATCH_SIZE + 1);
    // Updating a row removes it from the missing-image set. An offset would skip
    // the rows that move into its old position, so advance by a stable ID instead.
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    result.done = rows.length <= IMAGE_BATCH_SIZE;

    for (const row of rows.slice(0, IMAGE_BATCH_SIZE)) {
        result.checked++;
        result.next_after_id = String(row.id);
        const asin = String(row.sku || '').trim().toUpperCase();
        if (!ASIN_PATTERN.test(asin) || row.metadata?.virtual) {
            result.skipped++;
            continue;
        }
        try {
            let imageUrl = await findSavedAmazonImage(supabase, asin);
            if (!imageUrl && !result.saved_only) {
                try {
                    imageUrl = normalizeAmazonImageUrl(await lookupImage(asin));
                } catch (error) {
                    if (!(error instanceof AmazonImageLookupPaused)) throw error;
                    result.paused = error.message;
                    result.saved_only = true;
                }
            }
            if (!imageUrl) {
                result.failed.push({ asin, reason: result.saved_only
                    ? 'No saved image for this ASIN; add an image URL below.'
                    : 'No matching product image found.' });
                continue;
            }
            if (await saveMissingAmazonImage(supabase, catalog, row, imageUrl)) result.updated++;
            else result.skipped++;
        } catch (error) {
            result.failed.push({ asin, reason: String(error?.message || error) });
        }
    }
    return result;
}

module.exports = { fillAmazonCatalogImageBatch, lookupAmazonCatalogImage, saveManualAmazonCatalogImage, saveMissingAmazonImage };
