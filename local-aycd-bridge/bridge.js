const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = 43821;
const CONFIG_DIR = path.join(os.homedir(), '.shore-shack-aycd');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Private-Network','true');res.setHeader('Cache-Control','no-store');next()});
const corsOptions={origin:['https://theshoreshacktcg.com','https://www.theshoreshacktcg.com','http://localhost:3000','http://127.0.0.1:3000'],methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type'],optionsSuccessStatus:204};
app.use(cors(corsOptions));
app.options(/.*/,cors(corsOptions));
app.use(express.json({limit:'25mb'}));
function clean(v){return String(v||'').trim()}
function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function saveJson(file,data){fs.mkdirSync(CONFIG_DIR,{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2),{mode:0o600})}
function sanitize(cfg={}){return {host:clean(cfg.host)||'127.0.0.1',port:Number(cfg.port||43283),username:clean(cfg.username)||'inbox@aycd.me',password:clean(cfg.password),secure:!!cfg.secure,lookbackDays:Math.max(1,Math.min(90,Number(cfg.lookbackDays||30)))}}
function mergedSettings(body={}){const saved=readJson(CONFIG_FILE,{});const next=sanitize({...saved,...body});if(!next.password)next.password=saved.password||'';return next}
function clientFor(c){return new ImapFlow({host:c.host,port:c.port,secure:c.secure,auth:{user:c.username,pass:c.password},logger:false,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:120000,tls:{rejectUnauthorized:false}})}
app.get('/health',(req,res)=>{const c=readJson(CONFIG_FILE,{});res.json({ok:true,configured:!!c.password,host:c.host,port:c.port,username:c.username,secure:!!c.secure,lookbackDays:c.lookbackDays})});
app.post('/configure',(req,res)=>{const c=mergedSettings(req.body);if(!c.password)return res.status(400).json({error:'Enter the AYCD IMAP password shown on the IMAP Server page.'});saveJson(CONFIG_FILE,c);res.json({success:true})});
app.post('/test',async(req,res)=>{const c=mergedSettings(req.body);if(!c.password)return res.status(400).json({error:'Enter or save the AYCD IMAP password first.'});const client=clientFor(c);try{await client.connect();const lock=await client.getMailboxLock('INBOX');let data;try{data={mailbox:client.mailbox?.path||'INBOX',messages:Number(client.mailbox?.exists||0)}}finally{lock.release()}await client.logout();res.json({success:true,...data})}catch(e){try{client.close()}catch{}res.status(400).json({error:`AYCD IMAP connection failed: ${e.message}`})}});
app.post('/scan',async(req,res)=>{const c=mergedSettings(req.body?.settings||{});const apiBase=clean(req.body?.apiBase);const token=clean(req.body?.token);if(!c.password)return res.status(400).json({error:'Enter or save the AYCD IMAP password first.'});if(!/^https?:\/\//i.test(apiBase)||!token)return res.status(400).json({error:'Website session information is missing.'});const state=readJson(STATE_FILE,{lastUid:0});const client=clientFor(c);let checked=0;const messages=[];let highest=Number(state.lastUid||0);try{await client.connect();const lock=await client.getMailboxLock('INBOX');try{let fetchRange;if(highest>0){fetchRange=`${highest+1}:*`}else{const uids=await client.search({since:new Date(Date.now()-c.lookbackDays*86400000)});fetchRange=(uids||[]).slice(-1000)}if(Array.isArray(fetchRange)&&!fetchRange.length){fetchRange=[]}for await(const msg of client.fetch(fetchRange,{uid:true,source:true})){checked++;highest=Math.max(highest,Number(msg.uid||0));try{const p=await simpleParser(msg.source);messages.push({uid:msg.uid,messageId:p.messageId||`aycd:${msg.uid}`,subject:p.subject||'',from:p.from?.text||'',text:String(p.text||'').slice(0,250000),html:p.html?String(p.html).slice(0,250000):'',date:p.date||new Date()})}catch(e){console.error('Parse failed',msg.uid,e.message)}}}finally{lock.release()}await client.logout();const response=await fetch(apiBase+'/orders/aycd-bridge-ingest',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messages})});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||`Website returned ${response.status}`);saveJson(STATE_FILE,{lastUid:highest,lastScanAt:new Date().toISOString()});res.json({success:true,checked,...payload})}catch(e){try{client.close()}catch{}res.status(500).json({error:e.message,checked})}});
app.listen(PORT,'127.0.0.1',()=>console.log(`The Shore Shack AYCD bridge is running at http://127.0.0.1:${PORT}`));
