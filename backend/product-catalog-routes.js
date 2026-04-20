const cheerio = require("cheerio");

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


function normalizeExportGroupLabel(value, fallback = 'Other') {
    const clean = escapeExportField(value);
    return clean || fallback;
}

function normalizeTextForExportGrouping(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const POKEMON_SET_ALIASES = [
    ['Mega Evolution', ['mega evolution', 'mega charizard', 'mega gengar', 'mega meganium', 'mega feraligatr', 'mega emboar']],
    ['Ascending Heroes', ['ascending heroes', 'ascended heroes']],
    ['Phantasmal Flames', ['phantasmal flames']],
    ['Perfect Order', ['perfect order']],
    ['Chaos Rising', ['chaos rising']],
    ['151', ['pokemon 151', 'scarlet violet 151', 'scarlet and violet 151', 'sv 151', ' 151 ']],
    ['Prismatic Evolutions', ['prismatic evolutions', 'prismatic']],
    ['Surging Sparks', ['surging sparks']],
    ['Destined Rivals', ['destined rivals']],
    ['Journey Together', ['journey together']],
    ['Stellar Crown', ['stellar crown']],
    ['Twilight Masquerade', ['twilight masquerade']],
    ['Temporal Forces', ['temporal forces']],
    ['Paldean Fates', ['paldean fates']],
    ['Paldea Evolved', ['paldea evolved']],
    ['Shrouded Fable', ['shrouded fable']],
    ['Paradox Rift', ['paradox rift']],
    ['Obsidian Flames', ['obsidian flames']],
    ['Crown Zenith', ['crown zenith']],
    ['Silver Tempest', ['silver tempest']],
    ['Blooming Waters', ['blooming waters']],
    ['Pokémon Day', ['pokemon day 2026', 'pokemon day']],
    ['First Partner', ['first partner illustration', 'first partner']],
    ['Unova', ['unova', 'victini illustration']],
    ['Special Collections', ['lugia ex latias ex', 'adventure chest', 'battle deck']]
];

const POKEMON_MEGA_FAMILY = new Set([
    'Mega Evolution',
    'Ascending Heroes',
    'Phantasmal Flames',
    'Perfect Order',
    'Chaos Rising'
]);

const POKEMON_MAINLINE_FAMILY = new Set([
    '151',
    'Prismatic Evolutions',
    'Surging Sparks',
    'Destined Rivals',
    'Journey Together',
    'Stellar Crown',
    'Twilight Masquerade',
    'Temporal Forces',
    'Paldean Fates',
    'Paldea Evolved',
    'Shrouded Fable',
    'Paradox Rift',
    'Obsidian Flames'
]);

function inferTargetCategoryGroup(row) {
    const metadata = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
    const explicit = normalizeTextForExportGrouping(metadata.category || metadata.product_type || metadata.group || '');
    if (explicit === 'onepiece' || explicit === 'one piece') return 'One Piece';
    if (explicit === 'sports') return 'Sports';
    if (explicit === 'magic' || explicit === 'mtg') return 'Magic';
    if (explicit === 'othertcg' || explicit === 'other tcg' || explicit === 'all other tcg') return 'All Other TCG';
    if (explicit === 'lowkey' || explicit === 'other') return 'Lowkey';

    const hay = normalizeTextForExportGrouping(`${row?.product_name || ''} ${row?.sku || ''}`);
    if (/one\s*piece/.test(hay)) return 'One Piece';
    if (/topps|panini|upper deck|sports card|baseball card|basketball card|football card|soccer card|hockey card|wnba|nba chrome/.test(hay)) return 'Sports';
    if (/\bmagic\b|\bmtg\b/.test(hay)) return 'Magic';
    if (/lorcana|yu\s*gi\s*oh|yugioh|digimon|dragon ball|union arena|weiss|gundam card|final fantasy tcg/.test(hay)) return 'All Other TCG';
    return 'Lowkey';
}

function inferPokemonSubgroup(row) {
    const metadata = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
    const explicit = normalizeExportGroupLabel(
        metadata.pokemon_group || metadata.pokemonGroup || metadata.set_name || metadata.setName || metadata.series || metadata.group,
        ''
    );
    if (explicit) return explicit;

    const rawTitle = escapeExportField(row?.product_name || '');
    const normalized = ` ${normalizeTextForExportGrouping(rawTitle)} `;

    for (const [label, aliases] of POKEMON_SET_ALIASES) {
        if (aliases.some((alias) => normalized.includes(` ${normalizeTextForExportGrouping(alias)} `))) return label;
    }

    const descriptorPattern = /(.+?)\s+(elite trainer box|booster bundle|booster display box|booster display|display box|booster box|booster pack|sleeved booster|poster collection|binder collection|mini tin|tin|premium collection|super premium collection|collection|accessory pouch|build battle box|build and battle box|checklane blister|blister|3 booster blister|3 pack blister|trainer box|surprise box|tech sticker collection|figure collection|premium box)\b/i;
    const match = rawTitle.match(descriptorPattern);
    if (match) {
        const candidate = normalizeExportGroupLabel(
            match[1]
                .replace(/pokemon center/ig, '')
                .replace(/pokemon|pok[eé]mon/ig, '')
                .replace(/trading card game|tcg/ig, '')
                .replace(/scarlet\s*(?:&|and)\s*violet|scarlet violet|sv\s*s?\d(?:\.\d)?/ig, '')
                .replace(/[–—:-]+$/g, '')
                .trim(),
            ''
        );
        if (candidate && candidate.length <= 50) return candidate;
    }

    return 'Other Pokémon';
}

function isPokemonTargetRow(row) {
    const metadata = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
    const hay = ` ${normalizeTextForExportGrouping([
        row?.product_name,
        row?.sku,
        metadata.pokemon_group,
        metadata.pokemonGroup,
        metadata.set_name,
        metadata.setName,
        metadata.series,
        metadata.group,
        metadata.category,
        metadata.product_type
    ].filter(Boolean).join(' '))} `;

    if (/\bpokemon\b|\bpok mon\b/.test(hay)) return true;
    return POKEMON_SET_ALIASES.some(([, aliases]) => aliases.some((alias) => hay.includes(` ${normalizeTextForExportGrouping(alias)} `)));
}

function getPokemonFamilyLabel(subgroup) {
    if (POKEMON_MEGA_FAMILY.has(subgroup)) return 'Pokémon - Mega Evolution';
    if (POKEMON_MAINLINE_FAMILY.has(subgroup)) return 'Pokémon - Mainline';
    return 'Pokémon - Specialty';
}

function classifyTargetExportRow(row) {
    if (isPokemonTargetRow(row)) {
        const subgroup = inferPokemonSubgroup(row);
        return {
            rawGroup: subgroup,
            group: getPokemonFamilyLabel(subgroup),
            type: 'pokemon'
        };
    }

    const category = inferTargetCategoryGroup(row);
    if (category === 'One Piece' || category === 'Magic' || category === 'All Other TCG') {
        return { rawGroup: category, group: 'Non-Pokémon TCG', type: 'non_pokemon' };
    }
    return { rawGroup: category, group: 'Non-Pokémon / Misc', type: 'non_pokemon' };
}

function sortExportGroups(a, b) {
    const order = [
        'Pokémon - Mainline',
        'Pokémon - Mega Evolution',
        'Pokémon - Specialty',
        'Non-Pokémon TCG',
        'Non-Pokémon / Misc',
        'All Products'
    ];
    const ai = order.indexOf(a.group);
    const bi = order.indexOf(b.group);
    if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        if (ai !== bi) return ai - bi;
    }
    return a.group.localeCompare(b.group);
}

function consolidateSmallExportGroups(grouped, minimumGroupSize = 20) {
    const map = new Map(grouped);
    const specialty = map.get('Pokémon - Specialty') || [];
    const mainline = map.get('Pokémon - Mainline') || [];
    const mega = map.get('Pokémon - Mega Evolution') || [];

    if (specialty.length && specialty.length < minimumGroupSize) {
        if (mainline.length >= mega.length) {
            map.set('Pokémon - Mainline', mainline.concat(specialty));
        } else {
            map.set('Pokémon - Mega Evolution', mega.concat(specialty));
        }
        map.delete('Pokémon - Specialty');
    }

    const nonPokemonTcg = map.get('Non-Pokémon TCG') || [];
    const nonPokemonMisc = map.get('Non-Pokémon / Misc') || [];
    if (nonPokemonTcg.length && nonPokemonTcg.length < minimumGroupSize) {
        map.set('Non-Pokémon / Misc', nonPokemonMisc.concat(nonPokemonTcg));
        map.delete('Non-Pokémon TCG');
    }

    return map;
}

function getExportGroupLabel(site, row) {
    if (site === 'target') return classifyTargetExportRow(row).group;
    if (site === 'pokemon') return getPokemonFamilyLabel(inferPokemonSubgroup(row));
    return 'All Products';
}

function buildGroupedExportBatches(site, data, batchSize) {
    const rows = (data || [])
        .filter((row) => row && row.is_enabled)
        .filter((row) => !(row.metadata && row.metadata.virtual));

    let grouped = new Map();
    for (const row of rows) {
        const price = row.default_max_price === null || row.default_max_price === undefined ? '' : Number(row.default_max_price).toFixed(2).replace(/\.00$/, '.00');
        const line = `${escapeExportField(row.sku)};${escapeExportField(row.product_name)};${price}`;
        const group = getExportGroupLabel(site, row);
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(line);
    }

    if (site === 'target' || site === 'pokemon') {
        grouped = consolidateSmallExportGroups(grouped, 20);
    }

    const groups = Array.from(grouped.entries())
        .map(([group, lines]) => ({ group, lines }))
        .sort(sortExportGroups)
        .map(({ group, lines }) => ({
            group,
            total: lines.length,
            batches: chunkLines(lines, batchSize).map((items, index) => ({
                index: index + 1,
                text: items.join('\n'),
                count: items.length
            }))
        }));

    return {
        total: rows.length,
        groups,
        batches: groups.flatMap((group) => group.batches)
    };
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
module.exports = function registerProductCatalogRoutes({ app, supabase, auth, admin, getCurrentUser, ensureUserNotRevoked }) {
    app.get('/public/countdowns', async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('drop_countdowns')
                .select('*, default_credit_cost')
                .eq('is_active', true)
                .order('sort_order', { ascending: true })
                .order('scheduled_for', { ascending: true });

            if (error && String(error.message || '').toLowerCase().includes('drop_countdowns')) {
                return res.json({ items: [] });
            }
            if (error) return res.status(500).json({ error: error.message });

            const items = [];
            for (const row of data || []) {
                items.push({ ...row, countdown_products: await getCountdownProducts(supabase, row.id) });
            }
            res.json({ items });
        } catch (err) {
            res.json({ items: [] });
        }
    });

    app.get('/admin/countdowns', auth, admin, async (req, res) => {
        const { data, error } = await supabase
            .from('drop_countdowns')
            .select('*, default_credit_cost')
            .order('sort_order', { ascending: true })
            .order('scheduled_for', { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        const items = [];
        for (const row of data || []) {
            items.push({ ...row, countdown_products: await getCountdownProducts(supabase, row.id) });
        }
        res.json({ items });
    });

    app.post('/admin/countdowns', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const site = normalizeSite(req.body.site);
            const label = String(req.body.label || '').trim() || (site === 'general' ? 'General Release' : site.charAt(0).toUpperCase() + site.slice(1));
            const scheduled_for = req.body.scheduled_for;
            if (!scheduled_for) return res.status(400).json({ error: 'scheduled_for is required' });

            const payload = {
                site,
                label,
                scheduled_for,
                sort_order: Number(req.body.sort_order || 0),
                is_active: req.body.is_active !== false,
                created_by: currentUser.id,
                default_credit_cost: normalizeCreditCost(
                    req.body.default_credit_cost ?? req.body.base_credit_cost
                )
            };

            const { data, error } = await supabase
                .from('drop_countdowns')
                .insert(payload)
                .select('*, default_credit_cost')
                .single();

            if (error) return res.status(500).json({ error: error.message });

            const countdownProducts = await syncCountdownProducts(
                supabase,
                data.id,
                req.body.countdown_products || []
            );

            res.json({ item: { ...data, countdown_products: countdownProducts } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/admin/countdowns/:id', auth, admin, async (req, res) => {
        try {
            const payload = {
                site: normalizeSite(req.body.site),
                label: String(req.body.label || '').trim(),
                scheduled_for: req.body.scheduled_for,
                sort_order: Number(req.body.sort_order || 0),
                is_active: req.body.is_active !== false,
                default_credit_cost: normalizeCreditCost(
                    req.body.default_credit_cost ?? req.body.base_credit_cost
                )
            };

            const { data, error } = await supabase
                .from('drop_countdowns')
                .update(payload)
                .eq('id', req.params.id)
                .select('*, default_credit_cost')
                .single();

            if (error) return res.status(500).json({ error: error.message });

            const countdownProducts = await syncCountdownProducts(
                supabase,
                data.id,
                req.body.countdown_products || []
            );

            res.json({ item: { ...data, countdown_products: countdownProducts } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/admin/countdowns/:id', auth, admin, async (req, res) => {
        const { error } = await supabase.from('drop_countdowns').delete().eq('id', req.params.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    });


    app.get('/countdown-selections', auth, async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('user_selected_countdowns')
                .select('countdown_id')
                .eq('user_id', req.user_id);
            if (error && String(error.message || '').toLowerCase().includes('user_selected_countdowns')) return res.json({ items: [] });
            if (error) return res.status(500).json({ error: error.message });
            res.json({ items: (data || []).map((row) => row.countdown_id) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/countdowns/:id/select', auth, async (req, res) => {
        try {
            await ensureUserNotRevoked(req.user_id);
            const countdownId = req.params.id;
            const { data: existing, error: existingError } = await supabase
                .from('user_selected_countdowns')
                .select('id')
                .eq('user_id', req.user_id)
                .eq('countdown_id', countdownId)
                .maybeSingle();
            if (existingError && !String(existingError.message || '').toLowerCase().includes('user_selected_countdowns')) return res.status(500).json({ error: existingError.message });

            if (existing?.id) {
                const { error } = await supabase.from('user_selected_countdowns').delete().eq('id', existing.id);
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ success: true, selected: false, message: 'Release unselected.' });
            }

            const { error } = await supabase.from('user_selected_countdowns').insert({ user_id: req.user_id, countdown_id: countdownId });
            if (error) return res.status(500).json({ error: error.message });
            res.json({ success: true, selected: true, message: 'Release selected.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/product-catalog', auth, async (req, res) => {
        try {
            await ensureUserNotRevoked(req.user_id);
            const site = normalizeSite(req.query.site);
            const search = sanitizeLike(req.query.search);
            const selectedOnly = req.query.selected_only === '1';
            const activeCatalog = await getActiveCatalog(supabase, site);
            if (!activeCatalog?.id) return res.json({ site, catalog: null, products: [] });

            let query = supabase
                .from('catalog_products')
                .select(`
          id, site, sku, product_name, brand, image_url, product_url,
          default_max_price, credit_cost, release_mode_default, is_enabled, metadata,
          user_product_preferences!left ( id, selected, run_mode, max_price )
        `)
                .eq('catalog_id', activeCatalog.id)
                .eq('is_enabled', true)
                .eq('user_product_preferences.user_id', req.user_id)
                .order('product_name', { ascending: true, nullsFirst: false })
                .order('sku', { ascending: true });
            if (search) query = query.or(`sku.ilike.%${search}%,product_name.ilike.%${search}%`);
            const { data, error } = await query;
            if (error) return res.status(500).json({ error: error.message });
            const products = (data || []).map((row) => {
                const pref = Array.isArray(row.user_product_preferences) ? row.user_product_preferences[0] || null : null;
                return {
                    id: row.id,
                    site: row.site,
                    sku: row.sku,
                    product_name: row.product_name || row.sku,
                    brand: row.brand || '',
                    image_url: row.image_url || '',
                    product_url: row.product_url || '',
                    default_max_price: row.default_max_price,
                    credit_cost: normalizeCreditCost(row.credit_cost),
                    release_mode_default: row.release_mode_default,
                    selected: pref ? !!pref.selected : false,
                    run_mode: pref?.run_mode || row.release_mode_default || 'current',
                    max_price: pref?.max_price ?? row.default_max_price,
                    preference_id: pref?.id || null,
                    metadata: row.metadata || {}
                };
            }).filter((row) => !selectedOnly || row.selected).sort((a, b) => {
                const av = a.metadata && a.metadata.virtual ? 1 : 0;
                const bv = b.metadata && b.metadata.virtual ? 1 : 0;
                if (av !== bv) return bv - av;
                return String(a.product_name || a.sku || '').localeCompare(String(b.product_name || b.sku || ''));
            });
            res.json({ site, catalog: activeCatalog, products });
        } catch (err) {
            const status = err.message === 'This account has been revoked' ? 403 : 500;
            res.status(status).json({ error: err.message });
        }
    });

    app.put('/product-preferences', auth, async (req, res) => {
        try {
            await ensureUserNotRevoked(req.user_id);
            const site = normalizeSite(req.body.site);
            const preferences = Array.isArray(req.body.preferences) ? req.body.preferences : [];
            const payload = preferences.map((row) => ({
                user_id: req.user_id,
                catalog_product_id: row.catalog_product_id,
                selected: !!row.selected,
                run_mode: normalizeRunMode(row.run_mode, 'current'),
                max_price: normalizeMaxPrice(row.max_price)
            }));
            if (!payload.length) return res.json({ success: true, updated: 0 });
            const productIds = [...new Set(payload.map((row) => row.catalog_product_id).filter(Boolean))];
            const { data: allowedProducts, error: allowedProductsError } = await supabase.from('catalog_products').select('id, site').in('id', productIds).eq('site', site);
            if (allowedProductsError) return res.status(500).json({ error: allowedProductsError.message });
            const allowedSet = new Set((allowedProducts || []).map((row) => row.id));
            const filteredPayload = payload.filter((row) => allowedSet.has(row.catalog_product_id));
            if (!filteredPayload.length) return res.status(400).json({ error: 'No valid catalog products provided.' });
            const { error } = await supabase.from('user_product_preferences').upsert(filteredPayload, { onConflict: 'user_id,catalog_product_id' });
            if (error) return res.status(500).json({ error: error.message });
            res.json({ success: true, updated: filteredPayload.length });
        } catch (err) {
            const status = err.message === 'This account has been revoked' ? 403 : 500;
            res.status(status).json({ error: err.message });
        }
    });

    app.post('/product-requests', auth, async (req, res) => {
        try {
            await ensureUserNotRevoked(req.user_id);
            const site = normalizeSite(req.body.site);
            if (!REQUESTABLE_SITES.has(site)) return res.status(400).json({ error: 'Invalid request site.' });
            const sku = String(req.body.sku || '').trim();
            if (!sku) return res.status(400).json({ error: 'SKU is required.' });

            const { data, error } = await supabase
                .from('product_requests')
                .insert({ user_id: req.user_id, site, sku, status: 'pending' })
                .select('*')
                .single();

            if (error) return res.status(500).json({ error: error.message });

            res.json({
                success: true,
                request: data,
                message: 'Request submitted for admin review.'
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin/product-requests', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const scopedUserIds = await getScopedUserIds(supabase, currentUser);
            let query = supabase
                .from('product_requests')
                .select(`id, user_id, site, sku, status, resolved_name, resolved_price, created_at, updated_at, users!left(email)`)
                .order('updated_at', { ascending: false })
                .limit(100);
            if (scopedUserIds && scopedUserIds.length) query = query.in('user_id', scopedUserIds);
            const { data, error } = await query;
            if (error && String(error.message || '').toLowerCase().includes('product_requests')) return res.json({ items: [] });
            if (error) return res.status(500).json({ error: error.message });
            res.json({ items: (data || []).map((row) => ({ ...row, user_email: row.users?.email || '', product_name: row.resolved_name, default_max_price: row.resolved_price })) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/catalog-products/upsert-by-sku', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const product = await upsertCatalogProductByLookup(supabase, normalizeSite(req.body.site), req.body.sku);
            res.json({ success: true, product, message: `${product.product_name} was added / updated.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/catalog-products/manual', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const product = await upsertCatalogProductManual(supabase, req.body || {});
            res.json({ success: true, product, message: `${product.product_name} was saved to the catalog.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/catalog-products/sync-target-pricing', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const updated = await syncTargetPricingFromAmazon(supabase);
            res.json({ success: true, updated, message: `Updated ${updated} target products from matching Amazon prices.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });


    app.post('/admin/product-requests/:id/approve', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const { data: requestRow, error: requestError } = await supabase
                .from('product_requests')
                .select('*')
                .eq('id', req.params.id)
                .single();
            if (requestError || !requestRow) return res.status(404).json({ error: 'Request not found.' });

            const product = await upsertCatalogProductByLookup(supabase, requestRow.site, requestRow.sku);
            const { error: updateError } = await supabase
                .from('product_requests')
                .update({
                    status: 'approved',
                    resolved_product_id: product.id,
                    resolved_name: product.product_name,
                    resolved_price: product.default_max_price,
                    updated_at: new Date().toISOString()
                })
                .eq('id', requestRow.id);
            if (updateError) return res.status(500).json({ error: updateError.message });

            res.json({ success: true, product, message: `${product.product_name} was approved and added to the catalog.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/admin/product-requests/:id/reject', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const { error } = await supabase
            .from('product_requests')
            .update({ status: 'rejected', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, message: 'Request rejected.' });
    });

    app.delete('/admin/product-requests/:id', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const { error } = await supabase.from('product_requests').delete().eq('id', req.params.id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, message: 'Request deleted.' });
    });


    app.post('/admin/catalog-products/import-list', auth, admin, async (req, res) => {
        try {
            if (!requireSuperAdmin(req, res)) return;
            const site = normalizeSite(req.body?.site);
            const items = await importCatalogList(supabase, site, req.body?.products || req.body?.data || []);
            res.json({ success: true, imported: items.length, items, message: `Imported ${items.length} ${site} products.` });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.get('/admin/catalog-products/export-lines', auth, admin, async (req, res) => {
        try {
            const site = normalizeSite(req.query.site);
            const batchSize = Math.max(1, Math.min(200, Number(req.query.batchSize || 29) || 29));
            const { data, error } = await supabase
                .from('catalog_products')
                .select('site, sku, product_name, default_max_price, metadata, is_enabled')
                .eq('site', site)
                .eq('is_enabled', true)
                .order('product_name', { ascending: true });
            if (error) throw new Error(error.message);
            const grouped = buildGroupedExportBatches(site, data || [], batchSize);
            res.json({
                success: true,
                site,
                total: grouped.total,
                batchSize,
                groups: grouped.groups,
                batches: grouped.batches
            });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.get('/admin/catalog-products', auth, admin, async (req, res) => {
        try {
            const site = req.query.site ? normalizeSite(req.query.site) : '';
            const search = sanitizeLike(req.query.search);
            let query = supabase
                .from('catalog_products')
                .select('id, site, sku, product_name, default_max_price, credit_cost, metadata, is_enabled, created_at')
                .order('created_at', { ascending: false })
                .limit(200);
            if (site) query = query.eq('site', site);
            if (search) query = query.or(`sku.ilike.%${search}%,product_name.ilike.%${search}%`);
            const { data, error } = await query;
            if (error) return res.status(500).json({ error: error.message });
            const items = (data || []).sort((a, b) => { const av = a.metadata && a.metadata.virtual ? 1 : 0; const bv = b.metadata && b.metadata.virtual ? 1 : 0; if (av !== bv) return bv - av; return String(a.product_name || a.sku || '').localeCompare(String(b.product_name || b.sku || '')); });
            res.json({ items });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });


    app.patch('/admin/catalog-products/:id', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const updates = {};
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'credit_cost')) updates.credit_cost = normalizeCreditCost(req.body.credit_cost);
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'default_max_price')) updates.default_max_price = normalizeMaxPrice(req.body.default_max_price);
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'product_name')) updates.product_name = String(req.body.product_name || '').trim();
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'brand')) updates.brand = String(req.body.brand || '').trim();
            if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update.' });
            const { data, error } = await supabase
                .from('catalog_products')
                .update(updates)
                .eq('id', req.params.id)
                .select('id, site, sku, product_name, default_max_price, credit_cost, metadata, is_enabled, created_at')
                .single();
            if (error) return res.status(500).json({ error: error.message });
            res.json({ success: true, product: data, message: `${data.product_name || data.sku || 'Product'} updated.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/admin/catalog-products/:id', auth, admin, async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        try {
            const { error } = await supabase.from('catalog_products').delete().eq('id', req.params.id);
            if (error) return res.status(500).json({ error: error.message });
            res.json({ success: true, message: 'Catalog product deleted.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin/product-preferences', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const site = req.query.site ? normalizeSite(req.query.site) : '';
            const search = sanitizeLike(req.query.search);
            const scopedUserIds = await getScopedUserIds(supabase, currentUser);

            let productQuery = supabase
                .from('user_product_preferences')
                .select(`user_id, selected, catalog_products!inner ( site, sku, product_name )`)
                .eq('selected', true);

            if (site) productQuery = productQuery.eq('catalog_products.site', site);
            if (scopedUserIds && scopedUserIds.length) productQuery = productQuery.in('user_id', scopedUserIds);
            if (search) productQuery = productQuery.or(`catalog_products.sku.ilike.%${search}%,catalog_products.product_name.ilike.%${search}%`);

            const { data: productData, error: productError } = await productQuery;
            if (productError) return res.status(500).json({ error: productError.message });

            let countdownRows = [];
            let countdownQuery = supabase
                .from('user_selected_countdowns')
                .select(`countdown_id, user_id, created_at, drop_countdowns!inner(id, site, label, scheduled_for)`)
                .order('created_at', { ascending: false });
            if (scopedUserIds && scopedUserIds.length) countdownQuery = countdownQuery.in('user_id', scopedUserIds);
            if (site) countdownQuery = countdownQuery.eq('drop_countdowns.site', site);
            if (search) countdownQuery = countdownQuery.or(`drop_countdowns.label.ilike.%${search}%`);
            const { data: countdownData, error: countdownError } = await countdownQuery;
            if (!countdownError && Array.isArray(countdownData)) countdownRows = countdownData;

            const allUserIds = [...new Set([...(productData || []).map((r) => r.user_id).filter(Boolean), ...(countdownRows || []).map((r) => r.user_id).filter(Boolean)])];
            if (!allUserIds.length) return res.json({ items: [] });

            let userQuery = supabase.from('users').select('id, email, owner_admin_id').in('id', allUserIds);
            if (search) userQuery = userQuery.ilike('email', `%${search}%`);
            const { data: usersData, error: usersError } = await userQuery;
            if (usersError) return res.status(500).json({ error: usersError.message });
            const userInfo = new Map((usersData || []).map((u) => [u.id, u]));

            const usersMap = new Map();
            (productData || []).forEach((row) => {
                const info = userInfo.get(row.user_id);
                if (!row.user_id || !info) return;
                if (!usersMap.has(row.user_id)) usersMap.set(row.user_id, { user_id: row.user_id, user_email: info.email || row.user_id, owner_admin_id: info.owner_admin_id || null, product_count: 0, countdown_count: 0 });
                usersMap.get(row.user_id).product_count += 1;
            });
            (countdownRows || []).forEach((row) => {
                const info = userInfo.get(row.user_id);
                if (!row.user_id || !info) return;
                if (!usersMap.has(row.user_id)) usersMap.set(row.user_id, { user_id: row.user_id, user_email: info.email || row.user_id, owner_admin_id: info.owner_admin_id || null, product_count: 0, countdown_count: 0 });
                usersMap.get(row.user_id).countdown_count += 1;
            });

            const items = [...usersMap.values()].map((row) => ({ ...row, selection_count: row.product_count + row.countdown_count }))
                .sort((a, b) => (a.user_email || '').localeCompare(b.user_email || ''));
            res.json({ items });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin/users/:userId/product-preferences', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const targetUserId = req.params.userId;
            if (!(await canAdminAccessUser(supabase, currentUser, targetUserId))) {
                return res.status(403).json({ error: 'You do not have access to this user.' });
            }
            const { data, error } = await supabase
                .from('user_product_preferences')
                .select(`
          id, selected, run_mode, max_price, updated_at,
          catalog_products!inner ( id, site, sku, product_name, image_url, default_max_price, product_url )
        `)
                .eq('user_id', targetUserId)
                .eq('selected', true)
                .order('updated_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });

            let countdownSelections = [];
            try {
                const { data: countdownRows, error: countdownError } = await supabase
                    .from('user_selected_countdowns')
                    .select(`countdown_id, created_at, drop_countdowns!inner(id, site, label, scheduled_for)`)
                    .eq('user_id', targetUserId)
                    .order('created_at', { ascending: false });
                if (!countdownError) {
                    countdownSelections = (countdownRows || []).map((row) => ({
                        countdown_id: row.countdown_id,
                        selected_at: row.created_at,
                        site: row.drop_countdowns?.site || '',
                        label: row.drop_countdowns?.label || '',
                        scheduled_for: row.drop_countdowns?.scheduled_for || null,
                        when_label: row.drop_countdowns?.scheduled_for ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(row.drop_countdowns.scheduled_for)) + ' ET' : ''
                    }));
                }
            } catch (_) { }

            res.json({
                items: (data || []).map((row) => ({
                    preference_id: row.id,
                    selected: !!row.selected,
                    run_mode: row.run_mode,
                    max_price: row.max_price,
                    updated_at: row.updated_at,
                    product: row.catalog_products
                })),
                countdown_selections: countdownSelections
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin/countdowns/selection-summary', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const scopedUserIds = await getScopedUserIds(supabase, currentUser);

            let query = supabase
                .from('user_selected_countdowns')
                .select(`
        id, user_id,
        drop_countdowns!inner ( id, site, label, scheduled_for, is_active )
      `);

            if (scopedUserIds && scopedUserIds.length) query = query.in('user_id', scopedUserIds);

            const { data, error } = await query;
            if (error) return res.status(500).json({ error: error.message });

            const map = new Map();

            (data || []).forEach((row) => {
                const countdown = row.drop_countdowns;
                if (!countdown?.id) return;
                if (!map.has(countdown.id)) {
                    map.set(countdown.id, {
                        id: countdown.id,
                        countdown_id: countdown.id,
                        label: countdown.label || '',
                        name: countdown.label || countdown.site || 'Release',
                        site: countdown.site || '',
                        scheduled_for: countdown.scheduled_for || null,
                        when_label: countdown.scheduled_for ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(countdown.scheduled_for)) + ' ET' : '',
                        selected_users: 0
                    });
                }
                map.get(countdown.id).selected_users += 1;
            });

            res.json({ items: [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin/countdowns/:countdownId/users', auth, admin, async (req, res) => {
        try {
            const currentUser = await getCurrentUser(req);
            const scopedUserIds = await getScopedUserIds(supabase, currentUser);
            const countdownId = req.params.countdownId;

            const { data: countdownRow, error: countdownError } = await supabase
                .from('drop_countdowns')
                .select('id, site, label, scheduled_for')
                .eq('id', countdownId)
                .maybeSingle();
            if (countdownError) return res.status(500).json({ error: countdownError.message });
            if (!countdownRow) return res.status(404).json({ error: 'Countdown not found.' });

            let query = supabase
                .from('user_selected_countdowns')
                .select('id, user_id, created_at')
                .eq('countdown_id', countdownId)
                .order('created_at', { ascending: false });

            if (scopedUserIds && scopedUserIds.length) query = query.in('user_id', scopedUserIds);

            const { data, error } = await query;
            if (error) return res.status(500).json({ error: error.message });

            const userIds = [...new Set((data || []).map((row) => row.user_id).filter(Boolean))];
            let userMap = new Map();
            if (userIds.length) {
                const { data: userRows, error: usersError } = await supabase
                    .from('users')
                    .select('id, email, owner_admin_id')
                    .in('id', userIds);
                if (usersError) return res.status(500).json({ error: usersError.message });
                userMap = new Map((userRows || []).map((row) => [row.id, row]));
            }

            const countdown = {
                id: countdownRow.id,
                site: countdownRow.site || '',
                label: countdownRow.label || '',
                name: countdownRow.label || countdownRow.site || 'Release',
                scheduled_for: countdownRow.scheduled_for || null,
                when_label: countdownRow.scheduled_for ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(countdownRow.scheduled_for)) + ' ET' : ''
            };

            const users = (data || []).map((row) => ({
                id: row.user_id,
                email: userMap.get(row.user_id)?.email || row.user_id,
                selected_at: row.created_at,
                selected_at_label: row.created_at ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(row.created_at)) + ' ET' : ''
            }));

            res.json({ countdown, users });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};