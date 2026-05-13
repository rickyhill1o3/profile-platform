function normalizeSite(site = '') {
  return String(site || '').trim().toLowerCase();
}

function registerProductCatalogRoutes({ app, supabase, auth }) {

  app.get('/product-catalog', auth, async (req, res) => {
    try {
      const site = normalizeSite(req.query.site || '');
      let query = supabase.from('catalog_products').select('*').eq('is_enabled', true).limit(250);
      if (site) query = query.eq('site', site);
      const { data, error } = await query.order('product_name');
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ products: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/product-preferences', auth, async (req, res) => {
    return res.json({ items: [] });
  });

  app.get('/admin/product-selection-export-users', auth, async (req, res) => {
    try {
      const { data, error } = await supabase.from('users').select('id,email').limit(100);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ products: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/product-selection-changes', auth, async (req, res) => {
    return res.json({ items: [] });
  });

  app.get('/public/countdowns', async (req, res) => {
    return res.json({ items: [] });
  });

  app.get('/countdown-selections', auth, async (req, res) => {
    return res.json({ items: [] });
  });

  app.get('/admin/countdowns', auth, async (req, res) => {
    return res.json({ items: [] });
  });

  app.get('/admin/target-recommended-list-name', auth, async (req, res) => {
    return res.json({ name: '' });
  });


  app.get('/admin/catalog-products', auth, async (req, res) => {
    try {
      const site = normalizeSite(req.query.site || '');
      const search = String(req.query.search || '').trim();

      let query = supabase
        .from('catalog_products')
        .select('*')
        .order('product_name', { ascending: true })
        .limit(500);

      if (site) query = query.eq('site', site);

      if (search) {
        query = query.or(`product_name.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({ products: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/catalog-products', auth, async (req, res) => {
    try {
      const search = String(req.query.search || '').trim();

      let query = supabase
        .from('catalog_products')
        .select('*')
        .limit(100);

      if (search) {
        query = query.or(`product_name.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({ products: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
  app.get('/admin/countdowns/selection-summary', auth, async (req, res) => {
    return res.json({ items: [] });
  });

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
            catalog_products (*)
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
      const { data, error } = await supabase
        .from('product_groups')
        .insert(req.body || {})
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
      const { data, error } = await supabase
        .from('product_group_skus')
        .insert(req.body || {})
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
}

module.exports = registerProductCatalogRoutes;
module.exports.registerProductCatalogRoutes = registerProductCatalogRoutes;
