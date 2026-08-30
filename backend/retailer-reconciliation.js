function clean(v){ return String(v || '').replace(/\u0000/g,'').trim(); }
function lower(v){ return clean(v).toLowerCase(); }
function money(v){ const n=Number(String(v||'').replace(/[^0-9.-]/g,'')); return Number.isFinite(n)?Math.round(n*100)/100:null; }
function norm(v){ return lower(v).normalize('NFKD').replace(/[®™©]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function lines(text){
  return String(text||'').replace(/\r/g,'').replace(/&nbsp;|&#8199;|&#847;/gi,' ').split('\n')
    .map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean)
    .filter(x=>!/^https?:\/\//i.test(x) && !/^https?:\/\//i.test(x.replace(/^\(|\)$/g,'')));
}
function tokenScore(a,b){
  a=norm(a); b=norm(b); if(!a||!b)return 0; if(a===b)return 1;
  if(a.includes(b)||b.includes(a))return .92;
  const A=new Set(a.split(' ').filter(x=>x.length>1)), B=new Set(b.split(' ').filter(x=>x.length>1));
  const inter=[...A].filter(x=>B.has(x)).length, union=new Set([...A,...B]).size;
  return union?inter/union:0;
}
function extractTracking(text){
  const hay=String(text||'');
  const m=hay.match(/(?:tracking(?: number| #)?|tracking #|track package)\s*(?:is\s*)?[:#]?\s*(1Z[A-Z0-9]{16}|[A-Z0-9]{10,30})/i)
    || hay.match(/\b(1Z[A-Z0-9]{16})\b/i)
    || hay.match(/(?:FedEx|USPS|UPS|United Parcel Service)[^\n]{0,80}?(\d{10,22})/i);
  const value=m?.[1]||'';
  return /^(?:information|available|below)$/i.test(value)?'':value;
}
function candidateItemBeforeQty(ls, qi){
  for(let j=qi-1;j>=Math.max(0,qi-8);j--){
    const s=ls[j];
    if(!s || /^\$?[0-9,.]+(?:\s*\/\s*ea)?$/i.test(s) || /^(shipping|item delivered|canceled item|delivers to|track status|visit order details|pending item|quantity|qty)/i.test(s)) continue;
    if(/^(order|subtotal|total|discount|delivery|estimated taxes|rate & review|looking for your receipt|perfect pairings)/i.test(s)) continue;
    if(s.length>=4 && s.length<=220) return s;
  }
  return '';
}
function parseTargetItems(text,status){
  let ls=lines(text);
  const joined=ls.join('\n');
  let start=0,end=ls.length;
  if(status==='canceled'){
    const i=ls.findIndex(x=>/canceled item/i.test(x)); if(i>=0)start=i+1;
    const e=ls.findIndex((x,idx)=>idx>start && /would these work instead|perfect pairings|shop now/i.test(x)); if(e>=0)end=e;
  } else if(status==='delivered'){
    const i=ls.findIndex(x=>/^item delivered$/i.test(x)); if(i>=0)start=i+1;
    const e=ls.findIndex((x,idx)=>idx>start && /rate & review|returning something|perfect pairings/i.test(x)); if(e>=0)end=e;
  } else if(status==='shipped'){
    const i=ls.findIndex(x=>/track status/i.test(x)); if(i>=0)start=i+1;
    const e=ls.findIndex((x,idx)=>idx>start && /looking for your receipt|perfect pairings/i.test(x)); if(e>=0)end=e;
  } else if(status==='confirmed'){
    const e=ls.findIndex(x=>/^order summary$/i.test(x)); if(e>=0)end=e;
  }
  ls=ls.slice(start,end);
  const items=[];
  for(let i=0;i<ls.length;i++){
    const qm=ls[i].match(/^(?:qty|quantity)\s*:\s*(\d+)/i); if(!qm)continue;
    const name=candidateItemBeforeQty(ls,i); if(!name)continue;
    let price=null;
    for(let j=i+1;j<=Math.min(ls.length-1,i+5);j++){
      const pm=ls[j].match(/^\$([0-9,.]+)(?:\s*\/\s*ea)?$/i); if(pm){price=money(pm[1]);break;}
    }
    if(!items.some(x=>norm(x.product_name)===norm(name))) items.push({product_name:name,quantity:Number(qm[1]||1),price,size:null,style:null,status});
  }
  // Target shipping/delivery layouts can omit a nearby Qty in text conversion. Recover the
  // obvious product name immediately after the section heading when necessary.
  if(!items.length && ['shipped','delivered'].includes(status)){
    for(const s of ls){
      if(s.length<6||s.length>220)continue;
      if(/^(shipping|delivers to|united parcel|tracking|track status|item delivered|delivered on|qty|looking for|scan for|vcd|order details)/i.test(s))continue;
      if(/\$|\d{5,}/.test(s))continue;
      items.push({product_name:s,quantity:1,price:null,size:null,style:null,status}); break;
    }
  }
  return items;
}
function parseSupremeItems(text,status){
  const ls=lines(text);
  const orderIdx=ls.findIndex(x=>/^Order\s+\d{6,20}$/i.test(x));
  const items=[]; let mode=status;
  const stop=/^(cart total|shipping & handling|order total|to return an item|for more information)/i;
  for(let i=Math.max(0,orderIdx+1);i<ls.length;i++){
    const s=ls[i]; if(stop.test(s))break;
    if(/^Pending item\(s\) to be shipped/i.test(s)){mode='pending';continue;}
    if(/^\.\.\./.test(s) || /^(style|size|quantity|price)\s*:/i.test(s) || /^\$[0-9]/.test(s))continue;
    if(s.length<3||s.length>220)continue;
    if(/^(online shop|dear |your order|item\(s\)|please allow|tap here|by ups|note:)/i.test(s) || /^supreme$/i.test(s))continue;
    let name=s, size=null, style=null, quantity=1, price=null;
    const suffix=name.match(/\s+-\s+([A-Za-z0-9. -]{1,24})$/); if(suffix){ size=clean(suffix[1]); name=clean(name.slice(0,suffix.index)); }
    for(let j=i+1;j<=Math.min(ls.length-1,i+8);j++){
      if(stop.test(ls[j])||(/^Pending item/.test(ls[j])))break;
      let m=ls[j].match(/^Style:\s*(.+)$/i); if(m)style=clean(m[1]);
      m=ls[j].match(/^Size:\s*(.+)$/i); if(m)size=clean(m[1]);
      m=ls[j].match(/^Quantity:\s*(\d+)/i); if(m)quantity=Number(m[1]||1);
      if(/^Quantity:\s*$/i.test(ls[j]) && /^\d+$/.test(ls[j+1]||'')) quantity=Number(ls[j+1]);
      m=ls[j].match(/^Price:\s*\$?([0-9,.]+)/i); if(m)price=money(m[1]);
      if(/^Price:\s*$/i.test(ls[j]) && /^\$[0-9,.]+$/.test(ls[j+1]||'')) price=money(ls[j+1]);
      if(/^\$[0-9,.]+$/.test(ls[j]) && price==null) price=money(ls[j]);
    }
    if(!items.some(x=>norm(x.product_name)===norm(name) && norm(x.size)===norm(size))) items.push({product_name:name,size,style,quantity,price,status:mode==='pending'?'confirmed':status,shipment_state:mode});
  }
  return items;
}
function targetCancellationScope(subject,text,status){
  if(status!=='canceled') return null;
  const hay=lower(`${subject}\n${text}`);
  if(/sorry,? we had to cancel (?:your )?order|your order has been canceled|order\s*#?\s*\d{10,20}\s+was canceled|we wanted to let you know that order\s*#?\s*\d{10,20}\s+was canceled|you haven['’]t been charged for any items/.test(hay)) return 'full_order';
  if(/canceled an item|cancelled an item|canceled the item below|cancelled the item below|canceled item|cancelled item|your item has been canceled|your item has been cancelled/.test(hay)) return 'item';
  return 'unknown';
}
function parseRetailEmail(store,status,subject,text){
  const orderNumber = store==='supreme'
    ? ((`${subject}\n${text}`.match(/\bOrder\s+(\d{6,20})\b/i)||[])[1]||'')
    : ((`${subject}\n${text}`.match(/\bOrder\s*#?\s*(\d{10,20})\b/i)||[])[1]||'');
  const items=store==='target'?parseTargetItems(text,status):store==='supreme'?parseSupremeItems(text,status):[];
  return {order_number:orderNumber,items,tracking_number:extractTracking(text),cancellation_scope:store==='target'?targetCancellationScope(subject,text,status):null};
}

function fieldPairs(payload={}){
  const out=[]; const embeds=Array.isArray(payload.embeds)?payload.embeds:[];
  for(const embed of embeds) for(const f of embed.fields||[]) out.push([clean(f.name),clean(f.value).replace(/^\|\||\|\|$/g,'')]);
  return out;
}
function expectedWebhookItems(order={}){
  const payload=order.raw_payload||{}; const pairs=fieldPairs(payload); const items=[]; const byIndex=new Map();
  for(const [name,value] of pairs){
    let m=name.match(/^Product\s*(\d+)?\s*-\s*(Name|Size|Price)$/i);
    if(m){ const idx=Number(m[1]||1); const row=byIndex.get(idx)||{}; row[m[2].toLowerCase()]=value; byIndex.set(idx,row); }
  }
  for(const [idx,row] of [...byIndex.entries()].sort((a,b)=>a[0]-b[0])){
    if(!clean(row.name) || money(row.price)===0)continue;
    items.push({product_name:clean(row.name),size:clean(row.size)||null,price:money(row.price),quantity:1});
  }
  if(!items.length){
    const product=clean(order.product_name || order.metadata?.product_name || pairs.find(([n])=>/^product$/i.test(n))?.[1] || '');
    const sku=clean(order.sku || order.metadata?.sku || pairs.find(([n])=>/^sku$/i.test(n))?.[1] || '');
    const price=money(order.metadata?.purchase_price || pairs.find(([n])=>/^(product - )?price$/i.test(n))?.[1]);
    if(product||sku)items.push({product_name:product||sku,sku:sku||null,size:null,price,quantity:Number(order.metadata?.quantity||1)||1});
  }
  return items;
}
function itemSetScore(expected=[],actual=[]){
  if(!expected.length||!actual.length)return 0;
  let total=0, used=new Set();
  for(const e of expected){
    let best={score:0,idx:-1};
    actual.forEach((a,idx)=>{ if(used.has(idx))return; let s=tokenScore(e.product_name||e.sku,a.product_name||a.sku)*60;
      if(e.size&&a.size&&norm(e.size)===norm(a.size))s+=15;
      if(e.price!=null&&a.price!=null&&Math.abs(Number(e.price)-Number(a.price))<0.02)s+=15;
      if(s>best.score)best={score:s,idx}; });
    if(best.idx>=0){used.add(best.idx); total+=best.score;}
  }
  const denom=Math.max(expected.length,actual.length);
  return Math.min(90,total/denom);
}
function matchScore(serviceOrder,emailData,eventAt,mailboxEmail=''){
  const expected=expectedWebhookItems(serviceOrder), actual=emailData.items||[];
  let score=itemSetScore(expected,actual);
  const created=new Date(serviceOrder.created_at||0).getTime(), event=new Date(eventAt||0).getTime();
  if(Number.isFinite(created)&&Number.isFinite(event)){
    const mins=Math.abs(event-created)/60000; if(mins<=2)score+=20; else if(mins<=5)score+=15; else if(mins<=15)score+=8; else if(mins>60)score-=30;
  }
  const profile=norm(serviceOrder.metadata?.profile_name||serviceOrder.metadata?.profile||'');
  if(profile && norm(emailData.customer_name||'').includes(profile))score+=12;
  const emails=new Set();
  const walk=v=>{if(v==null)return;if(Array.isArray(v))return v.forEach(walk);if(typeof v==='object')return Object.values(v).forEach(walk);for(const m of String(v).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig))emails.add(lower(m[0]));}; walk(serviceOrder.raw_payload||{});
  if(mailboxEmail&&emails.has(lower(mailboxEmail)))score+=10;
  return Math.round(score*10)/10;
}
function mainItemMatch(expected,item){
  const best=expected.reduce((m,e)=>Math.max(m,tokenScore(e.product_name||e.sku,item.product_name||item.sku)),0);
  return best>=.58;
}
function deriveOverallStatus(items=[]){
  const main=items.filter(i=>i.role==='main');
  if(!main.length)return 'waiting_confirmation';
  const statuses=main.map(i=>lower(i.status));
  if(statuses.every(s=>s==='delivered'))return 'delivered';
  if(statuses.some(s=>s==='shipped'||s==='delivered'))return 'shipped';
  if(statuses.some(s=>s==='confirmed'||s==='processing'))return 'confirmed';
  if(statuses.every(s=>s==='canceled'||s==='refunded'||s==='missing'))return statuses.some(s=>s==='refunded')?'refunded':'canceled';
  return 'waiting_confirmation';
}
module.exports={clean,lower,money,norm,tokenScore,parseRetailEmail,expectedWebhookItems,itemSetScore,matchScore,mainItemMatch,deriveOverallStatus};
