const cheerio = require("cheerio");

const SUPPORTED_SITES = new Set(["amazon", "target", "walmart", "general", "supreme", "pokemon"]);
const REQUESTABLE_SITES = new Set(["amazon", "target", "walmart", "general"]);
const VIRTUAL_SITE_DEFAULTS = {
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

  const { data: existingProducts, error: existingProductsError } = await supabase
    .from("catalog_products")
    .select("id")
    .eq("catalog_id", activeCatalog.id)
    .eq("site", site)
    .limit(1);

  if (existingProductsError) throw new Error(existingProductsError.message);

  if (!Array.isArray(existingProducts) || existingProducts.length === 0) {
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

  if (site === "general") {
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

  const lookup = existing || await bestEffortLookupBySku(normalizedSite, sku);
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

module.exports = function registerProductCatalogRoutes({ app, supabase, auth, admin, getCurrentUser, ensureUserNotRevoked }) {
  app.get('/public/countdowns', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('drop_countdowns')
        .select(`*, countdown_products(product_id, catalog_products(id, site, sku, product_name))`)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('scheduled_for', { ascending: true });
      if (error && String(error.message || '').toLowerCase().includes('drop_countdowns')) return res.json({ items: [] });
      if (error) return res.status(500).json({ error: error.message });
      const items = (data || []).map((item) => ({
        ...item,
        linked_products: Array.isArray(item.countdown_products)
          ? item.countdown_products.map((row) => row.catalog_products).filter(Boolean)
          : []
      }));
      res.json({ items });
    } catch (err) {
      res.json({ items: [] });
    }
  });

  app.get('/admin/catalog-products', auth, admin, async (req, res) => {
    try {
      const site = normalizeSite(req.query.site || 'general');
      const activeCatalog = await getActiveCatalog(supabase, site);
      if (!activeCatalog?.id) return res.json({ items: [] });
      const { data, error } = await supabase
        .from('catalog_products')
        .select('id, site, sku, product_name, default_max_price, metadata')
        .eq('catalog_id', activeCatalog.id)
        .eq('site', site)
        .eq('is_enabled', true)
        .order('product_name', { ascending: true, nullsFirst: false })
        .order('sku', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ items: data || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/countdowns', auth, admin, async (req, res) => {
    const { data, error } = await supabase
      .from('drop_countdowns')
      .select(`*, countdown_products(product_id, catalog_products(id, site, sku, product_name))`)
      .order('sort_order', { ascending: true })
      .order('scheduled_for', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const items = (data || []).map((item) => ({
      ...item,
      linked_products: Array.isArray(item.countdown_products)
        ? item.countdown_products.map((row) => row.catalog_products).filter(Boolean)
        : []
    }));
    res.json({ items });
  });

  app.post('/admin/countdowns', auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const site = normalizeSite(req.body.site);
      const label = String(req.body.label || '').trim() || (site === 'general' ? 'General Release' : site.charAt(0).toUpperCase() + site.slice(1));
      const scheduled_for = req.body.scheduled_for;
      const description = String(req.body.description || '').trim();
      const product_ids = Array.isArray(req.body.product_ids) ? req.body.product_ids.filter(Boolean) : [];
      if (!scheduled_for) return res.status(400).json({ error: 'scheduled_for is required' });
      const payload = {
        site,
        label,
        description,
        scheduled_for,
        sort_order: Number(req.body.sort_order || 0),
        is_active: req.body.is_active !== false,
        created_by: currentUser.id
      };
      const { data, error } = await supabase.from('drop_countdowns').insert(payload).select('*').single();
      if (error) return res.status(500).json({ error: error.message });
      if (product_ids.length) {
        const rows = product_ids.map((product_id) => ({ countdown_id: data.id, product_id }));
        const { error: linkError } = await supabase.from('countdown_products').insert(rows);
        if (linkError) return res.status(500).json({ error: linkError.message });
      }
      res.json({ item: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/admin/countdowns/:id', auth, admin, async (req, res) => {
    try {
      const payload = {
        site: normalizeSite(req.body.site),
        label: String(req.body.label || '').trim(),
        description: String(req.body.description || '').trim(),
        scheduled_for: req.body.scheduled_for,
        sort_order: Number(req.body.sort_order || 0),
        is_active: req.body.is_active !== false
      };
      const product_ids = Array.isArray(req.body.product_ids) ? req.body.product_ids.filter(Boolean) : [];
      const { data, error } = await supabase.from('drop_countdowns').update(payload).eq('id', req.params.id).select('*').single();
      if (error) return res.status(500).json({ error: error.message });
      const { error: deleteLinksError } = await supabase.from('countdown_products').delete().eq('countdown_id', req.params.id);
      if (deleteLinksError) return res.status(500).json({ error: deleteLinksError.message });
      if (product_ids.length) {
        const rows = product_ids.map((product_id) => ({ countdown_id: req.params.id, product_id }));
        const { error: linkError } = await supabase.from('countdown_products').insert(rows);
        if (linkError) return res.status(500).json({ error: linkError.message });
      }
      res.json({ item: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/admin/countdowns/:id', auth, admin, async (req, res) => {
    await supabase.from('countdown_products').delete().eq('countdown_id', req.params.id);
    const { error } = await supabase.from('drop_countdowns').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
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
          default_max_price, release_mode_default, is_enabled, metadata,
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
          release_mode_default: row.release_mode_default,
          selected: pref ? !!pref.selected : false,
          run_mode: pref?.run_mode || row.release_mode_default || 'current',
          max_price: pref?.max_price ?? row.default_max_price,
          preference_id: pref?.id || null,
          metadata: row.metadata || {}
        };
      }).filter((row) => !selectedOnly || row.selected);
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
      if (!REQUESTABLE_SITES.has(site)) return res.status(400).json({ error: 'Request site must be amazon, target, walmart, or general.' });
      const sku = String(req.body.sku || '').trim();
      if (!sku) return res.status(400).json({ error: 'SKU is required.' });

      let requestRow = null;
      try {
        const { data, error } = await supabase.from('product_requests').insert({ user_id: req.user_id, site, sku, status: 'processing' }).select('*').single();
        if (!error) requestRow = data;
      } catch (_) {}

      let product = null;
      let status = 'resolved';
      try {
        product = await upsertCatalogProductByLookup(supabase, site, sku);
      } catch (lookupErr) {
        status = 'queued';
      }

      if (requestRow?.id) {
        const update = product ? {
          status,
          resolved_product_id: product.id,
          resolved_name: product.product_name,
          resolved_price: product.default_max_price,
          updated_at: new Date().toISOString()
        } : { status, updated_at: new Date().toISOString() };
        await supabase.from('product_requests').update(update).eq('id', requestRow.id);
      }

      res.json({
        success: true,
        status,
        product,
        message: product ? `SKU ${sku} was added to the ${site} catalog.` : `SKU ${sku} was queued for admin review.`
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
    try {
      const product = await upsertCatalogProductByLookup(supabase, normalizeSite(req.body.site), req.body.sku);
      res.json({ success: true, product, message: `${product.product_name} was added / updated.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/catalog-products/sync-target-pricing', auth, admin, async (req, res) => {
    try {
      const updated = await syncTargetPricingFromAmazon(supabase);
      res.json({ success: true, updated, message: `Updated ${updated} target products from matching Amazon prices.` });
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
      let query = supabase
        .from('user_product_preferences')
        .select(`
          id, user_id, selected, run_mode, max_price, updated_at,
          users!inner ( id, email, owner_admin_id ),
          catalog_products!inner ( id, site, sku, product_name, default_max_price, image_url )
        `)
        .eq('selected', true)
        .order('updated_at', { ascending: false });
      if (site) query = query.eq('catalog_products.site', site);
      if (scopedUserIds && scopedUserIds.length) query = query.in('user_id', scopedUserIds);
      if (search) query = query.or(`catalog_products.sku.ilike.%${search}%,catalog_products.product_name.ilike.%${search}%,users.email.ilike.%${search}%`);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      const rows = (data || []).map((row) => ({
        preference_id: row.id,
        user_id: row.user_id,
        user_email: row.users?.email || '',
        owner_admin_id: row.users?.owner_admin_id || null,
        selected: !!row.selected,
        site: row.catalog_products?.site || '',
        sku: row.catalog_products?.sku || '',
        product_name: row.catalog_products?.product_name || row.catalog_products?.sku || '',
        image_url: row.catalog_products?.image_url || '',
        run_mode: row.run_mode,
        max_price: row.max_price,
        default_max_price: row.catalog_products?.default_max_price ?? null,
        updated_at: row.updated_at
      }));
      res.json({ items: rows });
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
      res.json({ items: (data || []).map((row) => ({ preference_id: row.id, selected: !!row.selected, run_mode: row.run_mode, max_price: row.max_price, updated_at: row.updated_at, product: row.catalog_products })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
