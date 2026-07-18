const { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder } = require('discord.js');
const jwt = require('jsonwebtoken');

function cleanText(v, n = 2000) { return String(v || '').replace(/\u0000/g, '').slice(0, n); }
function isSuper(user, superEmail) { return user?.role === 'super_admin' || String(user?.email || '').toLowerCase() === String(superEmail || '').toLowerCase(); }
function hasManageGuild(permissionValue) {
  try {
    const p = BigInt(String(permissionValue || '0'));
    return (p & 8n) === 8n || (p & 32n) === 32n;
  } catch (_) { return false; }
}

module.exports = function registerSuccessNetwork({ app, supabase, auth, admin, getCurrentUser, SUPER_ADMIN_EMAIL }) {
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  const clientId = String(process.env.DISCORD_BOT_CLIENT_ID || process.env.DISCORD_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  let client = null;
  let ready = false;

  function frontendBase(req) {
    return String(process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  }
  function oauthRedirect(req) {
    return String(process.env.DISCORD_SUCCESS_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord-success/callback`);
  }

  async function ensureClient() {
    if (!token || client) return client;
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel, Partials.Message]
    });
    client.once('ready', () => { ready = true; console.log(`[success-network] Discord bot ready as ${client.user.tag}`); });
    client.on('error', err => console.error('[success-network] client error', err));
    client.on('messageCreate', handleMessage);
    await client.login(token);
    return client;
  }

  async function getConnection(userId) {
    const { data } = await supabase.from('discord_success_connections').select('*').eq('admin_user_id', userId).maybeSingle();
    return data || null;
  }
  function allowedGuildIds(connection) {
    return new Set((Array.isArray(connection?.manageable_guilds) ? connection.manageable_guilds : []).map(g => String(g.id)));
  }
  async function requireAllowedGuild(user, guildId) {
    if (isSuper(user, SUPER_ADMIN_EMAIL)) return true;
    const connection = await getConnection(user.id);
    if (!connection || !allowedGuildIds(connection).has(String(guildId))) throw new Error('Reconnect Discord and choose a server you manage.');
    return true;
  }

  async function getMasterDestination() {
    const { data } = await supabase.from('discord_success_master_settings').select('*').eq('id', 'master').maybeSingle();
    return data || null;
  }

  async function handleMessage(message) {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const { data: source } = await supabase.from('discord_success_channels')
        .select('*').eq('guild_id', message.guild.id).eq('source_channel_id', message.channel.id).eq('is_active', true).maybeSingle();
      if (!source) return;

      const attachments = [...message.attachments.values()].map(a => ({
        id: a.id, name: a.name, url: a.url, proxy_url: a.proxyURL, content_type: a.contentType, size: a.size,
        width: a.width || null, height: a.height || null
      }));
      const stickers = [...message.stickers.values()].map(s => ({ id: s.id, name: s.name, url: s.url || null }));
      const jumpUrl = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
      const row = {
        discord_message_id: message.id,
        guild_id: message.guild.id,
        guild_name: cleanText(message.guild.name, 200),
        source_channel_id: message.channel.id,
        source_channel_name: cleanText(message.channel.name, 200),
        source_admin_user_id: source.admin_user_id || null,
        public_approved: source.allow_public_homepage === true,
        author_discord_id: message.author.id,
        author_name: cleanText(message.member?.displayName || message.author.globalName || message.author.username, 200),
        author_avatar_url: message.author.displayAvatarURL({ size: 256 }),
        message_text: cleanText(message.content, 4000),
        attachments,
        stickers,
        source_message_url: jumpUrl,
        forwarding_status: 'received',
        posted_at: message.createdAt.toISOString()
      };
      const { data: inserted, error } = await supabase.from('discord_success_posts').upsert(row, { onConflict: 'discord_message_id' }).select('*').single();
      if (error) throw error;

      const master = await getMasterDestination();
      if (!master?.guild_id || !master?.channel_id) {
        await supabase.from('discord_success_posts').update({ forwarding_status: 'waiting_for_master' }).eq('id', inserted.id);
        return;
      }
      const guild = await client.guilds.fetch(master.guild_id);
      const channel = await guild.channels.fetch(master.channel_id);
      if (!channel?.isTextBased()) throw new Error('Master success destination is not a text channel');

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({ name: row.author_name || 'Discord member', iconURL: row.author_avatar_url || undefined })
        .setTitle(`Success from ${row.guild_name}`)
        .setDescription(row.message_text || (attachments.length ? 'Shared a success attachment.' : 'Shared a success.'))
        .addFields(
          { name: 'Source', value: `${row.guild_name} • #${row.source_channel_name}`, inline: true },
          { name: 'Posted by', value: row.author_name || 'Unknown', inline: true },
          { name: 'Original', value: `[Open message](${jumpUrl})`, inline: true }
        )
        .setTimestamp(message.createdAt);
      const firstImage = attachments.find(a => String(a.content_type || '').startsWith('image/'));
      if (firstImage) embed.setImage(firstImage.url);
      const extraLinks = attachments.filter(a => !firstImage || a.id !== firstImage.id).slice(0, 8).map(a => `[${a.name || 'Attachment'}](${a.url})`);
      if (extraLinks.length) embed.addFields({ name: 'More attachments', value: extraLinks.join('\n').slice(0, 1024) });

      const forwarded = await channel.send({ embeds: [embed] });
      await supabase.from('discord_success_posts').update({
        forwarding_status: 'forwarded', forwarded_message_id: forwarded.id, forwarded_at: new Date().toISOString(), forwarding_error: null
      }).eq('id', inserted.id);
    } catch (err) {
      console.error('[success-network] forward failed', err);
      if (message?.id) await supabase.from('discord_success_posts').update({ forwarding_status: 'failed', forwarding_error: cleanText(err.message, 1000) }).eq('discord_message_id', message.id).catch(() => {});
    }
  }

  app.get('/admin/success-network/connect-url', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!clientId || !clientSecret || !jwtSecret) return res.status(500).json({ error: 'Discord OAuth is not fully configured.' });
      const state = jwt.sign({ purpose: 'discord_success_install', user_id: user.id }, jwtSecret, { expiresIn: '15m' });
      const url = new URL('https://discord.com/oauth2/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', oauthRedirect(req));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'identify guilds bot applications.commands');
      url.searchParams.set('permissions', '68608');
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'consent');
      res.json({ url: url.toString() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/auth/discord-success/callback', async (req, res) => {
    const base = frontendBase(req);
    try {
      const decoded = jwt.verify(String(req.query.state || ''), jwtSecret);
      if (decoded?.purpose !== 'discord_success_install' || !decoded.user_id) throw new Error('Invalid or expired Discord connection request.');
      const code = String(req.query.code || '').trim();
      if (!code) throw new Error('Discord did not return an authorization code.');
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: oauthRedirect(req) })
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson.access_token) throw new Error(tokenJson.error_description || tokenJson.error || 'Discord authorization failed.');
      const headers = { Authorization: `Bearer ${tokenJson.access_token}` };
      const [userRes, guildsRes] = await Promise.all([
        fetch('https://discord.com/api/users/@me', { headers }),
        fetch('https://discord.com/api/users/@me/guilds', { headers })
      ]);
      const discordUser = await userRes.json().catch(() => ({}));
      const oauthGuilds = await guildsRes.json().catch(() => ([]));
      if (!userRes.ok || !discordUser.id) throw new Error('Could not read your Discord account.');
      await ensureClient();
      const manageable = (Array.isArray(oauthGuilds) ? oauthGuilds : [])
        .filter(g => g.owner || hasManageGuild(g.permissions))
        .filter(g => client?.guilds?.cache?.has(String(g.id)))
        .map(g => ({ id: String(g.id), name: cleanText(g.name, 200), icon: g.icon || null }));
      const row = {
        admin_user_id: decoded.user_id,
        discord_user_id: String(discordUser.id),
        discord_username: cleanText(discordUser.global_name || discordUser.username, 200),
        manageable_guilds: manageable,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const { error } = await supabase.from('discord_success_connections').upsert(row, { onConflict: 'admin_user_id' });
      if (error) throw error;
      return res.redirect(`${base}/success-network.html?discord_success_connected=1`);
    } catch (err) {
      return res.redirect(`${base}/success-network.html?discord_success_error=${encodeURIComponent(err.message || 'Discord connection failed')}`);
    }
  });

  app.get('/admin/success-network/status', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req);
    const superAdmin = isSuper(user, SUPER_ADMIN_EMAIL);
    let sourceQuery = supabase.from('discord_success_channels').select('*').order('created_at', { ascending: false });
    if (!superAdmin) sourceQuery = sourceQuery.eq('admin_user_id', user.id);
    const [{ data: sources = [] }, { data: master }, { count }, connection] = await Promise.all([
      sourceQuery,
      supabase.from('discord_success_master_settings').select('*').eq('id', 'master').maybeSingle(),
      supabase.from('discord_success_posts').select('*', { count: 'exact', head: true }),
      getConnection(user.id)
    ]);
    res.json({ bot_ready: ready, configured: !!token, oauth_configured: !!(clientId && clientSecret), client_id: clientId, is_super_admin: superAdmin, connection, sources, master, total_posts: count || 0 });
  });

  app.get('/admin/success-network/guilds', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req); await ensureClient();
    if (!client || !ready) return res.status(503).json({ error: 'Discord bot is not connected' });
    if (isSuper(user, SUPER_ADMIN_EMAIL)) {
      const out = [...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) }));
      return res.json(out.sort((a, b) => a.name.localeCompare(b.name)));
    }
    const connection = await getConnection(user.id);
    if (!connection) return res.json([]);
    const allowed = allowedGuildIds(connection);
    const out = [...client.guilds.cache.values()].filter(g => allowed.has(g.id)).map(g => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) }));
    res.json(out.sort((a, b) => a.name.localeCompare(b.name)));
  });

  app.get('/admin/success-network/guilds/:guildId/channels', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req); await ensureClient();
      await requireAllowedGuild(user, req.params.guildId);
      const guild = await client.guilds.fetch(req.params.guildId);
      const channels = await guild.channels.fetch();
      res.json([...channels.values()].filter(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)).map(c => ({ id: c.id, name: c.name, type: c.type })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  app.post('/admin/success-network/source', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req); await ensureClient();
      const guildId = cleanText(req.body.guild_id, 30), channelId = cleanText(req.body.channel_id, 30);
      await requireAllowedGuild(user, guildId);
      const guild = await client.guilds.fetch(guildId); const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) return res.status(400).json({ error: 'Choose a text channel' });
      await supabase.from('discord_success_channels').update({ is_active: false, updated_at: new Date().toISOString() }).eq('admin_user_id', user.id);
      const row = { admin_user_id: user.id, guild_id: guild.id, guild_name: guild.name, source_channel_id: channel.id, source_channel_name: channel.name, allow_public_homepage: req.body.allow_public_homepage === true, is_active: true, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from('discord_success_channels').upsert(row, { onConflict: 'guild_id' }).select('*').single();
      if (error) return res.status(500).json({ error: error.message }); res.json(data);
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  app.post('/admin/success-network/public-setting', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req);
    const { data, error } = await supabase.from('discord_success_channels').update({ allow_public_homepage: req.body.allow_public_homepage === true, updated_at: new Date().toISOString() }).eq('admin_user_id', user.id).eq('is_active', true).select('*').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || {});
  });

  app.post('/admin/success-network/disconnect', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req);
    await Promise.all([
      supabase.from('discord_success_connections').delete().eq('admin_user_id', user.id),
      supabase.from('discord_success_channels').update({ is_active: false, updated_at: new Date().toISOString() }).eq('admin_user_id', user.id)
    ]);
    res.json({ ok: true });
  });

  app.post('/admin/success-network/master', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req); if (!isSuper(user, SUPER_ADMIN_EMAIL)) return res.status(403).json({ error: 'Super admin only' });
    await ensureClient(); const guild = await client.guilds.fetch(String(req.body.guild_id)); const channel = await guild.channels.fetch(String(req.body.channel_id));
    if (!channel?.isTextBased()) return res.status(400).json({ error: 'Choose a text channel' });
    const row = { id: 'master', guild_id: guild.id, guild_name: guild.name, channel_id: channel.id, channel_name: channel.name, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('discord_success_master_settings').upsert(row).select('*').single();
    if (error) return res.status(500).json({ error: error.message }); res.json(data);
  });

  app.get('/admin/success-network/posts', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req); let q = supabase.from('discord_success_posts').select('*').order('posted_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 100, 500));
    if (!isSuper(user, SUPER_ADMIN_EMAIL)) q = q.eq('source_admin_user_id', user.id);
    const { data, error } = await q; if (error) return res.status(500).json({ error: error.message }); res.json(data || []);
  });

  app.get('/public/success-feed', async (req, res) => {
    const { data, error } = await supabase.from('discord_success_posts').select('id,guild_name,author_name,author_avatar_url,message_text,attachments,posted_at').eq('forwarding_status', 'forwarded').eq('public_approved', true).order('posted_at', { ascending: false }).limit(24);
    if (error) return res.json([]); res.set('Cache-Control', 'public, max-age=60'); res.json(data || []);
  });

  app.get('/public/checkout-success-feed', async (req, res) => {
    const { data, error } = await supabase.from('webhook_events')
      .select('id,site,product,product_name,sku,parsed_items,created_at,status,type,webhook_type')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return res.json([]);

    const rows = (data || [])
      .filter(r => String(r.type || r.webhook_type || '').toLowerCase().includes('checkout') && !String(r.status || '').toLowerCase().includes('error'))
      .slice(0, 24)
      .map(r => {
        const item = Array.isArray(r.parsed_items) ? (r.parsed_items[0] || {}) : {};
        return {
          id: r.id,
          site: cleanText(r.site || item.site || 'store', 80),
          product: cleanText(r.product || r.product_name || item.title || item.product_name || 'Successful checkout', 500),
          sku: cleanText(r.sku || item.sku || item.tcin || item.asin || '', 160),
          created_at: r.created_at,
          image: cleanText(item.image || item.image_url || item.thumbnail || item.thumbnail_url || '', 2000)
        };
      });

    // Older webhook rows often did not save the image in parsed_items. Fill those
    // images from the product catalog/storefront so the public homepage remains visual.
    const missing = rows.filter(r => !r.image && r.sku);
    if (missing.length) {
      const skus = [...new Set(missing.map(r => String(r.sku).trim()).filter(Boolean))].slice(0, 100);
      const imageMap = new Map();
      const key = (site, sku) => `${String(site || '').toLowerCase().replace(/[^a-z0-9]/g, '')}:${String(sku || '').toLowerCase().trim()}`;
      try {
        const { data: catalogRows } = await supabase.from('catalog_products')
          .select('site,sku,product_name,image_url,product_url').in('sku', skus);
        for (const product of catalogRows || []) {
          if (product.image_url) imageMap.set(key(product.site, product.sku), product.image_url);
          if (product.image_url) imageMap.set(key('', product.sku), product.image_url);
        }
      } catch (_) {}
      try {
        const { data: storeRows } = await supabase.from('storefront_products')
          .select('primary_site,primary_sku,image_url').in('primary_sku', skus);
        for (const product of storeRows || []) {
          if (product.image_url) imageMap.set(key(product.primary_site, product.primary_sku), product.image_url);
          if (product.image_url) imageMap.set(key('', product.primary_sku), product.image_url);
        }
      } catch (_) {}
      for (const row of missing) row.image = imageMap.get(key(row.site, row.sku)) || imageMap.get(key('', row.sku)) || '';
    }

    res.set('Cache-Control', 'public, max-age=30');
    res.json(rows);
  });

  if (token) setTimeout(() => ensureClient().catch(err => console.error('[success-network] startup failed', err)), 3000);
};
