const { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder, PermissionsBitField } = require('discord.js');
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


  function botChannelPermissionProblem(channel, guild) {
    try {
      const me = guild?.members?.me;
      if (!me || !channel?.permissionsFor) return null;
      const permissions = channel.permissionsFor(me);
      const missing = [];
      if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
      if (!permissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) missing.push('Read Message History');
      if (!permissions?.has(PermissionsBitField.Flags.SendMessages)) missing.push('Send Messages');
      if (!permissions?.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('Embed Links');
      if (!permissions?.has(PermissionsBitField.Flags.AttachFiles)) missing.push('Attach Files');
      if (!permissions?.has(PermissionsBitField.Flags.ManageMessages)) missing.push('Manage Messages');
      return missing.length ? `Give the Success Bot these permissions in #${channel.name}: ${missing.join(', ')}.` : null;
    } catch (_) { return null; }
  }

  async function sendConnectionTest({ source, requestedBy }) {
    await ensureClient();
    if (!client || !ready) throw new Error('Discord bot is not connected. Check DISCORD_BOT_TOKEN and the Render logs.');
    const sourceGuild = await client.guilds.fetch(source.guild_id);
    const sourceChannel = await sourceGuild.channels.fetch(source.source_channel_id);
    if (!sourceChannel?.isTextBased()) throw new Error('The selected success channel is no longer available.');
    const sourcePermissionProblem = botChannelPermissionProblem(sourceChannel, sourceGuild);
    if (sourcePermissionProblem) throw new Error(sourcePermissionProblem);

    const sourceEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Success channel connected successfully')
      .setDescription('The Shore Shack Success Bot can read this channel, save success posts to the website, and include approved posts on the public success wall.')
      .addFields({ name: 'Connected channel', value: `#${source.source_channel_name}`, inline: true })
      .setTimestamp();
    await sourceChannel.send({ embeds: [sourceEmbed] });

    const master = await getMasterDestination();
    let masterNotified = false;
    const sameDestination = master && String(master.guild_id) === String(source.guild_id) && String(master.channel_id) === String(source.source_channel_id);
    if (master?.guild_id && master?.channel_id && !sameDestination) {
      const masterGuild = await client.guilds.fetch(master.guild_id);
      const masterChannel = await masterGuild.channels.fetch(master.channel_id);
      if (masterChannel?.isTextBased()) {
        const masterPermissionProblem = botChannelPermissionProblem(masterChannel, masterGuild);
        if (masterPermissionProblem) throw new Error(`Master destination problem: ${masterPermissionProblem}`);
        const masterEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Admin success channel connected')
          .setDescription(`${source.guild_name} has connected #${source.source_channel_name} to The Shore Shack Success Network.`)
          .addFields({ name: 'Connected by', value: cleanText(requestedBy?.email || requestedBy?.name || 'Admin', 250), inline: true })
          .setTimestamp();
        await masterChannel.send({ embeds: [masterEmbed] });
        masterNotified = true;
      }
    }
    return { ok: true, same_destination: !!sameDestination, master_notified: masterNotified };
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

      // The Super Admin can use the same channel as both the source and master hub.
      // In that case the original human post is already in the master destination, so
      // saving it to the database is sufficient and a duplicate Discord post is avoided.
      if (String(master.guild_id) === String(message.guild.id) && String(master.channel_id) === String(message.channel.id)) {
        await supabase.from('discord_success_posts').update({
          forwarding_status: 'already_in_master', forwarded_message_id: message.id,
          forwarded_at: new Date().toISOString(), forwarding_error: null
        }).eq('id', inserted.id);
        return;
      }

      const guild = await client.guilds.fetch(master.guild_id);
      const channel = await guild.channels.fetch(master.channel_id);
      if (!channel?.isTextBased()) throw new Error('Master success destination is not a text channel');
      const masterPermissionProblem = botChannelPermissionProblem(channel, guild);
      if (masterPermissionProblem) throw new Error(masterPermissionProblem);

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
      if (!clientId || !jwtSecret) return res.status(500).json({ error: 'Discord bot installation is not fully configured.' });
      const state = jwt.sign({ purpose: 'discord_success_install', user_id: user.id }, jwtSecret, { expiresIn: '15m' });
      const url = new URL('https://discord.com/oauth2/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', oauthRedirect(req));
      // Bot-only install flow. No user OAuth token exchange is required, so admins
      // cannot receive an invalid_client error from a mismatched client secret.
      url.searchParams.set('scope', 'bot applications.commands');
      // View Channel + Send Messages + Manage Messages + Embed Links +
      // Attach Files + Read Message History.
      url.searchParams.set('permissions', '125952');
      url.searchParams.set('state', state);
      url.searchParams.set('disable_guild_select', 'false');
      res.json({ url: url.toString() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/auth/discord-success/callback', async (req, res) => {
    const base = frontendBase(req);
    try {
      if (req.query.error) throw new Error(cleanText(req.query.error_description || req.query.error, 300));
      const decoded = jwt.verify(String(req.query.state || ''), jwtSecret);
      if (decoded?.purpose !== 'discord_success_install' || !decoded.user_id) throw new Error('Invalid or expired Discord connection request.');
      const guildId = String(req.query.guild_id || '').trim();
      if (!guildId) throw new Error('Discord did not return the server that was selected. Please click Connect Discord and choose a server again.');

      await ensureClient();
      if (!client || !ready) throw new Error('The Discord bot is starting. Wait a few seconds and reconnect.');

      let guild = null;
      // Discord may redirect a fraction of a second before the gateway receives the
      // guild-create event. Retry briefly so the website reliably records the install.
      for (let attempt = 0; attempt < 6 && !guild; attempt += 1) {
        guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!guild) throw new Error('The bot was not found in the selected Discord server. Confirm the installation and try again.');

      const existing = await getConnection(decoded.user_id);
      const manageableMap = new Map((Array.isArray(existing?.manageable_guilds) ? existing.manageable_guilds : []).map(g => [String(g.id), g]));
      manageableMap.set(String(guild.id), { id: String(guild.id), name: cleanText(guild.name, 200), icon: guild.icon || null });
      const row = {
        admin_user_id: decoded.user_id,
        discord_user_id: existing?.discord_user_id || null,
        discord_username: existing?.discord_username || 'Discord server connected',
        manageable_guilds: [...manageableMap.values()],
        connected_at: existing?.connected_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const { error } = await supabase.from('discord_success_connections').upsert(row, { onConflict: 'admin_user_id' });
      if (error) throw error;
      return res.redirect(`${base}/success-network.html?discord_success_connected=1&guild_id=${encodeURIComponent(guild.id)}`);
    } catch (err) {
      return res.redirect(`${base}/success-network.html?discord_success_error=${encodeURIComponent(err.message || 'Discord connection failed')}`);
    }
  });

  app.get('/admin/success-network/status', auth, admin, async (req, res) => {
    const user = await getCurrentUser(req);
    const superAdmin = isSuper(user, SUPER_ADMIN_EMAIL);
    let sourceQuery = supabase.from('discord_success_channels').select('*').order('created_at', { ascending: false });
    if (!superAdmin) sourceQuery = sourceQuery.eq('admin_user_id', user.id);
    const [{ data: sources = [] }, { data: master }, { count }, storedConnection] = await Promise.all([
      sourceQuery,
      supabase.from('discord_success_master_settings').select('*').eq('id', 'master').maybeSingle(),
      supabase.from('discord_success_posts').select('*', { count: 'exact', head: true }),
      getConnection(user.id)
    ]);

    // Older/direct bot installations may already be fully working even when an OAuth
    // connection row was never stored. Derive a safe display connection from the
    // admin's active source channel (or, for the Super Admin, from the bot guild cache)
    // so the UI reflects the real working state instead of incorrectly saying
    // "Discord not connected."
    let connection = storedConnection;
    if (!connection && sources.length) {
      const guildMap = new Map();
      for (const source of sources) {
        if (source?.guild_id) guildMap.set(String(source.guild_id), {
          id: String(source.guild_id),
          name: cleanText(source.guild_name || 'Connected Discord server', 200),
          icon: null
        });
      }
      connection = {
        admin_user_id: user.id,
        discord_username: 'Discord server connected',
        manageable_guilds: [...guildMap.values()],
        derived_from_success_channel: true
      };
    }
    if (!connection && superAdmin && client && ready && client.guilds?.cache?.size) {
      connection = {
        admin_user_id: user.id,
        discord_username: 'Discord bot connected',
        manageable_guilds: [...client.guilds.cache.values()].map(g => ({ id: String(g.id), name: cleanText(g.name, 200), icon: g.icon || null })),
        derived_from_bot_installation: true
      };
    }

    res.json({ bot_ready: ready, configured: !!token, oauth_configured: !!clientId, client_id: clientId, is_super_admin: superAdmin, connection, sources, master, total_posts: count || 0 });
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
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const visibleChannels = [...channels.values()].filter(c => {
        if (!c || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement)) return false;
        if (!me || !c.permissionsFor) return false;
        return c.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel) === true;
      });
      res.json(visibleChannels.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        can_manage_messages: c.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages) === true
      })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  app.post('/admin/success-network/source', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req); await ensureClient();
      const guildId = cleanText(req.body.guild_id, 30), channelId = cleanText(req.body.channel_id, 30);
      await requireAllowedGuild(user, guildId);
      const guild = await client.guilds.fetch(guildId); const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) return res.status(400).json({ error: 'Choose a text channel' });
      const permissionProblem = botChannelPermissionProblem(channel, guild);
      if (permissionProblem) return res.status(400).json({ error: permissionProblem });
      await supabase.from('discord_success_channels').update({ is_active: false, updated_at: new Date().toISOString() }).eq('admin_user_id', user.id);
      const row = { admin_user_id: user.id, guild_id: guild.id, guild_name: guild.name, source_channel_id: channel.id, source_channel_name: channel.name, allow_public_homepage: req.body.allow_public_homepage === true, is_active: true, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from('discord_success_channels').upsert(row, { onConflict: 'guild_id' }).select('*').single();
      if (error) return res.status(500).json({ error: error.message }); res.json(data);
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  app.post('/admin/success-network/test', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      let q = supabase.from('discord_success_channels').select('*').eq('is_active', true);
      if (req.body?.source_id) q = q.eq('id', cleanText(req.body.source_id, 80));
      else q = q.eq('admin_user_id', user.id);
      if (!isSuper(user, SUPER_ADMIN_EMAIL)) q = q.eq('admin_user_id', user.id);
      const { data: source, error } = await q.maybeSingle();
      if (error) throw error;
      if (!source) return res.status(400).json({ error: 'Save a success channel before sending a test.' });
      const result = await sendConnectionTest({ source, requestedBy: user });
      res.json(result);
    } catch (err) { res.status(400).json({ error: err.message }); }
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


  app.delete('/admin/success-network/posts/:postId', auth, admin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      let q = supabase.from('discord_success_posts').select('*').eq('id', cleanText(req.params.postId, 120));
      if (!isSuper(user, SUPER_ADMIN_EMAIL)) q = q.eq('source_admin_user_id', user.id);
      const { data: post, error: readError } = await q.maybeSingle();
      if (readError) throw readError;
      if (!post) return res.status(404).json({ error: 'Success post not found or you do not have permission to delete it.' });

      const warnings = [];
      await ensureClient().catch(err => warnings.push(`Discord connection unavailable: ${err.message}`));

      // Remove the original source message when the bot has permission. This is best-effort:
      // the website/database deletion still succeeds even when Discord permissions prevent it.
      if (client && ready && post.guild_id && post.source_channel_id && post.discord_message_id) {
        try {
          const guild = await client.guilds.fetch(String(post.guild_id));
          const channel = await guild.channels.fetch(String(post.source_channel_id));
          if (channel?.isTextBased()) {
            const sourceMessage = await channel.messages.fetch(String(post.discord_message_id));
            if (sourceMessage) await sourceMessage.delete();
          }
        } catch (err) {
          warnings.push(`Original Discord message was not removed: ${cleanText(err.message, 300)}`);
        }
      }

      // Remove the copied master-hub message when one was created. If source and master were
      // the same channel, forwarded_message_id points to the original and has already been handled.
      if (client && ready && post.forwarded_message_id && post.forwarding_status === 'forwarded') {
        try {
          const master = await getMasterDestination();
          if (master?.guild_id && master?.channel_id) {
            const guild = await client.guilds.fetch(String(master.guild_id));
            const channel = await guild.channels.fetch(String(master.channel_id));
            if (channel?.isTextBased()) {
              const forwardedMessage = await channel.messages.fetch(String(post.forwarded_message_id));
              if (forwardedMessage) await forwardedMessage.delete();
            }
          }
        } catch (err) {
          warnings.push(`Forwarded master Discord message was not removed: ${cleanText(err.message, 300)}`);
        }
      }

      const { error: deleteError } = await supabase.from('discord_success_posts').delete().eq('id', post.id);
      if (deleteError) throw deleteError;
      res.json({ ok: true, warnings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/public/success-feed', async (req, res) => {
    const { data, error } = await supabase.from('discord_success_posts').select('id,guild_name,author_name,author_avatar_url,message_text,attachments,posted_at').in('forwarding_status', ['forwarded', 'already_in_master']).eq('public_approved', true).order('posted_at', { ascending: false }).limit(24);
    if (error) return res.json([]); res.set('Cache-Control', 'public, max-age=60'); res.json(data || []);
  });

  app.get('/public/checkout-success-feed', async (req, res) => {
    const { data, error } = await supabase.from('webhook_events')
      .select('id,site,product,product_name,sku,parsed_items,payload,created_at,status,type,webhook_type')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return res.json([]);

    const rows = (data || [])
      .filter(r => String(r.type || r.webhook_type || '').toLowerCase().includes('checkout') && !String(r.status || '').toLowerCase().includes('error'))
      .slice(0, 24)
      .map(r => {
        const item = Array.isArray(r.parsed_items) ? (r.parsed_items[0] || {}) : {};
        const payload = r.payload && typeof r.payload === 'object' ? r.payload : {};
        const firstEmbed = Array.isArray(payload.embeds) ? (payload.embeds[0] || {}) : (payload.embed || {});
        const payloadProduct = payload.product && typeof payload.product === 'object' ? payload.product : {};
        const image = item.image || item.image_url || item.thumbnail || item.thumbnail_url
          || payload.image_url || payload.image || payload.thumbnail_url
          || payloadProduct.image_url || payloadProduct.image
          || firstEmbed?.thumbnail?.url || firstEmbed?.image?.url || '';
        return {
          id: r.id,
          site: cleanText(r.site || item.site || payload.site || payload.source || 'store', 80),
          product: cleanText(r.product || r.product_name || item.title || item.product_name || payload.product_name || payloadProduct.name || firstEmbed?.title || 'Successful checkout', 500),
          sku: cleanText(r.sku || item.sku || item.tcin || item.asin || payload.sku || payload.product_sku || '', 160),
          created_at: r.created_at,
          image: cleanText(image, 2000)
        };
      });

    // Older webhook rows often did not save the image in parsed_items. Fill those
    // images from the original webhook payload first, then the catalog/storefront.
    // SKU matching is preferred, with a normalized product-name fallback for legacy rows.
    const missing = rows.filter(r => !r.image);
    if (missing.length) {
      const skus = [...new Set(missing.map(r => String(r.sku).trim()).filter(Boolean))].slice(0, 100);
      const names = [...new Set(missing.map(r => String(r.product).trim()).filter(Boolean))].slice(0, 100);
      const imageMap = new Map();
      const nameMap = new Map();
      const key = (site, sku) => `${String(site || '').toLowerCase().replace(/[^a-z0-9]/g, '')}:${String(sku || '').toLowerCase().trim()}`;
      const nameKey = (site, name) => `${String(site || '').toLowerCase().replace(/[^a-z0-9]/g, '')}:${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
      const remember = (site, sku, name, image) => {
        const url = String(image || '').trim();
        if (!url) return;
        if (sku) {
          imageMap.set(key(site, sku), url);
          imageMap.set(key('', sku), url);
        }
        if (name) {
          nameMap.set(nameKey(site, name), url);
          nameMap.set(nameKey('', name), url);
        }
      };
      if (skus.length) {
        try {
          const { data: catalogRows } = await supabase.from('catalog_products')
            .select('site,sku,product_name,image_url,product_url').in('sku', skus);
          for (const product of catalogRows || []) remember(product.site, product.sku, product.product_name, product.image_url);
        } catch (_) {}
      }
      // A second name-based query helps old Shikari/Target records whose SKU was absent
      // from webhook_events even though Discord received a thumbnail.
      if (names.length) {
        try {
          const { data: catalogByName } = await supabase.from('catalog_products')
            .select('site,sku,product_name,image_url').in('product_name', names);
          for (const product of catalogByName || []) remember(product.site, product.sku, product.product_name, product.image_url);
        } catch (_) {}
      }
      if (skus.length) {
        try {
          const { data: storeRows } = await supabase.from('storefront_products')
            .select('primary_site,primary_sku,title,image_url').in('primary_sku', skus);
          for (const product of storeRows || []) remember(product.primary_site, product.primary_sku, product.title, product.image_url);
        } catch (_) {}
      }
      if (names.length) {
        try {
          const { data: storeByName } = await supabase.from('storefront_products')
            .select('primary_site,primary_sku,title,image_url').in('title', names);
          for (const product of storeByName || []) remember(product.primary_site, product.primary_sku, product.title, product.image_url);
        } catch (_) {}
      }
      for (const row of missing) {
        row.image = imageMap.get(key(row.site, row.sku))
          || imageMap.get(key('', row.sku))
          || nameMap.get(nameKey(row.site, row.product))
          || nameMap.get(nameKey('', row.product))
          || '';
      }
    }

    res.set('Cache-Control', 'public, max-age=30');
    res.json(rows);
  });

  if (token) setTimeout(() => ensureClient().catch(err => console.error('[success-network] startup failed', err)), 3000);
};
