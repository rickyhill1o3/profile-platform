const cheerio = require("cheerio");
const crypto = require("crypto");

const SUPPORTED_SITES = new Set(["amazon", "target", "walmart", "general", "supreme", "pokemon"]);
const REQUESTABLE_SITES = new Set(["amazon", "target", "walmart", "general", "supreme", "pokemon"]);
const VIRTUAL_SITE_DEFAULTS = {
    amazon: {
        catalogName: "Amazon next drop",
        sku: "AMAZON-NEXT-DROP",
        product_name: "Run Next Amazon Release",
        brand: "Amazon",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "next_drop" }
    },
    target: {
        catalogName: "Target next drop",
        sku: "TARGET-NEXT-DROP",
        product_name: "Run Next Target Release",
        brand: "Target",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "next_drop" }
    },
    walmart: {
        catalogName: "Walmart next drop",
        sku: "WALMART-NEXT-DROP",
        product_name: "Run Next Walmart Release",
        brand: "Walmart",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "next_drop" }
    },
    supreme: {
        catalogName: "Supreme next drop",
        sku: "SUPREME-NEXT-DROP",
        product_name: "Run Next Supreme Release",
        brand: "Supreme",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "next_drop" }
    },
    pokemon: {
        catalogName: "Pokemon Center next drop",
        sku: "POKEMON-NEXT-DROP",
        product_name: "Run Next Pokémon Center Release",
        brand: "Pokémon Center",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "next_drop" }
    },
    general: {
        catalogName: "General releases",
        sku: "GENERAL-NEXT-DROP",
        product_name: "Run Next General Release",
        brand: "General",
        release_mode_default: "next",
        metadata: { virtual: true, release_type: "general_drop" }
    }
};

function normalizeSite(value) {
    const site = String(value || "").trim().toLowerCase();
    if (!SUPPORTED_SITES.has(site)) {
        throw new Error("Invalid site. Expected amazon, target, walmart, supreme, pokemon, or general.");
    }
    return site;
}

function normalizeRunMode(value, fallback = "current") {
    const mode = String(value || fallback).trim().toLowerCase();
    return mode === "next" ? "next" : "current";
}

function normalizeMaxPrice(value) {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid max price");
    return Number(parsed.toFixed(2));
}

function normalizeCreditCost(value) {
    if (value === "" || value === null || value === undefined) return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid credit cost");
    return Math.round(parsed);
}

function sanitizeLike(value) {
    return String(value || "").replace(/[%_]/g, "").trim();
}

function normalizeTitle(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/(pack|bundle|edition|the|with|for|and|card|cards|set)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function titleSimilarity(a, b) {
    const aa = new Set(normalizeTitle(a).split(" ").filter(Boolean));
    const bb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
    if (!aa.size || !bb.size) return 0;
    let common = 0;
    aa.forEach((token) => { if (bb.has(token)) common += 1; });
    return common / new Set([...aa, ...bb]).size;
}

async function safeMaybeTable(supabase, table, builder) {
    try {
        return await builder(supabase.from(table));
    } catch (err) {
        if (String(err.message || "").toLowerCase().includes("does not exist")) {
            return { data: [], error: null };
        }
        throw err;
    }
}

async function getScopedUserIds(supabase, currentUser) {
    if (currentUser.role === "super_admin") return null;
    const { data, error } = await supabase.from("users").select("id").eq("owner_admin_id", currentUser.id);
    if (error) throw new Error(error.message);
    return [...new Set([currentUser.id, ...(data || []).map((row) => row.id)])];
}

async function canAdminAccessUser(supabase, currentUser, targetUserId) {
    if (currentUser.role === "super_admin") return true;
    if (currentUser.id === targetUserId) return true;
    const { data, error } = await supabase.from("users").select("id, owner_admin_id").eq("id", targetUserId).single();
    if (error || !data) return false;
    return data.owner_admin_id === currentUser.id;
}

async function ensureVirtualCatalogForSite(supabase, site) {
    const config = VIRTUAL_SITE_DEFAULTS[site];
    if (!config) return null;

    let { data: activeCatalog, error: catalogError } = await supabase
        .from("product_catalogs")
        .select("id, site, name, export_date")
        .eq("site", site)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (catalogError) throw new Error(catalogError.message);

    if (!activeCatalog?.id) {
        const { data: createdCatalog, error: createCatalogError } = await supabase
            .from("product_catalogs")
            .insert({ site, name: config.catalogName, is_active: true, export_date: new Date().toISOString() })
            .select("id, site, name, export_date")
            .single();
        if (createCatalogError) throw new Error(createCatalogError.message);
        activeCatalog = createdCatalog;
    }

    const { data: existingVirtual, error: existingProductsError } = await supabase
        .from("catalog_products")
        .select("id")
        .eq("catalog_id", activeCatalog.id)
        .eq("site", site)
        .ilike("sku", config.sku)
        .limit(1);

    if (existingProductsError) throw new Error(existingProductsError.message);

    if (!Array.isArray(existingVirtual) || existingVirtual.length === 0) {
        const { error: createProductError } = await supabase
            .from("catalog_products")
            .insert({
                catalog_id: activeCatalog.id,
                site,
                sku: config.sku,
                product_name: config.product_name,
                brand: config.brand,
                default_max_price: null,
                release_mode_default: config.release_mode_default,
                is_enabled: true,
                metadata: config.metadata
            });
        if (createProductError) throw new Error(createProductError.message);
    }

    return activeCatalog;
}

async function getActiveCatalog(supabase, site) {
    if (VIRTUAL_SITE_DEFAULTS[site]) await ensureVirtualCatalogForSite(supabase, site);
    else await ensureActiveCatalogForSite(supabase, site);
    const { data, error } = await supabase
        .from("product_catalogs")
        .select("id, site, name, export_date")
        .eq("site", site)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

async function firstRowOrNull(supabase, site, sku) {
    const { data, error } = await supabase
        .from("catalog_products")
        .select("*")
        .eq("site", site)
        .ilike("sku", sku)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

function parseMoney(value) {
    const text = String(value || "").replace(/[^0-9.]/g, "");
    const n = Number(text);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
            "accept-language": "en-US,en;q=0.9"
        }
    });
    if (!response.ok) throw new Error(`Lookup failed with status ${response.status}`);
    return await response.text();
}

async function bestEffortLookupBySku(site, sku) {
    const cleanSku = String(sku || "").trim();
    if (!cleanSku) throw new Error("SKU is required");

    if (site === "general" || site === "supreme" || site === "pokemon") {
        return {
            sku: cleanSku,
            product_name: cleanSku,
            brand: "General",
            product_url: "",
            image_url: "",
            default_max_price: null,
            metadata: { source: "manual_general" }
        };
    }

    const searchUrls = {
        amazon: `https://www.amazon.com/s?k=${encodeURIComponent(cleanSku)}`,
        target: `https://www.target.com/s?searchTerm=${encodeURIComponent(cleanSku)}`,
        walmart: `https://www.walmart.com/search?q=${encodeURIComponent(cleanSku)}`
    };

    const html = await fetchHtml(searchUrls[site]);
    const $ = cheerio.load(html);
    let title = "";
    let price = null;
    let href = "";
    let image = "";

    if (site === "amazon") {
        const card = $('div[data-component-type="s-search-result"]').first();
        title = card.find('h2 a span').first().text().trim() || $('title').text().trim();
        href = card.find('h2 a').attr('href') || '';
        image = card.find('img.s-image').attr('src') || '';
        price = parseMoney(card.find('.a-price .a-offscreen').first().text());
    } else if (site === "target") {
        const card = $('[data-test="product-details"] a').first();
        title = card.text().trim() || $('title').text().trim();
        href = card.attr('href') || '';
        image = $('img').first().attr('src') || '';
        price = parseMoney($('[data-test="product-price"]').first().text() || $('[aria-label*="$" ]').first().text());
    } else if (site === "walmart") {
        const card = $('a[href*="/ip/"]').first();
        title = card.find('span[data-automation-id="product-title"]').text().trim() || card.text().trim() || $('title').text().trim();
        href = card.attr('href') || '';
        image = card.find('img').attr('src') || $('img').first().attr('src') || '';
        price = parseMoney($('[itemprop="price"]').attr('content') || $('[data-automation-id="product-price"]').first().text());
    }

    if (href && href.startsWith('/')) {
        const origin = site === 'amazon' ? 'https://www.amazon.com' : site === 'target' ? 'https://www.target.com' : 'https://www.walmart.com';
        href = origin + href;
    }

    if (!title) {
        return {
            sku: cleanSku,
            product_name: cleanSku,
            brand: site.charAt(0).toUpperCase() + site.slice(1),
            product_url: href,
            image_url: image,
            default_max_price: price,
            metadata: { source: 'lookup_fallback', lookup_failed: true }
        };
    }

    return {
        sku: cleanSku,
        product_name: title,
        brand: site.charAt(0).toUpperCase() + site.slice(1),
        product_url: href,
        image_url: image,
        default_max_price: price,
        metadata: { source: 'lookup_search' }
    };
}

async function findAmazonPriceMatch(supabase, title) {
    const { data, error } = await supabase
        .from('catalog_products')
        .select('id, product_name, default_max_price')
        .eq('site', 'amazon')
        .eq('is_enabled', true)
        .not('default_max_price', 'is', null)
        .limit(2000);
    if (error) throw new Error(error.message);
    let best = null;
    let bestScore = 0;
    (data || []).forEach((row) => {
        const score = titleSimilarity(title, row.product_name);
        if (score > bestScore) {
            best = row;
            bestScore = score;
        }
    });
    return bestScore >= 0.58 ? best : null;
}

async function upsertCatalogProductByLookup(supabase, site, sku) {
    const normalizedSite = normalizeSite(site);
    const existing = await firstRowOrNull(supabase, normalizedSite, sku);
    const catalog = await getActiveCatalog(supabase, normalizedSite);
    if (!catalog?.id) throw new Error(`No active ${normalizedSite} catalog found.`);

    let lookup = existing;
    if (!lookup) {
        try {
            lookup = await bestEffortLookupBySku(normalizedSite, sku);
        } catch (lookupErr) {
            lookup = {
                sku,
                product_name: sku,
                brand: normalizedSite.charAt(0).toUpperCase() + normalizedSite.slice(1),
                product_url: '',
                image_url: '',
                default_max_price: null,
                metadata: { source: 'manual_fallback', lookup_error: String(lookupErr.message || lookupErr) }
            };
        }
    }
    if (!lookup.default_max_price && normalizedSite === 'target') {
        const amazonMatch = await findAmazonPriceMatch(supabase, lookup.product_name);
        if (amazonMatch?.default_max_price !== null && amazonMatch?.default_max_price !== undefined) {
            lookup.default_max_price = amazonMatch.default_max_price;
            lookup.metadata = Object.assign({}, lookup.metadata || {}, { amazon_price_match: amazonMatch.id });
        }
    }

    const payload = {
        catalog_id: catalog.id,
        site: normalizedSite,
        sku: lookup.sku || sku,
        product_name: lookup.product_name || sku,
        brand: lookup.brand || normalizedSite,
        image_url: lookup.image_url || '',
        product_url: lookup.product_url || '',
        default_max_price: lookup.default_max_price,
        release_mode_default: 'current',
        is_enabled: true,
        metadata: lookup.metadata || {}
    };

    let result;
    if (existing?.id) {
        const { data, error } = await supabase
            .from('catalog_products')
            .update(payload)
            .eq('id', existing.id)
            .select('*')
            .single();
        if (error) throw new Error(error.message);
        result = data;
    } else {
        const { data, error } = await supabase
            .from('catalog_products')
            .insert(payload)
            .select('*')
            .single();
        if (error) throw new Error(error.message);
        result = data;
    }

    return result;
}

async function syncTargetPricingFromAmazon(supabase) {
    const { data: targets, error: targetError } = await supabase
        .from('catalog_products')
        .select('id, product_name, default_max_price')
        .eq('site', 'target')
        .eq('is_enabled', true)
        .limit(5000);
    if (targetError) throw new Error(targetError.message);

    const { data: amazons, error: amazonError } = await supabase
        .from('catalog_products')
        .select('id, product_name, default_max_price')
        .eq('site', 'amazon')
        .eq('is_enabled', true)
        .not('default_max_price', 'is', null)
        .limit(5000);
    if (amazonError) throw new Error(amazonError.message);

    let updated = 0;
    for (const target of (targets || [])) {
        let best = null;
        let score = 0;
        for (const amazon of (amazons || [])) {
            const s = titleSimilarity(target.product_name, amazon.product_name);
            if (s > score) {
                best = amazon;
                score = s;
            }
        }
        if (best && score >= 0.58 && best.default_max_price !== null && target.default_max_price !== best.default_max_price) {
            const { error } = await supabase.from('catalog_products').update({ default_max_price: best.default_max_price }).eq('id', target.id);
            if (!error) updated += 1;
        }
    }
    return updated;
}



function parseImportedCatalogList(input) {
    if (Array.isArray(input)) return input;
    if (input && Array.isArray(input.products)) return input.products;
    return [];
}

function isPlaceholderPrice(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 999;
}

function chunkLines(lines, size = 29) {
    const rows = Array.isArray(lines) ? lines : [];
    const out = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}

function escapeExportField(value) {
    return String(value ?? '').replace(/\r?\n|;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function importCatalogList(supabase, site, listInput) {
    const normalizedSite = normalizeSite(site);
    const entries = parseImportedCatalogList(listInput);
    const seen = new Set();
    const results = [];

    for (const entry of entries) {
        const sku = String(entry?.sku || '').trim();
        if (!sku || seen.has(sku.toLowerCase())) continue;
        seen.add(sku.toLowerCase());
        const sourcePrice = normalizeMaxPrice(entry?.userSetMaxPrice);

        let product = await upsertCatalogProductByLookup(supabase, normalizedSite, sku);

        if (normalizedSite === 'amazon' && sourcePrice !== null) {
            const { data, error } = await supabase
                .from('catalog_products')
                .update({ default_max_price: sourcePrice })
                .eq('id', product.id)
                .select('*')
                .single();
            if (!error && data) product = data;
        }

        if (normalizedSite === 'target' && sourcePrice !== null && !isPlaceholderPrice(sourcePrice) && (product.default_max_price === null || isPlaceholderPrice(product.default_max_price))) {
            const { data, error } = await supabase
                .from('catalog_products')
                .update({ default_max_price: sourcePrice })
                .eq('id', product.id)
                .select('*')
                .single();
            if (!error && data) product = data;
        }

        results.push(product);
    }

    return results;
}

function requireSuperAdmin(req, res) {
    if (req.role !== 'super_admin') {
        res.status(403).json({ error: 'Super admin only.' });
        return false;
    }
    return true;
}

async function upsertCatalogProductManual(supabase, payloadInput) {
    const site = normalizeSite(payloadInput.site);
    const catalog = await getActiveCatalog(supabase, site);
    if (!catalog?.id) throw new Error(`No active ${site} catalog found.`);

    const isPlaceholder = !!payloadInput.is_placeholder;
    const sku = String(payloadInput.sku || '').trim() || (isPlaceholder ? `${site.toUpperCase()}-CUSTOM-${Date.now()}` : '');
    if (!sku) throw new Error('SKU is required.');

    const product_name = String(payloadInput.product_name || '').trim() || (isPlaceholder ? `Run Next ${site.charAt(0).toUpperCase() + site.slice(1)} Release` : sku);
    const default_max_price = normalizeMaxPrice(payloadInput.default_max_price);
    const brand = String(payloadInput.brand || '').trim() || (site === 'pokemon' ? 'Pokémon Center' : site.charAt(0).toUpperCase() + site.slice(1));
    const image_url = String(payloadInput.image_url || '').trim();
    const product_url = String(payloadInput.product_url || '').trim();
    const metadata = Object.assign({}, payloadInput.metadata || {}, isPlaceholder ? { virtual: true, release_type: 'next_drop' } : {});

    const existing = await firstRowOrNull(supabase, site, sku);
    const payload = {
        catalog_id: catalog.id,
        site,
        sku,
        product_name,
        brand,
        image_url,
        product_url,
        default_max_price,
        credit_cost: normalizeCreditCost(payloadInput.credit_cost),
        release_mode_default: isPlaceholder ? 'next' : normalizeRunMode(payloadInput.release_mode_default, 'current'),
        is_enabled: true,
        metadata
    };

    if (existing?.id) {
        const { data, error } = await supabase.from('catalog_products').update(payload).eq('id', existing.id).select('*').single();
        if (error) throw new Error(error.message);
        return data;
    }
    const { data, error } = await supabase.from('catalog_products').insert(payload).select('*').single();
    if (error) throw new Error(error.message);
    return data;
}

async function syncCountdownProducts(supabase, countdownId, countdownProducts) {
    const rows = Array.isArray(countdownProducts) ? countdownProducts : [];
    try {
        await supabase.from('countdown_products').delete().eq('countdown_id', countdownId);
    } catch (err) {
        if (!String(err.message || '').toLowerCase().includes('does not exist')) throw err;
        return [];
    }

    const payload = rows
        .filter((row) => row && (row.product_id || row.catalog_product_id))
        .map((row) => ({
            countdown_id: countdownId,
            product_id: row.product_id || row.catalog_product_id,
            credit_cost_override: normalizeCreditCost(
                row.credit_cost_override ?? row.credit_cost
            )
        }));

    if (!payload.length) return [];
    const { data, error } = await supabase.from('countdown_products').insert(payload).select('*');
    if (error) throw new Error(error.message);
    return data || [];
}

async function getCountdownProducts(supabase, countdownId) {
    try {
        const { data, error } = await supabase
            .from('countdown_products')
            .select('id, product_id, credit_cost_override, catalog_products(id, site, sku, product_name)')
            .eq('countdown_id', countdownId);
        if (error) throw error;

        return (data || []).map((row) => ({
            ...row,
            catalog_product_id: row.product_id,
            credit_cost: row.credit_cost_override
        }));
    } catch (err) {
        if (String(err.message || '').toLowerCase().includes('does not exist')) return [];
        throw err;
    }
}

async function getCatalogAppSetting(supabase, key, fallback = null) {
    const { data, error } = await supabase
        .from('app_settings')
        .select('value_json')
        .eq('key', key)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.value_json ?? fallback;
}

async function setCatalogAppSetting(supabase, key, value) {
    const { error } = await supabase
        .from('app_settings')
        .upsert({ key, value_json: value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return value;
}




    








module.exports.registerProductGroupRoutes = function(app, supabase, auth, normalizeSite) {

    app.get('/product-groups', auth, async (req, res) => {
        try {
            const site = normalizeSite(req.query.site || 'target');

            const { data, error } = await supabase
                .from('product_groups')
                .select(`
                    *,
                    product_group_skus (
                        catalog_product_id,
                        is_primary,
                        catalog_products (
                            id,
                            sku,
                            product_name,
                            image_url,
                            product_url,
                            default_max_price,
                            credit_cost,
                            brand,
                            site
                        )
                    )
                `)
                .eq('site', site)
                .eq('is_active', true);

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            return res.json({ products: data || [] });

        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/product-groups', auth, async (req, res) => {
        try {
            const payload = req.body || {};

            const { data, error } = await supabase
                .from('product_groups')
                .insert(payload)
                .select()
                .single();

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            return res.json(data);

        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    app.patch('/admin/product-groups/:id', auth, async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('product_groups')
                .update(req.body || {})
                .eq('id', req.params.id)
                .select()
                .single();

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            return res.json(data);

        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/product-group-skus', auth, async (req, res) => {
        try {
            const payload = req.body || {};

            const { data, error } = await supabase
                .from('product_group_skus')
                .insert(payload)
                .select()
                .single();

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            return res.json(data);

        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

};



if (typeof registerProductCatalogRoutes === 'function') {
    module.exports = registerProductCatalogRoutes;
    module.exports.registerProductCatalogRoutes = registerProductCatalogRoutes;
}
