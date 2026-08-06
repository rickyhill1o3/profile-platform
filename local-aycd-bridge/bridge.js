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
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function uidSet(uids){ return [...new Set((uids||[]).map(Number).filter(Boolean))].sort((a,b)=>a-b).join(','); }
async function postJson(pathname, body, secret='', options={}){
  const attempts=Math.max(1,Number(options.attempts||1));
  const timeoutMs=Math.max(5000,Number(options.timeoutMs||180000));
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await fetch(API_BASE+pathname,{method:'POST',headers:{'Content-Type':'application/json',...(secret?{'x-aycd-bridge-secret':secret}:{})},body:JSON.stringify(body||{}),signal:controller.signal});
      const j=await r.json().catch(()=>({}));
      if(!r.ok){ const e=new Error(j.error||`Website returned ${r.status}`); e.status=r.status; throw e; }
      return j;
    }catch(e){
      lastError=e;
      const retryable=!e.status || e.status===408 || e.status===429 || e.status>=500;
      if(attempt>=attempts || !retryable) throw e;
      const wait=Math.min(30000,1500*Math.pow(2,attempt-1));
      console.log(`Upload attempt ${attempt}/${attempts} failed (${e.message}). Retrying in ${Math.round(wait/1000)}s...`);
      await sleep(wait);
    }finally{ clearTimeout(timer); }
  }
  throw lastError||new Error('Request failed');
}

async function getJson(pathname, secret='', options={}){
  const attempts=Math.max(1,Number(options.attempts||3));
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const r=await fetch(API_BASE+pathname,{headers:{...(secret?{'x-aycd-bridge-secret':secret}:{})}});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error||`Website returned ${r.status}`);
      return j;
    }catch(e){
      lastError=e;
      if(attempt>=attempts) throw e;
      await sleep(1000*attempt);
    }
  }
  throw lastError;
}

async function testImap(config){
  if(!config.password) throw new Error('AYCD IMAP password has not been saved.');
  const client=clientFor(config);
  try{ await client.connect(); const lock=await client.getMailboxLock('INBOX'); let data; try{ data={mailbox:client.mailbox?.path||'INBOX',messages:Number(client.mailbox?.exists||0)}; } finally { lock.release(); } await client.logout(); return data; }
  catch(e){ try{client.close()}catch{} throw e; }
}
async function discoverScanPlan(config){
  const rawState=readJson(STATE_FILE,{});
  // Preserve checkpoints created by every earlier bridge version.
  const state={
    version:6,
    lastUid:Number(rawState.lastUid||0),
    historicalComplete:!!rawState.historicalComplete,
    skippedUids:[...new Set((rawState.skippedUids||[]).map(Number).filter(Boolean))].sort((a,b)=>a-b)
  };
  const client=clientFor(config);
  try{
    await client.connect();
    const lock=await client.getMailboxLock('INBOX');
    try{
      let uids=[];
      if(state.lastUid>0){
        // AYCD exposes a virtual unified mailbox. Its UID ordering can change when Inbox
        // refreshes, so a strict lastUid+1 cursor can miss brand-new mail whose UID was
        // inserted below the previous checkpoint. Always union the forward cursor with a
        // rolling recent-date search. The website deduplicates by message-id.
        const needsRepair=Number(rawState.version||0)<6 && !rawState.v6BackfillComplete;
        const startUid=needsRepair ? Math.max(1,state.lastUid-750) : state.lastUid+1;
        const forward=await client.search({uid:`${startUid}:*`});
        const rollingDays=Math.max(2,Math.min(30,Number(process.env.AYCD_ROLLING_LOOKBACK_DAYS||10)));
        const recent=await client.search({since:new Date(Date.now()-rollingDays*86400000)});
        uids=[...(forward||[]),...(recent||[])];
        state.v6BackfillComplete=needsRepair || !!rawState.v6BackfillComplete;
      }else{
        uids=await client.search({since:new Date(Date.now()-config.lookbackDays*86400000)});
      }
      // Newest-first is intentional: current confirmations must be uploaded before a large
      // backlog of old temporarily unavailable AYCD bodies.
      uids=[...new Set((uids||[]).map(Number).filter(Boolean))].sort((a,b)=>b-a);
      const scanCap=Math.max(100,Math.min(5000,Number(process.env.AYCD_MAX_UIDS_PER_SCAN||1500)));
      uids=uids.slice(0,scanCap);
      return {uids,state,retryUids:[...(state.skippedUids||[])],mailboxCount:Number(client.mailbox?.exists||0)};
    }finally{ lock.release(); }
  }finally{ try{await client.logout();}catch(_){try{client.close()}catch(__){}} }
}
function recipientList(parsed){
  const values=[];
  const add=v=>{ if(!v) return; if(Array.isArray(v)) v.forEach(add); else values.push(String(v)); };
  add(parsed.to?.text); add(parsed.cc?.text); add(parsed.bcc?.text);
  try{ add(parsed.headers?.get('delivered-to')); }catch(_){}
  try{ add(parsed.headers?.get('x-original-to')); }catch(_){}
  try{ add(parsed.headers?.get('envelope-to')); }catch(_){}
  const out=new Set();
  for(const value of values){
    for(const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)) out.add(match[0].toLowerCase());
  }
  return [...out];
}
async function fetchMessageBatch(config,uids){
  const requested=[...new Set((uids||[]).map(Number).filter(Boolean))].sort((a,b)=>a-b);
  const messages=[];
  const skipped=[];
  const returned=new Set();
  let highest=0;

  async function parseMessage(msg){
    const uid=Number(msg.uid||0);
    if(uid) returned.add(uid);
    highest=Math.max(highest,uid);
    try{
      const p=await simpleParser(msg.source);
      messages.push({
        uid,messageId:p.messageId||`aycd:${uid}`,subject:p.subject||'',from:p.from?.text||'',
        to:p.to?.text||'',cc:p.cc?.text||'',recipients:recipientList(p),
        text:String(p.text||'').slice(0,60000),html:p.html?String(p.html).slice(0,60000):'',date:p.date||new Date()
      });
      return true;
    }catch(e){
      console.error(`Parse failed for AYCD UID ${uid}: ${e.message}`);
      skipped.push(uid);
      return false;
    }
  }

  async function fetchSet(client, list){
    const set=uidSet(list);
    if(!set) return;
    for await(const msg of client.fetch(set,{uid:true,source:true},{uid:true})) await parseMessage(msg);
  }

  const client=clientFor(config);
  try{
    await client.connect();
    const lock=await client.getMailboxLock('INBOX');
    try{
      try{
        await fetchSet(client,requested);
      }catch(groupError){
        console.warn(`AYCD group fetch failed (${groupError.responseText||groupError.message}). Retrying ${requested.length} messages individually...`);
        for(const uid of requested){
          let completed=false;
          for(let attempt=1;attempt<=3;attempt++){
            try{
              const before=returned.has(uid);
              await fetchSet(client,[uid]);
              if(!returned.has(uid) && !before) throw new Error('AYCD returned no body for this UID.');
              completed=true;
              break;
            }catch(e){
              if(attempt<3){
                console.log(`AYCD UID ${uid} unavailable. Retry ${attempt}/2 in ${attempt*2}s...`);
                await sleep(attempt*2000);
              }else{
                highest=Math.max(highest,uid);
                skipped.push(uid);
                console.warn(`Skipping AYCD UID ${uid} for this scan: ${e.responseText||e.message}`);
              }
            }
          }
          if(!completed && !skipped.includes(uid)) skipped.push(uid);
        }
      }

      // AYCD sometimes returns no row and no error for a requested UID. Older bridge
      // versions treated that as success and permanently skipped the message. Every
      // requested UID that was not actually returned is now preserved for later retry.
      for(const uid of requested){
        if(!returned.has(uid) && !skipped.includes(uid)) skipped.push(uid);
      }
    }finally{ lock.release(); }
    return {messages,highest:Math.max(highest,...requested,0),skippedUids:[...new Set(skipped.filter(Boolean))].sort((a,b)=>a-b)};
  }finally{ try{await client.logout();}catch(_){try{client.close()}catch(__){}} }
}



let stateWriteChain=Promise.resolve();
function updateDirectState(mutator){
  stateWriteChain=stateWriteChain.then(()=>{const state=directState();mutator(state);saveJson(STATE_FILE,state);}).catch(e=>console.error('State save failed:',e.message));
  return stateWriteChain;
}

function directState(){
  const raw=readJson(STATE_FILE,{});
  return {version:7,accounts:raw.accounts&&typeof raw.accounts==='object'?raw.accounts:{},lastScanAt:raw.lastScanAt||null};
}

async function scanOneAycdAccount(baseConfig,email,lookbackDays){
  const state=directState();
  const accountState=state.accounts[email]||{};
  const config={...baseConfig,username:email};
  const client=clientFor(config);
  const messages=[];
  let highest=Number(accountState.lastUid||0);
  try{
    await client.connect();
    const lock=await client.getMailboxLock('INBOX');
    try{
      const rollingDays=Math.max(2,Math.min(30,Number(process.env.AYCD_DIRECT_ROLLING_DAYS||10)));
      const recent=await client.search({since:new Date(Date.now()-rollingDays*86400000)});
      let forward=[];
      if(accountState.lastUid>0) forward=await client.search({uid:`${Number(accountState.lastUid)+1}:*`});
      else forward=await client.search({since:new Date(Date.now()-lookbackDays*86400000)});
      let uids=[...new Set([...(forward||[]),...(recent||[])].map(Number).filter(Boolean))].sort((a,b)=>a-b);
      const cap=Math.max(20,Math.min(500,Number(process.env.AYCD_DIRECT_MAX_MESSAGES_PER_ACCOUNT||150)));
      uids=uids.slice(-cap);
      if(uids.length){
        const set=uidSet(uids);
        for await(const msg of client.fetch(set,{uid:true,source:true},{uid:true})){
          highest=Math.max(highest,Number(msg.uid||0));
          try{
            const parsed=await simpleParser(msg.source);
            messages.push({
              uid:Number(msg.uid||0),mailboxEmail:email,
              messageId:parsed.messageId||`aycd:${email}:${msg.uid}`,
              subject:parsed.subject||'',from:parsed.from?.text||'',to:parsed.to?.text||'',cc:parsed.cc?.text||'',
              recipients:[email,...recipientList(parsed)],text:String(parsed.text||'').slice(0,60000),
              html:parsed.html?String(parsed.html).slice(0,60000):'',date:parsed.date||new Date()
            });
          }catch(e){ console.warn(`Parse failed for ${email} UID ${msg.uid}: ${e.message}`); }
        }
      }
      await updateDirectState(current=>{
        current.accounts[email]={lastUid:highest,lastSuccessAt:new Date().toISOString(),lastError:null};
        current.lastScanAt=new Date().toISOString();
      });
      return {email,messages,highest,exists:Number(client.mailbox?.exists||0)};
    }finally{lock.release();}
  }catch(e){
    await updateDirectState(current=>{current.accounts[email]={...(current.accounts[email]||accountState),lastError:e.message,lastAttemptAt:new Date().toISOString()};});
    return {email,messages:[],error:e.message};
  }finally{try{await client.logout();}catch(_){try{client.close()}catch(__){}}}
}

async function scanAycdAccountsDirect(cfg,bridge,cmd){
  const response=await getJson('/orders/aycd/bridge/accounts',bridge.secret,{attempts:5});
  const accounts=(response.accounts||[]).map(x=>typeof x==='string'?{email:x,priority:50}:x).filter(x=>x.email);
  if(!accounts.length) throw new Error('No AYCD account addresses were found. Save profiles with Use AYCD Unified Inbox enabled or ingest the historical mailbox list first.');
  const concurrency=Math.max(1,Math.min(20,Number(process.env.AYCD_DIRECT_CONCURRENCY||8)));
  const maxPayloadBytes=Math.max(96*1024,Math.min(400*1024,Number(process.env.AYCD_UPLOAD_MAX_BYTES||250*1024)));
  let cursor=0,finished=0,sent=0,uploadIndex=0,failed=0;
  async function worker(){
    while(true){
      const index=cursor++;
      if(index>=accounts.length) return;
      const account=accounts[index];
      const result=await scanOneAycdAccount(cfg,account.email,Number(cmd.payload?.lookbackDays||cfg.lookbackDays||240));
      finished++;
      if(result.error){failed++;console.warn(`AYCD direct account ${account.email} failed: ${result.error}`);continue;}
      const parts=splitMessagesByPayloadSize(result.messages,maxPayloadBytes,10);
      for(const messages of parts){
        await postJson('/orders/aycd/bridge/result',{
          success:true,command_id:cmd.command_id,checked:messages.length,messages,
          chunk_index:uploadIndex++,chunk_count:0,final:false,
          scan_progress:{processed:finished,total:accounts.length,mailbox_count:accounts.length,mode:'direct_accounts',current_account:account.email}
        },bridge.secret,{attempts:6,timeoutMs:180000});
        sent+=messages.length;
        console.log(`Uploaded ${messages.length} message(s) from ${account.email}. Accounts ${finished}/${accounts.length}; total messages ${sent}.`);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,accounts.length)},()=>worker()));
  await postJson('/orders/aycd/bridge/result',{
    success:true,command_id:cmd.command_id,checked:0,messages:[],chunk_index:uploadIndex,chunk_count:0,final:true,
    scan_progress:{processed:accounts.length,total:accounts.length,mailbox_count:accounts.length,mode:'direct_accounts',failed_accounts:failed}
  },bridge.secret,{attempts:6,timeoutMs:180000});
  console.log(`AYCD direct-account scan complete: ${accounts.length-failed}/${accounts.length} accounts checked, ${sent} messages uploaded, ${failed} account(s) failed.`);
}

function splitMessagesByPayloadSize(messages, maxBytes=500*1024, maxMessages=50){
  const chunks=[];
  let current=[];
  let currentBytes=2;
  for(const original of messages||[]){
    let item=original;
    let encoded=JSON.stringify(item);
    if(Buffer.byteLength(encoded,'utf8')>maxBytes-4096){
      item={...item,text:String(item.text||'').slice(0,18000),html:String(item.html||'').slice(0,18000)};
      encoded=JSON.stringify(item);
    }
    const itemBytes=Buffer.byteLength(encoded,'utf8')+1;
    if(current.length && (current.length>=maxMessages || currentBytes+itemBytes>maxBytes)){
      chunks.push(current); current=[]; currentBytes=2;
    }
    current.push(item); currentBytes+=itemBytes;
  }
  if(current.length) chunks.push(current);
  return chunks;
}


function page(message=''){
  const c=readJson(CONFIG_FILE,{}), b=readJson(BRIDGE_FILE,{});
  return `<!doctype html><meta charset="utf-8"><title>Shore Shack AYCD Bridge</title><style>body{font-family:Arial,sans-serif;background:#0f172a;color:#111827;margin:0;padding:30px}.card{max-width:760px;margin:auto;background:white;border-radius:18px;padding:26px;box-shadow:0 20px 60px #0008}label{display:grid;gap:5px;margin:12px 0;font-weight:700}input{padding:11px;border:1px solid #cbd5e1;border-radius:8px}button{padding:11px 15px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;margin-right:8px}.ok{color:#15803d}.bad{color:#b91c1c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wide{grid-column:1/-1}.status{padding:12px;border-radius:10px;background:#f1f5f9}</style><div class="card"><h1>The Shore Shack AYCD Bridge</h1><p class="${message.startsWith('Error')?'bad':'ok'}">${esc(message||'Bridge is running on this laptop.')}</p><div class="status"><b>Local helper:</b> Online at http://${HOST}:${PORT}<br><b>Website:</b> ${esc(API_BASE)}<br><b>Pairing:</b> ${b.secret?'Paired':'Not paired yet'}</div><form method="post" action="/save"><div class="grid"><label>Pairing code<input name="pairCode" placeholder="6-digit code from Order Tracker"></label><label>AYCD port<input name="port" value="${esc(c.port||43283)}"></label><label class="wide">AYCD test username<input name="username" value="${esc(c.username||'inbox@aycd.me')}"></label><label class="wide">AYCD IMAP password<input type="password" name="password" placeholder="Leave blank to keep saved password"></label><label>Lookback days<input name="lookbackDays" value="${esc(c.lookbackDays||240)}"></label><label>TLS/SSL<input type="checkbox" name="secure" ${c.secure?'checked':''}></label></div><button type="submit">Save and Pair</button></form><form method="post" action="/test" style="margin-top:12px"><button type="submit">Test AYCD IMAP</button></form><p>Keep AYCD open with IMAP Server enabled and leave this command window open. Scans connect directly to each exposed AYCD account; the unified inbox is not used for ingestion.</p></div>`;
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
    if(cmd.command==='reset_checkpoint'){
      try{
        if(fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        await postJson('/orders/aycd/bridge/result',{success:true,command_id:cmd.command_id,checked:0,messages:[],final:true,reset_checkpoint:true},b.secret,{attempts:6});
        console.log('AYCD checkpoint reset. The next scan will start from the beginning of the configured lookback window.');
      }catch(e){
        try{await postJson('/orders/aycd/bridge/result',{success:false,command_id:cmd.command_id,checked:0,error:e.message,final:true},b.secret);}catch(_){}
        console.error('AYCD checkpoint reset failed:',e.message);
      }
    }else if(cmd.command==='scan'){
      const current=readJson(CONFIG_FILE,{}); const cfg=sanitize({...current,lookbackDays:cmd.payload?.lookbackDays||current.lookbackDays});
      try{
        // Version 7 scans every exposed AYCD mailbox directly. The unified inbox is no
        // longer used for ingestion because it is an aggregate cache and can omit current mail.
        await scanAycdAccountsDirect(cfg,{...b,secret:b.secret},cmd);
        return;
        const plan=await discoverScanPlan(cfg);
        // Small 50-UID groups reduce AYCD pressure and make recovery granular.
        const uidBatchSize=Math.max(1,Math.min(25,Number(process.env.AYCD_UID_BATCH_SIZE||10)));
        const uidChunks=[];
        for(let i=0;i<plan.uids.length;i+=uidBatchSize) uidChunks.push(plan.uids.slice(i,i+uidBatchSize));
        if(!uidChunks.length){
          await postJson('/orders/aycd/bridge/result',{success:true,command_id:cmd.command_id,checked:0,messages:[],chunk_index:0,chunk_count:1,final:true},b.secret,{attempts:6});
          saveJson(STATE_FILE,{version:6,lastUid:Number(plan.state.lastUid||0),skippedUids:plan.state.skippedUids||[],historicalComplete:true,v6BackfillComplete:!!plan.state.v6BackfillComplete,lastScanAt:new Date().toISOString()});
          console.log('AYCD scan complete: no new messages.');
        }else{
          let sent=0, uploadIndex=0;
          const maxPayloadBytes=Math.max(96*1024,Math.min(400*1024,Number(process.env.AYCD_UPLOAD_MAX_BYTES||250*1024)));
          for(let i=0;i<uidChunks.length;i++){
            const sourceUids=uidChunks[i];
            const batch=await fetchMessageBatch(cfg,sourceUids);
            const uploadChunks=splitMessagesByPayloadSize(batch.messages,maxPayloadBytes,10);

            for(let part=0;part<uploadChunks.length;part++){
              const messages=uploadChunks[part];
              const isFinal=false;
              await postJson('/orders/aycd/bridge/result',{
                success:true,command_id:cmd.command_id,checked:messages.length,messages,
                chunk_index:uploadIndex,chunk_count:0,final:isFinal,
                scan_progress:{processed:sent+messages.length,total:plan.uids.length,mailbox_count:plan.mailboxCount}
              },b.secret,{attempts:6,timeoutMs:180000});

              // The website accepted these exact messages. Persist their highest UID immediately.
              const acceptedHighest=messages.reduce((m,x)=>Math.max(m,Number(x.uid||0)),0);
              const current=readJson(STATE_FILE,{});
              const skippedSet=new Set([...(current.skippedUids||[]),...(batch.skippedUids||[])].map(Number).filter(Boolean));
              for(const message of messages) skippedSet.delete(Number(message.uid||0));
              saveJson(STATE_FILE,{
                version:6,
                lastUid:Math.max(Number(current.lastUid||0),Math.max(...sourceUids.map(Number),acceptedHighest)),
                skippedUids:[...skippedSet].sort((a,b)=>a-b),
                historicalComplete:isFinal,
                v6BackfillComplete:!!plan.state.v6BackfillComplete,
                lastScanAt:new Date().toISOString(),
                uploadedMessages:Number(current.uploadedMessages||0)+messages.length
              });
              sent+=messages.length;
              uploadIndex+=1;
              const persisted=readJson(STATE_FILE,{});
              console.log(`Uploaded AYCD payload ${uploadIndex} (${sent}/${plan.uids.length} messages, ${Math.round(Buffer.byteLength(JSON.stringify(messages),'utf8')/1024)} KB). Durable checkpoint UID ${Number(persisted.lastUid||0)}.`);
            }

            // If every UID in this group was unavailable, record them for retry but move
            // the contiguous cursor forward so later mail can still be processed.
            if(!uploadChunks.length){
              const current=readJson(STATE_FILE,{});
              const skippedSet=new Set([...(current.skippedUids||[]),...(batch.skippedUids||[])].map(Number).filter(Boolean));
              const groupHighest=Math.max(...sourceUids.map(Number));
              saveJson(STATE_FILE,{version:6,lastUid:Math.max(Number(current.lastUid||0),groupHighest),skippedUids:[...skippedSet].sort((a,b)=>a-b),historicalComplete:false,v6BackfillComplete:!!plan.state.v6BackfillComplete,lastScanAt:new Date().toISOString(),uploadedMessages:Number(current.uploadedMessages||0)});
              console.log(`No available bodies in this AYCD group. Saved ${skippedSet.size} UID(s) for retry and continued after UID ${groupHighest}.`);
            }
          }

          // Retry a limited number of older unavailable UIDs after forward progress
          // is safely checkpointed. These retries never lower or reset lastUid.
          const retryQueue=[...new Set((readJson(STATE_FILE,{}).skippedUids||[]).map(Number).filter(Boolean))].sort((a,b)=>b-a).slice(0,16);
          for(const retryUid of retryQueue){
            try{
              const retryBatch=await fetchMessageBatch(cfg,[retryUid]);
              if(retryBatch.messages.length){
                const retryParts=splitMessagesByPayloadSize(retryBatch.messages,maxPayloadBytes,1);
                for(const messages of retryParts){
                  await postJson('/orders/aycd/bridge/result',{
                    success:true,command_id:cmd.command_id,checked:messages.length,messages,
                    chunk_index:uploadIndex,chunk_count:0,final:false,
                    scan_progress:{processed:plan.uids.length,total:plan.uids.length,mailbox_count:plan.mailboxCount}
                  },b.secret,{attempts:6,timeoutMs:180000});
                  uploadIndex+=1;
                }
                const current=readJson(STATE_FILE,{});
                const remaining=(current.skippedUids||[]).map(Number).filter(uid=>uid!==retryUid);
                saveJson(STATE_FILE,{...current,version:6,lastUid:Number(current.lastUid||0),skippedUids:remaining,lastScanAt:new Date().toISOString()});
                console.log(`Recovered previously unavailable AYCD UID ${retryUid}. Durable checkpoint remains ${Number(current.lastUid||0)}.`);
              }
            }catch(e){
              console.log(`AYCD UID ${retryUid} is still unavailable; it remains queued for a later scan.`);
            }
          }

          // Always send a tiny final marker after all groups. This closes the command even
          // when the final group contained only skipped messages.
          await postJson('/orders/aycd/bridge/result',{success:true,command_id:cmd.command_id,checked:0,messages:[],chunk_index:uploadIndex,chunk_count:0,final:true,scan_progress:{processed:plan.uids.length,total:plan.uids.length,mailbox_count:plan.mailboxCount}},b.secret,{attempts:6,timeoutMs:180000});
          const current=readJson(STATE_FILE,{});
          saveJson(STATE_FILE,{...current,version:6,historicalComplete:true,v6BackfillComplete:!!plan.state.v6BackfillComplete,lastScanAt:new Date().toISOString()});
          console.log(`AYCD scan complete: ${sent} messages uploaded. ${Number(current.skippedUids?.length||0)} temporarily unavailable UID(s) remain queued for a later scan.`);
        }
      }catch(e){
        try{await postJson('/orders/aycd/bridge/result',{success:false,command_id:cmd.command_id,checked:e.checked||0,error:e.message,final:true},b.secret);}catch(_){}
        console.error('AYCD scan failed:',e.message); if(e.responseText) console.error('IMAP response:',e.responseText); if(e.code) console.error('Error code:',e.code);
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
