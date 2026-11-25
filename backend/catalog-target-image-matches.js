'use strict';

const { createHash } = require('node:crypto');
const { fetchAllSupabaseRows } = require('./supabase-pagination');
const { saveMissingAmazonImage } = require('./amazon-catalog-images');

const ASIN = /^[A-Z0-9]{10}$/i;
const ROW_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const COLUMNS = 'id,sku,product_name,image_url,metadata';
const MISSING_IMAGE_FILTER = 'image_url.is.null,image_url.eq.';
const VARIANTS = /\b(day|night|deluxe|standard|enhanced|shiny|exclusive|random|assorted|jumbo|mini|teal|magenta|purple|red|blue|green|black|white|gold|silver|japanese|english)\b/g;
const FORMATS = /\b(?:elite trainer box|ultra premium collection|super premium collection|premium figure collection|figure collection|poster collection|binder collection|tech sticker collection|booster bundle|booster display|booster box|booster pack|blister|tin|booster|display)\b/g;
const PAGE_ONLY_WORDS = new Set(['a', 'an', 'the', 'of', 'with', 'for', 'and']);

function titleKey(value) {
    return String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
        .replace(/&amp;|&/g, ' and ').replace(/['’]/g, '')
        .replace(/\b(?:trading card games?|tcg)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ').trim()
        .replace(/\b(?:pack of|case of) (\d+)\b/g, '$1 pack')
        .replace(/\b(\d+)(pk|ct|pack|count)\b/g, '$1 pack')
        .replace(/\b(\d+) (?:counts?|packs?|pk|ct)\b/g, '$1 pack')
        .replace(/ +/g, ' ');
}

function getCodes(data = {}) {
    const metadata = data.metadata || {};
    const codes = ['upc', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'ean']
        .flatMap((field) => [metadata[field], data[field]])
        .filter((value) => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
        .map((value) => String(value).replace(/[\s-]/g, ''))
        .filter((value) => /^(?:\d{8}|\d{12,14})$/.test(value) && !/^(\d)\1+$/.test(value));
    return new Set(codes.map((value) => value.padStart(14, '0')));
}

function normalizeTargetPhoto(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (url.protocol !== 'https:' || url.hostname !== 'target.scene7.com' || url.port || url.username || url.password) return '';
        if (!/^\/is\/image\/Target\/[^/]/i.test(url.pathname)) return '';
        url.hash = '';
        return url.href;
    } catch {
        return '';
    }
}

const tokens = (key, pattern) => new Set(key.match(pattern) || []);
const difference = (a, b) => [...a].filter((token) => !b.has(token));
const sameTokens = (a, b) => a.size === b.size && !difference(a, b).length;

function identity(row) {
    const key = titleKey(row.product_name);
    return {
        key,
        code: getCodes(row),
        variants: tokens(key, VARIANTS),
        formats: tokens(key, FORMATS),
        numbers: tokens(key, /\d+(?:st|nd|rd|th)?/g),
        words: new Set(key.split(' ').filter((word) => word && !PAGE_ONLY_WORDS.has(word)))
    };
}

function scorePair(a, t) {
    if (!a.key || !t.key || !a.words.size || !t.words.size) return null;
    const sharedCode = a.code.size && t.code.size && [...a.code].some((code) => t.code.has(code));
    if (a.code.size && t.code.size && !sharedCode) return null;

    // Never suggest known conflicting details, even if stored metadata says UPC.
    // A UPC can account for an omitted detail, but differing values are a conflict.
    for (const field of ['variants', 'formats', 'numbers']) {
        if (!sameTokens(a[field], t[field]) && (!sharedCode || (a[field].size && t[field].size))) return null;
    }
    if (sharedCode) return { method: 'upc', score: 3 };
    if (a.key === t.key && a.words.size >= 2) return { method: 'title', score: 2 };

    const extraAmazon = difference(a.words, t.words);
    const extraTarget = difference(t.words, a.words);
    // A few added words are fine for suggestions; different words on both sides
    // can distinguish characters or sets (e.g. Dragonite vs Charizard).
    if (extraAmazon.length && extraTarget.length) return null;
    const common = a.words.size - extraAmazon.length;
    const score = common / (common + extraAmazon.length + extraTarget.length);
    return common >= 3 && score >= 0.75 ? { method: 'similar_title', score } : null;
}

function buildTargetImageMatches(amazons, targets) {
    const candidates = targets
        .filter((row) => !row.metadata?.virtual && /^\d[\d-]+$/.test(String(row.sku || '')))
        .map((row) => ({ row, photo: normalizeTargetPhoto(row.image_url), identity: identity(row) }))
        .filter((entry) => entry.photo);
    const matches = [];
    const unmatched = [];
    for (const amazon of amazons) {
        if (amazon.image_url || amazon.metadata?.virtual || !ASIN.test(String(amazon.sku || ''))) continue;
        const amazonIdentity = identity(amazon);
        const ranked = candidates.map((candidate) => {
            const match = scorePair(amazonIdentity, candidate.identity);
            return match ? { ...candidate, ...match } : null;
        }).filter(Boolean).sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));
        const best = ranked[0];
        const tied = best && ranked.slice(1).some((entry) => entry.photo !== best.photo && best.score - entry.score < 0.08);
        if (!best || tied) {
            unmatched.push({ asin: amazon.sku, name: amazon.product_name, reason: tied ? 'multiple_matches' : 'no_match' });
            continue;
        }
        const target = best.row;
        const pair = {
            amazon: { id: amazon.id, asin: amazon.sku, name: amazon.product_name },
            target: { id: target.id, sku: target.sku, name: target.product_name, image_url: best.photo },
            method: best.method
        };
        // Recomputed on save; prevents copying a changed image or changed match
        // the admin did not actually see in the preview.
        pair.match_token = createHash('sha256').update(JSON.stringify(pair)).digest('hex');
        matches.push(pair);
    }
    return { matches, unmatched };
}

async function latestActiveCatalog(supabase, site) {
    const { data, error } = await supabase.from('product_catalogs').select('id')
        .eq('site', site).eq('is_active', true)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1).maybeSingle();
    if (error) throw error;
    return data;
}

async function loadTargetImageMatches(supabase, selectedIds) {
    const [amazonCatalog, targetCatalog] = await Promise.all([
        latestActiveCatalog(supabase, 'amazon'), latestActiveCatalog(supabase, 'target')
    ]);
    const activeProducts = (site, catalog) => supabase.from('catalog_products').select(COLUMNS)
        .eq('catalog_id', catalog.id).eq('site', site).eq('is_enabled', true).order('id');
    const read = async (build) => {
        const { data, error } = await fetchAllSupabaseRows(build);
        if (error) throw error;
        return data;
    };
    const [amazons, targets] = await Promise.all([
        amazonCatalog ? read(() => {
            const query = activeProducts('amazon', amazonCatalog).or(MISSING_IMAGE_FILTER);
            return selectedIds ? query.in('id', selectedIds) : query;
        }) : [],
        targetCatalog ? read(() => activeProducts('target', targetCatalog).not('image_url', 'is', null).neq('image_url', '')) : []
    ]);
    return { amazonCatalog, ...buildTargetImageMatches(amazons, targets) };
}

function parseTargetImageSelections(body) {
    if (!Array.isArray(body) || !body.length || body.length > 50) return null;
    const selections = new Map();
    for (const item of body) {
        const id = item?.amazon_id;
        const token = item?.match_token;
        if (typeof id !== 'string' || !ROW_ID.test(id) || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || selections.has(id)) return null;
        selections.set(id, token);
    }
    return selections;
}

async function applyTargetImageMatches(supabase, selections) {
    const { amazonCatalog, matches } = await loadTargetImageMatches(supabase, [...selections.keys()]);
    const fresh = new Map(matches.map((pair) => [pair.amazon.id, pair]));
    const updated = [];
    const skipped = [];
    const failed = [];
    for (const [id, token] of selections) {
        const pair = fresh.get(id);
        if (!pair || pair.match_token !== token) {
            skipped.push(id);
            continue;
        }
        try {
            const saved = await saveMissingAmazonImage(supabase, amazonCatalog,
                { id, sku: pair.amazon.asin }, pair.target.image_url, pair.amazon.name);
            if (saved) updated.push(id);
            else skipped.push(id);
        } catch (_) {
            failed.push(id);
        }
    }
    return { updated, skipped, failed };
}

module.exports = { buildTargetImageMatches, loadTargetImageMatches, parseTargetImageSelections, applyTargetImageMatches };
