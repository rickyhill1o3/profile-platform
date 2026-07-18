const { Client, GatewayIntentBits, Partials, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');

function cleanText(v, n=2000){ return String(v || '').replace(/\u0000/g,'').slice(0,n); }
function isSuper(user, superEmail){ return user?.role === 'super_admin' || String(user?.email||'').toLowerCase() === String(superEmail||'').toLowerCase(); }

module.exports = function registerSuccessNetwork({ app, supabase, auth, admin, getCurrentUser, SUPER_ADMIN_EMAIL }) {
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  const clientId = String(process.env.DISCORD_BOT_CLIENT_ID || '').trim();
  let client = null;
  let ready = false;

  async function ensureClient(){
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

  async function getMasterDestination(){
    const { data } = await supabase.from('discord_success_master_settings').select('*').eq('id','master').maybeSingle();
    return data || null;
  }

  async function handleMessage(message){
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const { data: source } = await supabase.from('discord_success_channels')
        .select('*').eq('guild_id', message.guild.id).eq('source_channel_id', message.channel.id).eq('is_active', true).maybeSingle();
      if (!source) return;

      const attachments = [...message.attachments.values()].map(a => ({
        id:a.id, name:a.name, url:a.url, proxy_url:a.proxyURL, content_type:a.contentType, size:a.size,
        width:a.width || null, height:a.height || null
      }));
      const stickers = [...message.stickers.values()].map(s => ({ id:s.id, name:s.name, url:s.url || null }));
      const jumpUrl = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
      const row = {
        discord_message_id: message.id,
        guild_id: message.guild.id,
        guild_name: cleanText(message.guild.name,200),
        source_channel_id: message.channel.id,
        source_channel_name: cleanText(message.channel.name,200),
        source_admin_user_id: source.admin_user_id || null,
        author_discord_id: message.author.id,
        author_name: cleanText(message.member?.displayName || message.author.globalName || message.author.username,200),
        author_avatar_url: message.author.displayAvatarURL({size:256}),
        message_text: cleanText(message.content,4000),
        attachments,
        stickers,
        source_message_url: jumpUrl,
        forwarding_status: 'received',
        posted_at: message.createdAt.toISOString()
      };
      const { data: inserted, error } = await supabase.from('discord_success_posts').upsert(row,{onConflict:'discord_message_id'}).select('*').single();
      if (error) throw error;

      const master = await getMasterDestination();
      if (!master?.guild_id || !master?.channel_id) {
        await supabase.from('discord_success_posts').update({forwarding_status:'waiting_for_master'}).eq('id',inserted.id);
        return;
      }
      const guild = await client.guilds.fetch(master.guild_id);
      const channel = await guild.channels.fetch(master.channel_id);
      if (!channel?.isTextBased()) throw new Error('Master success destination is not a text channel');

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({name: row.author_name || 'Discord member', iconURL: row.author_avatar_url || undefined})
        .setTitle(`Success from ${row.guild_name}`)
        .setDescription(row.message_text || (attachments.length ? 'Shared a success attachment.' : 'Shared a success.'))
        .addFields(
          {name:'Source', value:`${row.guild_name} • #${row.source_channel_name}`, inline:true},
          {name:'Posted by', value:row.author_name || 'Unknown', inline:true},
          {name:'Original', value:`[Open message](${jumpUrl})`, inline:true}
        )
        .setTimestamp(message.createdAt);
      const firstImage = attachments.find(a => String(a.content_type||'').startsWith('image/'));
      if (firstImage) embed.setImage(firstImage.url);
      const extraLinks = attachments.filter(a => !firstImage || a.id !== firstImage.id).slice(0,8).map(a => `[${a.name || 'Attachment'}](${a.url})`);
      if (extraLinks.length) embed.addFields({name:'More attachments',value:extraLinks.join('\n').slice(0,1024)});

      const forwarded = await channel.send({embeds:[embed]});
      await supabase.from('discord_success_posts').update({
        forwarding_status:'forwarded', forwarded_message_id:forwarded.id, forwarded_at:new Date().toISOString(), forwarding_error:null
      }).eq('id',inserted.id);
    } catch (err) {
      console.error('[success-network] forward failed', err);
      if (message?.id) await supabase.from('discord_success_posts').update({forwarding_status:'failed',forwarding_error:cleanText(err.message,1000)}).eq('discord_message_id',message.id).catch(()=>{});
    }
  }

  app.get('/admin/success-network/status', auth, admin, async (req,res) => {
    const user = await getCurrentUser(req);
    const { data: sources=[] } = await supabase.from('discord_success_channels').select('*').order('created_at',{ascending:false});
    const { data: master } = await supabase.from('discord_success_master_settings').select('*').eq('id','master').maybeSingle();
    const { count } = await supabase.from('discord_success_posts').select('*',{count:'exact',head:true});
    res.json({ bot_ready:ready, configured:!!token, client_id:clientId, install_url:clientId?`https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=68608`:null, is_super_admin:isSuper(user,SUPER_ADMIN_EMAIL), sources, master, total_posts:count||0 });
  });

  app.get('/admin/success-network/guilds', auth, admin, async (req,res) => {
    const user = await getCurrentUser(req); await ensureClient();
    if (!client || !ready) return res.status(503).json({error:'Discord bot is not connected'});
    const discordId = String(user?.discord_user_id || '').trim();
    const out=[];
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = discordId ? await guild.members.fetch(discordId) : null;
        if (!isSuper(user,SUPER_ADMIN_EMAIL) && !member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) continue;
        out.push({id:guild.id,name:guild.name,icon:guild.iconURL({size:128})});
      } catch (_) {}
    }
    res.json(out.sort((a,b)=>a.name.localeCompare(b.name)));
  });

  app.get('/admin/success-network/guilds/:guildId/channels', auth, admin, async (req,res) => {
    const user=await getCurrentUser(req); await ensureClient();
    const guild=await client.guilds.fetch(req.params.guildId);
    const discordId=String(user?.discord_user_id||'').trim();
    if (!isSuper(user,SUPER_ADMIN_EMAIL)) {
      const member=await guild.members.fetch(discordId).catch(()=>null);
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return res.status(403).json({error:'You must manage this Discord server'});
    }
    const channels=await guild.channels.fetch();
    res.json([...channels.values()].filter(c=>c && (c.type===ChannelType.GuildText || c.type===ChannelType.GuildAnnouncement)).map(c=>({id:c.id,name:c.name,type:c.type})).sort((a,b)=>a.name.localeCompare(b.name)));
  });

  app.post('/admin/success-network/source', auth, admin, async (req,res) => {
    const user=await getCurrentUser(req); await ensureClient();
    const guildId=cleanText(req.body.guild_id,30), channelId=cleanText(req.body.channel_id,30);
    const guild=await client.guilds.fetch(guildId); const channel=await guild.channels.fetch(channelId);
    if (!channel?.isTextBased()) return res.status(400).json({error:'Choose a text channel'});
    const discordId=String(user?.discord_user_id||'').trim();
    if (!isSuper(user,SUPER_ADMIN_EMAIL)) {
      const member=await guild.members.fetch(discordId).catch(()=>null);
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return res.status(403).json({error:'You must manage this Discord server'});
    }
    const row={admin_user_id:user.id,guild_id:guild.id,guild_name:guild.name,source_channel_id:channel.id,source_channel_name:channel.name,is_active:true,updated_at:new Date().toISOString()};
    const {data,error}=await supabase.from('discord_success_channels').upsert(row,{onConflict:'guild_id'}).select('*').single();
    if(error) return res.status(500).json({error:error.message}); res.json(data);
  });

  app.post('/admin/success-network/master', auth, admin, async (req,res) => {
    const user=await getCurrentUser(req); if(!isSuper(user,SUPER_ADMIN_EMAIL)) return res.status(403).json({error:'Super admin only'});
    await ensureClient(); const guild=await client.guilds.fetch(String(req.body.guild_id)); const channel=await guild.channels.fetch(String(req.body.channel_id));
    if(!channel?.isTextBased()) return res.status(400).json({error:'Choose a text channel'});
    const row={id:'master',guild_id:guild.id,guild_name:guild.name,channel_id:channel.id,channel_name:channel.name,updated_at:new Date().toISOString()};
    const {data,error}=await supabase.from('discord_success_master_settings').upsert(row).select('*').single();
    if(error) return res.status(500).json({error:error.message}); res.json(data);
  });

  app.get('/admin/success-network/posts', auth, admin, async (req,res) => {
    const user=await getCurrentUser(req); let q=supabase.from('discord_success_posts').select('*').order('posted_at',{ascending:false}).limit(Math.min(Number(req.query.limit)||100,500));
    if(!isSuper(user,SUPER_ADMIN_EMAIL)) q=q.eq('source_admin_user_id',user.id);
    const {data,error}=await q; if(error)return res.status(500).json({error:error.message}); res.json(data||[]);
  });

  app.get('/public/success-feed', async (req,res) => {
    const {data,error}=await supabase.from('discord_success_posts').select('id,guild_name,author_name,author_avatar_url,message_text,attachments,source_message_url,posted_at').eq('forwarding_status','forwarded').order('posted_at',{ascending:false}).limit(24);
    if(error)return res.json([]); res.set('Cache-Control','public, max-age=60'); res.json(data||[]);
  });

  app.get('/public/checkout-success-feed', async (req,res) => {
    const {data,error}=await supabase.from('webhook_events').select('id,site,product,product_name,sku,parsed_items,created_at,status,type,webhook_type').order('created_at',{ascending:false}).limit(80);
    if(error)return res.json([]);
    const rows=(data||[]).filter(r=>String(r.type||r.webhook_type||'').includes('checkout') && !String(r.status||'').includes('error')).slice(0,18).map(r=>({
      id:r.id,site:r.site||'store',product:r.product||r.product_name||r.parsed_items?.[0]?.title||'Successful checkout',sku:r.sku||r.parsed_items?.[0]?.sku||'',created_at:r.created_at,image:r.parsed_items?.[0]?.image||''
    }));
    res.set('Cache-Control','public, max-age=60'); res.json(rows);
  });

  if(token) setTimeout(()=>ensureClient().catch(err=>console.error('[success-network] startup failed',err)),3000);
};
