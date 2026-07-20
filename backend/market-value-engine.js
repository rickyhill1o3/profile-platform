const crypto = require('crypto');

const clean = v => String(v || '').trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const now = () => new Date().toISOString();
const REFRESH_HOURS = Math.max(1, Number(process.env.MARKET_VALUE_REFRESH_HOURS || 24));
const MAX_PRODUCTS_PER_RUN = Math.max(1, Number(process.env.MARKET_VALUE_MAX_PRODUCTS_PER_RUN || 40));
const SOURCE_WEIGHTS = { tcgplayer: 1.0, ebay: 0.9, stockx: 0.85, tradepost: 0.75, pricecharting: 0.8, cardmarket: 0.75, manual: 0.7 };

function normalizeName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|and|with|for|edition|new|sealed)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function similarity(a,b){
  const aa=new Set(normalizeName(a).split(' ').filter(Boolean)); const bb=new Set(normalizeName(b).split(' ').filter(Boolean));
  if(!aa.size||!bb.size)return 0; let hit=0; aa.forEach(x=>{if(bb.has(x))hit++}); return hit/Math.max(aa.size,bb.size);
}
function median(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function trimmedWeightedPrice(rows){
  const valid=rows.filter(r=>Number.isFinite(Number(r.price))&&Number(r.price)>0);
  if(!valid.length)return null;
  const med=median(valid.map(r=>Number(r.price)));
  const filtered=valid.length>=3?valid.filter(r=>Number(r.price)>=med*.45&&Number(r.price)<=med*1.8):valid;
  let total=0, weight=0;
  for(const r of filtered){const w=(SOURCE_WEIGHTS[r.source]||.65)*Math.max(.35,Number(r.confidence||.7)); total+=Number(r.price)*w; weight+=w;}
  return weight?Math.round(total/weight*100)/100:null;
}
function searchLinks(name){
  const q=encodeURIComponent(clean(name));
  return {
    tcgplayer:`https://www.tcgplayer.com/search/all/product?q=${q}&view=grid`,
    ebay:`https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`,
    stockx:`https://stockx.com/search?s=${q}`,
    tradepost:`https://tradepost.co/`,
    pricecharting:`https://www.pricecharting.com/search-products?type=prices&q=${q}`,
    cardmarket:`https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${q}`
  };
}
async function tcgToken(){
  const publicKey=clean(process.env.TCGPLAYER_PUBLIC_KEY), privateKey=clean(process.env.TCGPLAYER_PRIVATE_KEY);
  if(!publicKey||!privateKey)return null;
  const body=new URLSearchParams({grant_type:'client_credentials',client_id:publicKey,client_secret:privateKey});
  const r=await fetch('https://api.tcgplayer.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!r.ok)throw new Error(`TCGplayer authorization failed (${r.status})`); return (await r.json()).access_token;
}
async function fetchTcg(item){
  if(!item.tcgplayer_sku&&!item.tcgplayer_product_id)return [];
  const token=await tcgToken(); if(!token)return [];
  const url=item.tcgplayer_sku?`https://api.tcgplayer.com/pricing/marketprices/${item.tcgplayer_sku}`:`https://api.tcgplayer.com/pricing/product/${item.tcgplayer_product_id}`;
  const r=await fetch(url,{headers:{Authorization:`bearer ${token}`,Accept:'application/json'}}); if(!r.ok)return [];
  const results=(await r.json()).results||[];
  return results.map(x=>({source:'tcgplayer',price:num(x.marketPrice??x.lowPrice),currency:'USD',confidence:.98,listing_url:searchLinks(item.product_name).tcgplayer,raw:x})).filter(x=>x.price);
}
async function ebayToken(){
  const id=clean(process.env.EBAY_CLIENT_ID), secret=clean(process.env.EBAY_CLIENT_SECRET); if(!id||!secret)return null;
  const body=new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'});
  const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},body});
  if(!r.ok)throw new Error(`eBay authorization failed (${r.status})`); return (await r.json()).access_token;
}
async function fetchEbay(item){
  const token=await ebayToken(); if(!token)return [];
  const q=encodeURIComponent(clean(item.product_name));
  const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&limit=25&filter=buyingOptions:{FIXED_PRICE}`,{headers:{Authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'}});
  if(!r.ok)return [];
  const list=(await r.json()).itemSummaries||[];
  return list.filter(x=>similarity(item.product_name,x.title)>=.45).map(x=>({source:'ebay',price:num(x.price?.value),currency:x.price?.currency||'USD',confidence:Math.min(.95,.5+similarity(item.product_name,x.title)/2),title:x.title,listing_url:x.itemWebUrl,image_url:x.image?.imageUrl,raw:x})).filter(x=>x.price);
}
async function fetchStockx(item){
  const token=clean(process.env.STOCKX_ACCESS_TOKEN), apiKey=clean(process.env.STOCKX_API_KEY); if(!token||!apiKey)return [];
  const q=encodeURIComponent(clean(item.product_name));
  const r=await fetch(`https://api.stockx.com/v2/catalog/search?query=${q}&pageNumber=1&pageSize=20`,{headers:{Authorization:`Bearer ${token}`,'x-api-key':apiKey}});
  if(!r.ok)return [];
  const j=await r.json(); const products=j.products||j.results||[]; const out=[];
  for(const p of products.slice(0,5)){
    if(similarity(item.product_name,p.title||p.name)<.45)continue;
    const variants=p.variants||[];
    for(const v of variants.slice(0,3)){
      const md=v.marketData||v.market_data||{}; const price=num(md.lowestAsk??md.lowest_ask??md.lastSale??md.last_sale);
      if(price)out.push({source:'stockx',price,currency:'USD',confidence:.55+similarity(item.product_name,p.title||p.name)*.35,title:p.title||p.name,listing_url:p.url||searchLinks(item.product_name).stockx,image_url:p.image||p.imageUrl,raw:{product:p,variant:v}});
    }
  }
  return out;
}
async function saveObservation(supabase,item,row){
  const fingerprint=crypto.createHash('sha1').update(`${item.id}|${row.source}|${row.title||''}|${row.price}|${new Date().toISOString().slice(0,10)}`).digest('hex');
  await supabase.from('market_price_observations').upsert({investment_product_id:item.id,user_id:item.user_id,source:row.source,price:row.price,currency:row.currency||'USD',confidence:row.confidence||.7,title:row.title||item.product_name,listing_url:row.listing_url||null,image_url:row.image_url||null,observed_at:now(),fingerprint,raw_data:row.raw||null},{onConflict:'fingerprint',ignoreDuplicates:true});
}
async function refreshOne(supabase,item){
  const providers=[fetchTcg,fetchEbay,fetchStockx]; let observations=[]; const errors=[];
  for(const fn of providers){try{observations.push(...await fn(item))}catch(e){errors.push(e.message)}}
  for(const row of observations)await saveObservation(supabase,item,row);
  const grouped={}; observations.forEach(x=>(grouped[x.source]||(grouped[x.source]=[])).push(x));
  const sourcePrices=Object.entries(grouped).map(([source,rows])=>({source,price:median(rows.map(x=>x.price)),confidence:Math.max(...rows.map(x=>x.confidence||.7)),count:rows.length}));
  const price=trimmedWeightedPrice(sourcePrices);
  if(price!=null){
    const top=observations.sort((a,b)=>(b.confidence||0)-(a.confidence||0))[0];
    await supabase.from('investment_products').update({market_price:price,market_source:sourcePrices.map(x=>x.source).join('+'),market_updated_at:now(),image_url:item.image_url||top?.image_url||null,updated_at:now()}).eq('id',item.id);
  }
  return {id:item.id,name:item.product_name,price,sources:sourcePrices,errors};
}
async function createSnapshot(supabase,userId){
  const {data}=await supabase.from('investment_products').select('*').eq('user_id',userId);
  const items=data||[]; const summary=items.reduce((a,i)=>{const q=Number(i.quantity||1);a.purchase+=Number(i.purchase_price||0);a.credits+=Number(i.credits_value||0);a.market+=Number(i.market_price||0)*q;return a},{purchase:0,credits:0,market:0});
  summary.invested=summary.purchase+summary.credits; summary.gain=summary.market-summary.invested;
  await supabase.from('portfolio_value_snapshots').upsert({user_id:userId,snapshot_date:new Date().toISOString().slice(0,10),purchase_value:summary.purchase,credits_value:summary.credits,market_value:summary.market,gain_value:summary.gain,item_count:items.length},{onConflict:'user_id,snapshot_date'});
}
async function checkAlerts(supabase,userId){
  const {data:alerts}=await supabase.from('market_value_alerts').select('*,investment_products(product_name,market_price)').eq('user_id',userId).eq('is_active',true);
  for(const a of alerts||[]){const p=Number(a.investment_products?.market_price||0); let hit=false; if(a.direction==='above')hit=p>=Number(a.target_price); else hit=p<=Number(a.target_price); if(hit&&!a.triggered_at)await supabase.from('market_value_alerts').update({triggered_at:now(),last_trigger_price:p}).eq('id',a.id);}
}
async function refreshUser(supabase,userId,force=false){
  let q=supabase.from('investment_products').select('*').eq('user_id',userId).order('market_updated_at',{ascending:true,nullsFirst:true}).limit(MAX_PRODUCTS_PER_RUN);
  if(!force)q=q.or(`market_updated_at.is.null,market_updated_at.lt.${new Date(Date.now()-REFRESH_HOURS*3600000).toISOString()}`);
  const {data,error}=await q;if(error)throw error;const results=[];for(const item of data||[])results.push(await refreshOne(supabase,item));await createSnapshot(supabase,userId);await checkAlerts(supabase,userId);return results;
}
function registerMarketValueEngine({app,supabase,auth}){
  app.get('/market-value/config',auth,(req,res)=>res.json({providers:{tcgplayer:!!(process.env.TCGPLAYER_PUBLIC_KEY&&process.env.TCGPLAYER_PRIVATE_KEY),ebay:!!(process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET),stockx:!!(process.env.STOCKX_ACCESS_TOKEN&&process.env.STOCKX_API_KEY),tradepost:false,pricecharting:false,cardmarket:false},refresh_hours:REFRESH_HOURS}));
  app.get('/market-value/search-links',auth,(req,res)=>res.json({links:searchLinks(req.query.q)}));
  app.get('/market-value/history',auth,async(req,res)=>{const {data,error}=await supabase.from('portfolio_value_snapshots').select('*').eq('user_id',req.user_id).order('snapshot_date',{ascending:true}).limit(730);if(error)return res.status(500).json({error:error.message});res.json({history:data||[]})});
  app.get('/market-value/sources/:id',auth,async(req,res)=>{const {data:item}=await supabase.from('investment_products').select('*').eq('id',req.params.id).eq('user_id',req.user_id).maybeSingle();if(!item)return res.status(404).json({error:'Product not found'});const {data,error}=await supabase.from('market_price_observations').select('*').eq('investment_product_id',item.id).order('observed_at',{ascending:false}).limit(100);if(error)return res.status(500).json({error:error.message});res.json({item,observations:data||[],links:searchLinks(item.product_name)})});
  app.post('/market-value/observations',auth,async(req,res)=>{const {data:item}=await supabase.from('investment_products').select('*').eq('id',req.body.investment_product_id).eq('user_id',req.user_id).maybeSingle();if(!item)return res.status(404).json({error:'Product not found'});const price=num(req.body.price);if(!price||price<=0)return res.status(400).json({error:'Valid price required'});const row={source:clean(req.body.source)||'manual',price,currency:'USD',confidence:num(req.body.confidence)||.8,title:clean(req.body.title)||item.product_name,listing_url:clean(req.body.listing_url)||null,image_url:clean(req.body.image_url)||null,raw:{manual:true}};await saveObservation(supabase,item,row);const {data:obs}=await supabase.from('market_price_observations').select('*').eq('investment_product_id',item.id).gte('observed_at',new Date(Date.now()-30*86400000).toISOString());const current=trimmedWeightedPrice(obs||[]);await supabase.from('investment_products').update({market_price:current,market_source:'multi-source',market_updated_at:now(),updated_at:now()}).eq('id',item.id);await createSnapshot(supabase,req.user_id);res.json({success:true,market_price:current})});
  app.post('/market-value/refresh',auth,async(req,res)=>{try{const results=await refreshUser(supabase,req.user_id,true);res.json({success:true,updated:results.filter(x=>x.price!=null).length,results})}catch(e){res.status(500).json({error:e.message})}});
  app.get('/market-value/alerts',auth,async(req,res)=>{const {data,error}=await supabase.from('market_value_alerts').select('*,investment_products(product_name,market_price)').eq('user_id',req.user_id).order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json({alerts:data||[]})});
  app.post('/market-value/alerts',auth,async(req,res)=>{const row={user_id:req.user_id,investment_product_id:req.body.investment_product_id,direction:req.body.direction==='below'?'below':'above',target_price:Number(req.body.target_price),is_active:true};const {data,error}=await supabase.from('market_value_alerts').insert(row).select().single();if(error)return res.status(500).json({error:error.message});res.json({alert:data})});
  app.delete('/market-value/alerts/:id',auth,async(req,res)=>{const {error}=await supabase.from('market_value_alerts').delete().eq('id',req.params.id).eq('user_id',req.user_id);if(error)return res.status(500).json({error:error.message});res.json({success:true})});
  if(process.env.MARKET_VALUE_ENGINE_ENABLED!=='false')setInterval(async()=>{try{const {data:users}=await supabase.from('investment_products').select('user_id').limit(5000);const ids=[...new Set((users||[]).map(x=>x.user_id))];for(const id of ids)await refreshUser(supabase,id,false)}catch(e){console.error('Market value refresh failed:',e.message)}},Math.max(3600000,REFRESH_HOURS*3600000));
}
module.exports={registerMarketValueEngine,refreshUser,searchLinks};
