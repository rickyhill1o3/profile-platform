const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URLSearchParams } = require('url');
const { exec } = require('child_process');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PORT = Number(process.env.AYCD_BRIDGE_PORT || 43821);
const HOST = '127.0.0.1';
const API_BASE = process.env.SHORE_SHACK_API_BASE || 'https://profile-platform.onrender.com';
const CONFIG_DIR = path.join(os.homedir(), '.shore-shack-aycd');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const BRIDGE_FILE = path.join(CONFIG_DIR, 'bridge.json');

function clean(v){ return String(v || '').trim(); }
function readJson(file, fallback={}){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function saveJson(file,data){ fs.mkdirSync(CONFIG_DIR,{recursive:true}); fs.writeFileSync(file,JSON.stringify(data,null,2),{mode:0o600}); }
function esc(v){ return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function sanitize(cfg={}){ return { host:'127.0.0.1', port:Number(cfg.port||43283), username:clean(cfg.username)||'inbox@aycd.me', password:clean(cfg.password), secure:!!cfg.secure, lookbackDays:Math.max(1,Math.min(365,Number(cfg.lookbackDays||240))) }; }
function clientFor(c){ return new ImapFlow({ host:c.host, port:c.port, secure:c.secure, auth:{user:c.username,pass:c.password}, logger:false, connectionTimeout:15000, greetingTimeout:15000, socketTimeout:180000, tls:{rejectUnauthorized:false} }); }
async function postJson(pathname, body, secret=''){
  const r = await fetch(API_BASE + pathname, { method:'POST', headers:{'Content-Type':'application/json', ...(secret?{'x-aycd-bridge-secret':secret}:{})}, body:JSON.stringify(body||{}) });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error || `Website returned ${r.status}`);
  return j;
}
async function testImap(config){
  if(!config.password) throw new Error('AYCD IMAP password has not been saved.');
  const client=clientFor(config);
  try{ await client.connect(); const lock=await client.getMailboxLock('INBOX'); let data; try{ data={mailbox:client.mailbox?.path||'INBOX',messages:Number(client.mailbox?.exists||0)}; } finally { lock.release(); } await client.logout(); return data; }
  catch(e){ try{client.close()}catch{} throw e; }
}
async function scanImap(config){
  const state=readJson(STATE_FILE,{lastUid:0});
  const client=clientFor(config); let checked=0; const messages=[]; let highest=Number(state.lastUid||0);
  try{
    await client.connect(); const lock=await client.getMailboxLock('INBOX');
    try{
      let fetchRange;
      if(highest>0) fetchRange=`${highest+1}:*`;
      else { const uids=await client.search({since:new Date(Date.now()-config.lookbackDays*86400000)}); fetchRange=(uids||[]).slice(-1000); }
      if(Array.isArray(fetchRange)&&!fetchRange.length) fetchRange=[];
      for await(const msg of client.fetch(fetchRange,{uid:true,source:true})){
        checked++; highest=Math.max(highest,Number(msg.uid||0));
        try{ const p=await simpleParser(msg.source); messages.push({uid:msg.uid,messageId:p.messageId||`aycd:${msg.uid}`,subject:p.subject||'',from:p.from?.text||'',text:String(p.text||'').slice(0,250000),html:p.html?String(p.html).slice(0,250000):'',date:p.date||new Date()}); } catch(e){ console.error('Parse failed',msg.uid,e.message); }
      }
    } finally { lock.release(); }
    await client.logout();
    return {checked,messages,highest};
  } catch(e){ try{client.close()}catch{} throw Object.assign(e,{checked}); }
}
function page(message=''){
  const c=readJson(CONFIG_FILE,{}), b=readJson(BRIDGE_FILE,{});
  return `<!doctype html><meta charset="utf-8"><title>Shore Shack AYCD Bridge</title><style>body{font-family:Arial,sans-serif;background:#0f172a;color:#111827;margin:0;padding:30px}.card{max-width:760px;margin:auto;background:white;border-radius:18px;padding:26px;box-shadow:0 20px 60px #0008}label{display:grid;gap:5px;margin:12px 0;font-weight:700}input{padding:11px;border:1px solid #cbd5e1;border-radius:8px}button{padding:11px 15px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;margin-right:8px}.ok{color:#15803d}.bad{color:#b91c1c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wide{grid-column:1/-1}.status{padding:12px;border-radius:10px;background:#f1f5f9}</style><div class="card"><h1>The Shore Shack AYCD Bridge</h1><p class="${message.startsWith('Error')?'bad':'ok'}">${esc(message||'Bridge is running on this laptop.')}</p><div class="status"><b>Local helper:</b> Online at http://${HOST}:${PORT}<br><b>Website:</b> ${esc(API_BASE)}<br><b>Pairing:</b> ${b.secret?'Paired':'Not paired yet'}</div><form method="post" action="/save"><div class="grid"><label>Pairing code<input name="pairCode" placeholder="6-digit code from Order Tracker"></label><label>AYCD port<input name="port" value="${esc(c.port||43283)}"></label><label class="wide">AYCD username<input name="username" value="${esc(c.username||'inbox@aycd.me')}"></label><label class="wide">AYCD IMAP password<input type="password" name="password" placeholder="Leave blank to keep saved password"></label><label>Lookback days<input name="lookbackDays" value="${esc(c.lookbackDays||240)}"></label><label>TLS/SSL<input type="checkbox" name="secure" ${c.secure?'checked':''}></label></div><button type="submit">Save and Pair</button></form><form method="post" action="/test" style="margin-top:12px"><button type="submit">Test AYCD IMAP</button></form><p>Keep AYCD Inbox and this command window open. The bridge checks the website for scan requests every few seconds.</p></div>`;
}
function send(res,status,type,body){ res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'}); res.end(body); }
async function parseBody(req){ return new Promise((resolve,reject)=>{let raw='';req.on('data',d=>{raw+=d;if(raw.length>1024*1024) reject(new Error('Request too large'));});req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(raw))));req.on('error',reject);}); }
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET' && req.url==='/health') return send(res,200,'application/json',JSON.stringify({ok:true,paired:!!readJson(BRIDGE_FILE,{}).secret,port:PORT}));
    if(req.method==='GET' && req.url==='/') return send(res,200,'text/html; charset=utf-8',page());
    if(req.method==='POST' && req.url==='/save'){
      const body=await parseBody(req); const old=readJson(CONFIG_FILE,{}); const cfg=sanitize({...old,...body,password:clean(body.password)||old.password,secure:body.secure==='on'});
      if(!cfg.password) throw new Error('Enter the AYCD IMAP password.'); saveJson(CONFIG_FILE,cfg);
      const code=clean(body.pairCode); if(code){ const claimed=await postJson('/orders/aycd/bridge/claim',{code,device_name:os.hostname()}); saveJson(BRIDGE_FILE,{device_id:claimed.device_id,secret:claimed.secret,pairedAt:new Date().toISOString()}); }
      return send(res,200,'text/html; charset=utf-8',page(code?'Saved and paired successfully.':'AYCD settings saved.'));
    }
    if(req.method==='POST' && req.url==='/test'){
      try{ const d=await testImap(sanitize(readJson(CONFIG_FILE,{}))); return send(res,200,'text/html; charset=utf-8',page(`Connected to ${d.mailbox}. ${d.messages.toLocaleString()} messages exposed.`)); }
      catch(e){ return send(res,400,'text/html; charset=utf-8',page('Error: '+e.message)); }
    }
    return send(res,404,'text/plain','Not found');
  }catch(e){ return send(res,400,'text/html; charset=utf-8',page('Error: '+e.message)); }
});
let busy=false;
async function poll(){
  if(busy) return; const b=readJson(BRIDGE_FILE,{}); if(!b.secret) return;
  busy=true;
  try{
    const cmd=await postJson('/orders/aycd/bridge/poll',{},b.secret);
    if(cmd.command==='scan'){
      const current=readJson(CONFIG_FILE,{}); const cfg=sanitize({...current,lookbackDays:cmd.payload?.lookbackDays||current.lookbackDays});
      try{
        const result=await scanImap(cfg);
        const maxBytes=2*1024*1024;
        const chunks=[]; let current=[]; let size=0;
        for(const message of result.messages){
          const bytes=Buffer.byteLength(JSON.stringify(message),'utf8');
          if(current.length && size+bytes>maxBytes){ chunks.push(current); current=[]; size=0; }
          current.push(message); size+=bytes;
        }
        if(current.length || !chunks.length) chunks.push(current);
        let sent=0;
        for(let i=0;i<chunks.length;i++){
          await postJson('/orders/aycd/bridge/result',{
            success:true, command_id:cmd.command_id, checked:result.checked,
            messages:chunks[i], chunk_index:i, chunk_count:chunks.length,
            final:i===chunks.length-1
          },b.secret);
          sent+=chunks[i].length;
          console.log(`Uploaded AYCD batch ${i+1}/${chunks.length} (${sent}/${result.messages.length} messages).`);
        }
        saveJson(STATE_FILE,{lastUid:result.highest,lastScanAt:new Date().toISOString()});
        console.log(`AYCD scan complete: ${result.checked} messages checked.`);
      }catch(e){
        try{await postJson('/orders/aycd/bridge/result',{success:false,command_id:cmd.command_id,checked:e.checked||0,error:e.message,final:true},b.secret);}catch(_){}
        console.error('AYCD scan failed:',e.message);
      }
    }
  }catch(e){console.error('Bridge poll:',e.message);}finally{busy=false;}
}
server.on('error',e=>{ console.error('\nUnable to start local helper:',e.message); if(e.code==='EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other helper window or restart Windows.`); process.exitCode=1; });
server.listen(PORT,HOST,()=>{
  console.log(`Shore Shack AYCD bridge running at http://${HOST}:${PORT}`);
  console.log('Keep this window open. Closing it takes the helper offline.');
  setTimeout(()=>exec(`start "" "http://${HOST}:${PORT}/"`),500);
  setInterval(poll,5000); poll();
});
