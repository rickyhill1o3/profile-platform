function normalizeSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (site !== "amazon" && site !== "target") {
    throw new Error("Invalid site. Expected amazon or target.");
  }
  return site;
}

function normalizeRunMode(value, fallback = "current") {
  const mode = String(value || fallback).trim().toLowerCase();
  if (mode !== "current" && mode !== "next") {
    return fallback;
  }
  return mode;
}

function normalizeMaxPrice(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Invalid max price");
  }
  return Number(parsed.toFixed(2));
}

function sanitizeLike(value) {
  return String(value || "").replace(/[%_]/g, "").trim();
}

async function getScopedUserIds(supabase, currentUser) {
  if (currentUser.role === "super_admin") {
    return null;
  }

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("owner_admin_id", currentUser.id);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row) => row.id);
}

async function canAdminAccessUser(supabase, currentUser, targetUserId) {
  if (currentUser.role === "super_admin") {
    return true;
  }

  const { data, error } = await supabase
    .from("users")
    .select("id, owner_admin_id")
    .eq("id", targetUserId)
    .single();

  if (error || !data) {
    return false;
  }

  return data.owner_admin_id === currentUser.id;
}

module.exports = function registerProductCatalogRoutes({
  app,
  supabase,
  auth,
  admin,
  getCurrentUser,
  ensureUserNotRevoked
}) {
  app.get("/product-catalog", auth, async (req, res) => {
    try {
      await ensureUserNotRevoked(req.user_id);
      const site = normalizeSite(req.query.site);
      const search = sanitizeLike(req.query.search);
      const selectedOnly = req.query.selected_only === "1";

      const { data: activeCatalog, error: catalogError } = await supabase
        .from("product_catalogs")
        .select("id, site, name, export_date")
        .eq("site", site)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (catalogError) {
        return res.status(500).json({ error: catalogError.message });
      }

      if (!activeCatalog?.id) {
        return res.json({
          site,
          catalog: null,
          products: []
        });
      }

      let query = supabase
        .from("catalog_products")
        .select(`
          id,
          site,
          sku,
          product_name,
          brand,
          image_url,
          product_url,
          default_max_price,
          release_mode_default,
          is_enabled,
          metadata,
          user_product_preferences!left (
            id,
            selected,
            run_mode,
            max_price
          )
        `)
        .eq("catalog_id", activeCatalog.id)
        .eq("is_enabled", true)
        .eq("user_product_preferences.user_id", req.user_id)
        .order("product_name", { ascending: true, nullsFirst: false })
        .order("sku", { ascending: true });

      if (search) {
        query = query.or(`sku.ilike.%${search}%,product_name.ilike.%${search}%`);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const products = (data || [])
        .map((row) => {
          const pref = Array.isArray(row.user_product_preferences)
            ? row.user_product_preferences[0] || null
            : null;

          return {
            id: row.id,
            site: row.site,
            sku: row.sku,
            product_name: row.product_name || row.sku,
            brand: row.brand || "",
            image_url: row.image_url || "",
            product_url: row.product_url || "",
            default_max_price: row.default_max_price,
            release_mode_default: row.release_mode_default,
            selected: pref ? !!pref.selected : false,
            run_mode: pref?.run_mode || row.release_mode_default || "current",
            max_price: pref?.max_price ?? row.default_max_price,
            preference_id: pref?.id || null,
            metadata: row.metadata || {}
          };
        })
        .filter((row) => !selectedOnly || row.selected);

      res.json({
        site,
        catalog: activeCatalog,
        products
      });
    } catch (err) {
      const status = err.message === "This account has been revoked" ? 403 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.put("/product-preferences", auth, async (req, res) => {
    try {
      await ensureUserNotRevoked(req.user_id);

      const site = normalizeSite(req.body.site);
      const preferences = Array.isArray(req.body.preferences) ? req.body.preferences : [];

      const payload = preferences.map((row) => ({
        user_id: req.user_id,
        catalog_product_id: row.catalog_product_id,
        selected: !!row.selected,
        run_mode: normalizeRunMode(row.run_mode, "current"),
        max_price: normalizeMaxPrice(row.max_price)
      }));

      if (!payload.length) {
        return res.json({ success: true, updated: 0 });
      }

      const productIds = [...new Set(payload.map((row) => row.catalog_product_id).filter(Boolean))];

      const { data: allowedProducts, error: allowedProductsError } = await supabase
        .from("catalog_products")
        .select("id, site")
        .in("id", productIds)
        .eq("site", site);

      if (allowedProductsError) {
        return res.status(500).json({ error: allowedProductsError.message });
      }

      const allowedSet = new Set((allowedProducts || []).map((row) => row.id));
      const filteredPayload = payload.filter((row) => allowedSet.has(row.catalog_product_id));

      if (!filteredPayload.length) {
        return res.status(400).json({ error: "No valid catalog products provided." });
      }

      const { error } = await supabase
        .from("user_product_preferences")
        .upsert(filteredPayload, { onConflict: "user_id,catalog_product_id" });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      res.json({
        success: true,
        updated: filteredPayload.length
      });
    } catch (err) {
      const status = err.message === "This account has been revoked" ? 403 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.get("/admin/product-preferences", auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const site = req.query.site ? normalizeSite(req.query.site) : "";
      const search = sanitizeLike(req.query.search);
      const scopedUserIds = await getScopedUserIds(supabase, currentUser);

      let query = supabase
        .from("user_product_preferences")
        .select(`
          id,
          user_id,
          selected,
          run_mode,
          max_price,
          updated_at,
          users!inner (
            id,
            email,
            owner_admin_id
          ),
          catalog_products!inner (
            id,
            site,
            sku,
            product_name,
            default_max_price,
            image_url
          )
        `)
        .eq("selected", true)
        .order("updated_at", { ascending: false });

      if (site) {
        query = query.eq("catalog_products.site", site);
      }

      if (scopedUserIds && scopedUserIds.length) {
        query = query.in("user_id", scopedUserIds);
      }

      if (search) {
        query = query.or(`catalog_products.sku.ilike.%${search}%,catalog_products.product_name.ilike.%${search}%,users.email.ilike.%${search}%`);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const rows = (data || []).map((row) => ({
        preference_id: row.id,
        user_id: row.user_id,
        user_email: row.users?.email || "",
        owner_admin_id: row.users?.owner_admin_id || null,
        site: row.catalog_products?.site || "",
        sku: row.catalog_products?.sku || "",
        product_name: row.catalog_products?.product_name || row.catalog_products?.sku || "",
        image_url: row.catalog_products?.image_url || "",
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

  app.get("/admin/users/:userId/product-preferences", auth, admin, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      const targetUserId = req.params.userId;

      if (!(await canAdminAccessUser(supabase, currentUser, targetUserId))) {
        return res.status(403).json({ error: "You do not have access to this user." });
      }

      const { data, error } = await supabase
        .from("user_product_preferences")
        .select(`
          id,
          selected,
          run_mode,
          max_price,
          updated_at,
          catalog_products!inner (
            id,
            site,
            sku,
            product_name,
            image_url,
            default_max_price,
            product_url
          )
        `)
        .eq("user_id", targetUserId)
        .order("updated_at", { ascending: false });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      res.json({
        items: (data || []).map((row) => ({
          preference_id: row.id,
          selected: !!row.selected,
          run_mode: row.run_mode,
          max_price: row.max_price,
          updated_at: row.updated_at,
          product: row.catalog_products
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
