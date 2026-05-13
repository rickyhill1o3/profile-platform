function normalizeSite(site='') {
  return String(site || '').trim().toLowerCase();
}

function cleanNumber(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function registerProductCatalogRoutes({ app, supabase, auth }) {

  app.get('/admin/catalog-products', auth, async (req,res)=>{
    try {
      const site = normalizeSite(req.query.site || '');
      const search = String(req.query.search || '').trim();

      let query = supabase
        .from('catalog_products')
        .select('*')
        .order('product_name', { ascending: true })
        .limit(1000);

      if (site && site !== 'all') query = query.eq('site', site);

      if (search) {
        query = query.or(`product_name.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      return res.json({ items: data || [] });
    } catch (err) {
      console.error('catalog-products error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/catalog-products', auth, async (req,res)=>{
    try {
      const site = normalizeSite(req.query.site || '');
      const search = String(req.query.search || '').trim();

      let query = supabase
        .from('catalog_products')
        .select('*')
        .eq('is_enabled', true)
        .limit(1000);

      if (site && site !== 'all') query = query.eq('site', site);

      if (search) {
        query = query.or(`product_name.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      return res.json({ items: data || [] });
    } catch (err) {
      console.error('catalog-products public error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/admin/catalog-products/:id', auth, async (req, res) => {
    try {
      const updates = {};
      if ('product_name' in req.body) updates.product_name = req.body.product_name;
      if ('default_max_price' in req.body) updates.default_max_price = cleanNumber(req.body.default_max_price);
      if ('credit_cost' in req.body) updates.credit_cost = cleanNumber(req.body.credit_cost);

      const { data, error } = await supabase
        .from('catalog_products')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      return res.json({ message: 'Product updated.', item: data });
    } catch (err) {
      console.error('patch catalog product error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/admin/catalog-products/:id', auth, async (req, res) => {
    try {
      const { error } = await supabase
        .from('catalog_products')
        .delete()
        .eq('id', req.params.id);

      if (error) throw error;
      return res.json({ message: 'Product deleted.' });
    } catch (err) {
      console.error('delete catalog product error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/catalog-products/manual', auth, async (req, res) => {
    try {
      const payload = {
        site: normalizeSite(req.body.site),
        sku: String(req.body.sku || '').trim(),
        product_name: req.body.product_name || 'Unknown Product',
        default_max_price: cleanNumber(req.body.default_max_price),
        credit_cost: cleanNumber(req.body.credit_cost) || 0,
        brand: req.body.brand || '',
        image_url: req.body.image_url || '',
        product_url: req.body.product_url || '',
        is_enabled: true
      };

      const { data, error } = await supabase
        .from('catalog_products')
        .upsert(payload, { onConflict: 'site,sku' })
        .select()
        .single();

      if (error) throw error;
      return res.json({ message: 'Product saved.', item: data });
    } catch (err) {
      console.error('manual product error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/catalog-products/import-list', auth, async (req, res) => {
    try {
      const products = Array.isArray(req.body.products) ? req.body.products : [];
      if (!products.length) {
        return res.status(400).json({ error: 'No products provided.' });
      }

      const rows = products.map((p) => ({
        site: normalizeSite(req.body.site || p.site),
        sku: String(p.sku || '').trim(),
        product_name: p.product_name || p.name || 'Unknown Product',
        default_max_price: cleanNumber(p.default_max_price || p.price),
        credit_cost: cleanNumber(p.credit_cost || p.credits) || 0,
        brand: p.brand || '',
        image_url: p.image_url || '',
        product_url: p.product_url || '',
        is_enabled: true
      }));

      const { error } = await supabase
        .from('catalog_products')
        .upsert(rows, { onConflict: 'site,sku' });

      if (error) throw error;
      return res.json({ message: 'Products imported.', imported: rows.length });
    } catch (err) {
      console.error('import list error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/product-groups', auth, async (req, res) => {
    try {
      const site = normalizeSite(req.query.site || 'target');

      const { data: groups, error: groupError } = await supabase
        .from('product_groups')
        .select('*')
        .eq('site', site)
        .eq('is_active', true);

      if (groupError) throw groupError;

      const groupIds = (groups || []).map(g => g.id);

      let skuRows = [];
      if (groupIds.length) {
        const { data, error } = await supabase
          .from('product_group_skus')
          .select('*')
          .in('product_group_id', groupIds);

        if (error) throw error;
        skuRows = data || [];
      }

      const productIds = skuRows.map(r => r.catalog_product_id).filter(Boolean);

      let catalogProducts = [];
      if (productIds.length) {
        const { data, error } = await supabase
          .from('catalog_products')
          .select('*')
          .in('id', productIds);

        if (error) throw error;
        catalogProducts = data || [];
      }

      const productMap = {};
      catalogProducts.forEach(p => {
        productMap[p.id] = p;
      });

      const finalGroups = (groups || []).map(group => ({
        ...group,
        product_group_skus: skuRows
          .filter(s => s.product_group_id === group.id)
          .map(s => ({
            ...s,
            catalog_products: productMap[s.catalog_product_id] || null
          }))
      }));

      return res.json({ products: finalGroups });
    } catch (err) {
      console.error('product-groups error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/product-groups', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('product_groups')
        .insert(req.body)
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    } catch (err) {
      console.error('create product group error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/admin/product-groups/:id', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('product_groups')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    } catch (err) {
      console.error('update product group error', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/product-group-skus', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('product_group_skus')
        .insert(req.body)
        .select()
        .single();

      if (error) throw error;
      return res.json(data);
    } catch (err) {
      console.error('attach sku error', err);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = registerProductCatalogRoutes;
module.exports.registerProductCatalogRoutes = registerProductCatalogRoutes;
