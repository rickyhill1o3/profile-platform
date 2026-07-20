const crypto = require('crypto');
const { publicTcgSearch, publicTcgProduct, searchLinks } = require('./market-value-engine');
const clean = v => String(v || '').trim();
const now = () => new Date().toISOString();
const MAX_SEARCHES = Math.max(1, Number(process.env.MASTER_PRODUCT_SEARCH_BATCH || 12));
const SEARCH_INTERVAL = Math.max(3600000, Number(process.env.MASTER_PRODUCT_SEARCH_INTERVAL_MS || 21600000));

function normalizeName(v){return clean(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\b(the|and|with|for|edition|new|sealed)\b/g,' ').replace(/\s+/g,' ').trim()}
function normalizedKey(item){const upc=clean(item.upc); if(upc)return `upc:${upc.replace(/\D/g,'')}`; return `name:${normalizeName(item.product_name||item.official_name)}|${normalizeName(item.category)}|${normalizeName(item.sku)}`}
function median(a){const x=a.map(Number).filter(n=>n>0).sort((a,b)=>a-b);if(!x.length)return null;const i=Math.floor(x.length/2);return x.length%2?x[i]:(x[i-1]+x[i])/2}

async function ensureMasterForInvestment(supabase,item){
  if(item.master_product_id)return item.master_product_id;
  const key=normalizedKey(item);
  let {data:master}=await supabase.from('master_products').select('*').eq('normalized_key',key).maybeSingle();
  if(!master){
    const row={normalized_key:key,official_name:clean(item.product_name)||'Unknown product',category:clean(item.category)||null,upc:clean(item.upc)||null,image_url:clean(item.image_url)||null,retailer_skus:item.sku?{[clean(item.store)||'unknown']:clean(item.sku)}:{},match_status:'pending'};
    const created=await supabase.from('master_products').insert(row).select().single(); if(created.error)throw created.error; master=created.data;
  }
  await supabase.from('investment_products').update({master_product_id:master.id}).eq('id',item.id);
  return master.id;
}
async function syncAllInvestments(supabase){
  const {data,error}=await supabase.from('investment_products').select('id,master_product_id,product_name,category,upc,sku,store,image_url').is('master_product_id',null).limit(1000); if(error)throw error;
  for(const item of data||[])await ensureMasterForInvestment(supabase,item);
  return (data||[]).length;
}
async function searchMaster(supabase,master){
  await supabase.from('master_products').update({match_status:'searching',last_search_at:now(),search_error:null}).eq('id',master.id);
  try{
    const found=await publicTcgSearch(master.official_name);
    const rows=found.results||[];
    for(const r of rows){
      await supabase.from('master_product_candidates').upsert({master_product_id:master.id,marketplace:'tcgplayer',candidate_title:r.title,candidate_url:r.url,image_url:r.image_url||null,observed_price:r.price||null,confidence:Number(r.score||0),raw_data:r},{onConflict:'master_product_id,marketplace,candidate_url'});
    }
    await supabase.from('master_products').update({match_status:rows.length?'review':'not_found',last_search_at:now(),search_error:null,updated_at:now()}).eq('id',master.id);
    return rows.length;
  }catch(e){await supabase.from('master_products').update({match_status:'not_found',last_search_at:now(),search_error:e.message,updated_at:now()}).eq('id',master.id);return 0}
}
async function searchPending(supabase,force=false){
  await syncAllInvestments(supabase);
  let q=supabase.from('master_products').select('*').in('match_status',force?['pending','not_found','review']:['pending','not_found']).order('last_search_at',{ascending:true,nullsFirst:true}).limit(MAX_SEARCHES);
  const {data,error}=await q;if(error)throw error;const out=[];for(const m of data||[])out.push({id:m.id,count:await searchMaster(supabase,m)});return out;
}
async function propagateMaster(supabase,master){
  const patch={market_price:master.current_market_value,market_source:master.market_source,market_updated_at:master.market_updated_at,image_url:master.image_url,price_match_status:master.match_status==='matched'?'matched':'unmatched',source_product_urls:master.marketplace_urls||{}};
  await supabase.from('investment_products').update(patch).eq('master_product_id',master.id);
}
async function approveCandidate(supabase,master,candidate,userId){
  let price=Number(candidate.observed_price||0)||null,image=candidate.image_url||master.image_url;
  try{const live=await publicTcgProduct(candidate.candidate_url,candidate.candidate_title);price=live.price||price;image=live.image_url||image}catch{}
  const urls={...(master.marketplace_urls||{}),[candidate.marketplace]:candidate.candidate_url};
  const statuses={...(master.marketplace_status||{}),[candidate.marketplace]:'approved'};
  const patch={official_name:candidate.candidate_title||master.official_name,marketplace_urls:urls,marketplace_status:statuses,image_url:image||null,match_status:'matched',approved_by:userId,approved_at:now(),current_market_value:price,market_source:candidate.marketplace,market_updated_at:price?now():master.market_updated_at,updated_at:now(),search_error:null};
  const {data,error}=await supabase.from('master_products').update(patch).eq('id',master.id).select().single();if(error)throw error;
  await supabase.from('master_product_candidates').update({status:'rejected',updated_at:now()}).eq('master_product_id',master.id).eq('marketplace',candidate.marketplace);
  await supabase.from('master_product_candidates').update({status:'approved',updated_at:now()}).eq('id',candidate.id);
  if(price)await supabase.from('master_market_observations').insert({master_product_id:master.id,marketplace:candidate.marketplace,price,title:candidate.candidate_title,listing_url:candidate.candidate_url,confidence:candidate.confidence||.9,raw_data:{approved_candidate:true}});
  await propagateMaster(supabase,data);return data;
}
async function refreshMatched(supabase){
  const {data}=await supabase.from('master_products').select('*').eq('match_status','matched').order('market_updated_at',{ascending:true,nullsFirst:true}).limit(MAX_SEARCHES);
  const out=[];for(const m of data||[]){const url=m.marketplace_urls?.tcgplayer;if(!url)continue;try{const row=await publicTcgProduct(url,m.official_name);await supabase.from('master_market_observations').insert({master_product_id:m.id,marketplace:'tcgplayer',price:row.price,title:row.title,listing_url:url,confidence:.95,raw_data:row.raw||{}});const {data:obs}=await supabase.from('master_market_observations').select('price').eq('master_product_id',m.id).gte('observed_at',new Date(Date.now()-30*86400000).toISOString());const value=median((obs||[]).map(x=>x.price));const updated=(await supabase.from('master_products').update({current_market_value:value,market_source:'tcgplayer',market_updated_at:now(),updated_at:now()}).eq('id',m.id).select().single()).data;await propagateMaster(supabase,updated);out.push(updated)}catch(e){await supabase.from('master_products').update({search_error:e.message}).eq('id',m.id)}}return out;
}
function requireSuper(req,res,next){if(req.role!=='super_admin')return res.status(403).json({error:'Super admin only'});next()}
function registerMasterProductCatalog({app,supabase,auth}){
  app.get('/admin/master-products',auth,requireSuper,async(req,res)=>{const status=clean(req.query.status);let q=supabase.from('master_products').select('*',{count:'exact'}).order('updated_at',{ascending:false}).limit(500);if(status)q=q.eq('match_status',status);const {data,error,count}=await q;if(error)return res.status(500).json({error:error.message});res.json({products:data||[],count})});
  app.get('/admin/master-products/stats',auth,requireSuper,async(req,res)=>{const {data}=await supabase.from('master_products').select('match_status');const stats={total:0,pending:0,searching:0,review:0,matched:0,not_found:0,ignored:0};for(const x of data||[]){stats.total++;stats[x.match_status]=(stats[x.match_status]||0)+1}res.json(stats)});
  app.get('/admin/master-products/:id',auth,requireSuper,async(req,res)=>{const {data:product}=await supabase.from('master_products').select('*').eq('id',req.params.id).maybeSingle();if(!product)return res.status(404).json({error:'Product not found'});const {data:candidates}=await supabase.from('master_product_candidates').select('*').eq('master_product_id',product.id).order('confidence',{ascending:false});const {data:observations}=await supabase.from('master_market_observations').select('*').eq('master_product_id',product.id).order('observed_at',{ascending:false}).limit(100);res.json({product,candidates:candidates||[],observations:observations||[],search_links:searchLinks(product.official_name)})});
  app.post('/admin/master-products/sync',auth,requireSuper,async(req,res)=>{try{res.json({success:true,linked:await syncAllInvestments(supabase)})}catch(e){res.status(500).json({error:e.message})}});
  app.post('/admin/master-products/search',auth,requireSuper,async(req,res)=>{try{res.json({success:true,results:await searchPending(supabase,!!req.body?.force)})}catch(e){res.status(500).json({error:e.message})}});
  app.post('/admin/master-products/:id/search',auth,requireSuper,async(req,res)=>{const {data:m}=await supabase.from('master_products').select('*').eq('id',req.params.id).maybeSingle();if(!m)return res.status(404).json({error:'Product not found'});res.json({success:true,count:await searchMaster(supabase,m)})});
  app.post('/admin/master-products/:id/approve/:candidateId',auth,requireSuper,async(req,res)=>{try{const {data:m}=await supabase.from('master_products').select('*').eq('id',req.params.id).single();const {data:c}=await supabase.from('master_product_candidates').select('*').eq('id',req.params.candidateId).eq('master_product_id',m.id).single();res.json({success:true,product:await approveCandidate(supabase,m,c,req.user_id)})}catch(e){res.status(500).json({error:e.message})}});
  app.post('/admin/master-products/:id/manual-match',auth,requireSuper,async(req,res)=>{try{const {data:m}=await supabase.from('master_products').select('*').eq('id',req.params.id).single();const url=clean(req.body?.url);if(!/^https:\/\/([^/]+\.)?tcgplayer\.com\//i.test(url))return res.status(400).json({error:'Valid TCGplayer URL required'});const candidate={id:crypto.randomUUID(),candidate_title:clean(req.body?.title)||m.official_name,candidate_url:url,image_url:null,observed_price:Number(req.body?.price)||null,confidence:1,marketplace:'tcgplayer'};await supabase.from('master_product_candidates').upsert({id:candidate.id,master_product_id:m.id,marketplace:'tcgplayer',candidate_title:candidate.candidate_title,candidate_url:url,observed_price:candidate.observed_price,confidence:1,status:'pending'},{onConflict:'master_product_id,marketplace,candidate_url'});const {data:saved}=await supabase.from('master_product_candidates').select('*').eq('master_product_id',m.id).eq('candidate_url',url).single();res.json({success:true,product:await approveCandidate(supabase,m,saved,req.user_id)})}catch(e){res.status(500).json({error:e.message})}});
  app.patch('/admin/master-products/:id',auth,requireSuper,async(req,res)=>{const allowed=['official_name','brand','product_set','category','product_type','upc','release_date','msrp','image_url','match_status'];const patch={updated_at:now()};for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body||{},k))patch[k]=req.body[k]||null;const {data,error}=await supabase.from('master_products').update(patch).eq('id',req.params.id).select().single();if(error)return res.status(500).json({error:error.message});await propagateMaster(supabase,data);res.json({product:data})});
  app.post('/admin/master-products/refresh-prices',auth,requireSuper,async(req,res)=>{try{res.json({success:true,products:await refreshMatched(supabase)})}catch(e){res.status(500).json({error:e.message})}});
  if(process.env.MASTER_PRODUCT_CATALOG_ENABLED!=='false')setInterval(()=>{searchPending(supabase,false).catch(e=>console.error('Master product search failed:',e.message));refreshMatched(supabase).catch(e=>console.error('Master price refresh failed:',e.message))},SEARCH_INTERVAL);
}
module.exports={registerMasterProductCatalog,syncAllInvestments,searchPending,refreshMatched};
