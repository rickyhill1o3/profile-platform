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

  app.put('/product-preferences', auth, async (req, res) => {
    try {
      const {
        site,
        selections
      } = req.body || {};

      if (!site) {
        return res.status(400).json({ error: 'Missing site' });
      }

      const selectedRows = Array.isArray(selections)
        ? selections
        : [];

      await supabase
        .from('user_product_selections')
        .delete()
        .eq('user_id', req.user_id)
        .eq('site', site);

      if (selectedRows.length > 0) {
        const insertRows = selectedRows.map((row) => ({
          user_id: req.user_id,
          site,
          product_id: row.product_id,
          selected: true,
          mode: row.mode || 'normal',
          max_price: row.max_price || null
        }));

        const { error } = await supabase
          .from('user_product_selections')
          .insert(insertRows);

        if (error) {
          return res.status(500).json({ error: error.message });
        }
      }

      return res.json({ success: true });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/product-preferences', auth, async (req, res) => {
    try {
      const site = String(req.query.site || '').trim();

      let query = supabase
        .from('user_product_selections')
        .select('*')
        .eq('user_id', req.user_id)
        .eq('selected', true);

      if (site) {
        query = query.eq('site', site);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({
        items: data || []
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/product-preferences', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('user_product_selections')
        .select(`
        *,
        users:user_id (
          id,
          email
        ),
        catalog_products:product_id (
          id,
          site,
          sku,
          product_name,
          image_url,
          credit_cost
        )
      `)
        .eq('selected', true)
        .order('updated_at', { ascending: false });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const grouped = {};

      for (const row of data || []) {
        const userId = row.user_id;

        if (!grouped[userId]) {
          grouped[userId] = {
            user_id: userId,
            user_email: row.users?.email || 'Unknown',
            selection_count: 0,
            products: []
          };
        }

        grouped[userId].selection_count++;

        grouped[userId].products.push({
          site: row.catalog_products?.site || '',
          sku: row.catalog_products?.sku || '',
          product_name: row.catalog_products?.product_name || '',
          mode: row.mode || '',
          max_price: row.max_price || '',
          product_id: row.product_id
        });
      }

      return res.json({
        items: Object.values(grouped)
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
    try {
      const { data, error } = await supabase
        .from('user_product_selections')
        .select(`
        *,
        users:user_id (
          email
        ),
        catalog_products:product_id (
          product_name,
          sku,
          site
        )
      `)
        .order('updated_at', { ascending: false })
        .limit(100);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({
        items: data || []
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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

  app.get('/target-recommended-lists', auth, async (req, res) => {
    return res.json({
      items: []
    });
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
