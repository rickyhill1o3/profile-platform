const API=location.hostname==='localhost'||location.hostname==='127.0.0.1'?'http://localhost:3000':'https://profile-platform.onrender.com';
const token=localStorage.getItem('token');
if(!token) location.href='login.html';
const headers={'Authorization':`Bearer ${token}`,'Content-Type':'application/json'};
let allOrders=[];
const $=id=>document.getElementById(id);
function logout(){localStorage.removeItem('token');location.href='login.html'}
function money(n){return `$${Number(n||0).toFixed(2)}`}
function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function initYears(){const s=$('yearFilter'),y=new Date().getFullYear();s.innerHTML='<option value="">All years</option>';for(let i=y;i>=y-7;i--)s.innerHTML+=`<option value="${i}">${i}</option>`}
async function api(path,opt={}){const r=await fetch(API+path,{...opt,headers:{...headers,...(opt.headers||{})}});if(r.status===401){logout();return}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`Request failed (${r.status})`);return j}
function setProgress(percent,stage,detail=''){const p=Math.max(0,Math.min(100,Number(percent)||0));$('scanProgressBar').style.width=`${p}%`;$('scanPercent').textContent=`${Math.round(p)}%`;if(stage)$('scanStage').textContent=stage;if(detail)$('scanDetail').textContent=detail}
function showWarning(text){$('scanWarning').hidden=!text;$('scanWarning').textContent=text||''}
function renderAccounts(accounts=[]){const el=$('scanAccounts');el.innerHTML=accounts.length?accounts.map(a=>`<div class="mail-account"><div class="mail-ok">✓ ${esc(a.email)}</div><div>${esc(a.provider||'IMAP')} · ${a.last_success_at?'Last scan '+new Date(a.last_success_at).toLocaleString():'Ready for first scan'}</div>${a.scanned_through_at?`<div class="subtle-text">Scanned through ${new Date(a.scanned_through_at).toLocaleString()}</div>`:''}${a.last_error?`<div class="mail-error">${esc(a.last_error)}</div>`:''}</div>`).join(''):'<p class="subtle-text">No supported IMAP/app password was found in saved profiles.</p>'}
function applyOrders(orders=[],summary={}){allOrders=orders;render();$('countAll').textContent=allOrders.length;$('countActive').textContent=(summary.confirmed||0)+(summary.processing||0);$('countSuccess').textContent=(summary.shipped||0)+(summary.delivered||0);$('countCanceled').textContent=(summary.canceled||0)+(summary.refunded||0);$('successRate').textContent=`${Number(summary.success_rate||0).toFixed(1)}%`}
async function bootstrap(){const j=await api('/orders/bootstrap');renderAccounts(j.accounts||[]);applyOrders(j.orders||[],j.summary||{});$('scanMessage').textContent=`${j.connected_count||0} connected mailbox${Number(j.connected_count||0)===1?'':'es'}. Scans continue from the last saved IMAP UID, so previously checked messages are not searched again.`;if(j.is_super_admin){$('aycdPanel').hidden=false;refreshAycdStatus()}return j}
async function loadOrders(){const qs=new URLSearchParams();if($('statusFilter').value)qs.set('status',$('statusFilter').value);if($('yearFilter').value)qs.set('year',$('yearFilter').value);const j=await api('/orders/tracked?'+qs);applyOrders(j.orders||[],j.summary||{})}
function render(){const q=$('searchOrders').value.toLowerCase();const rows=allOrders.filter(o=>`${o.store} ${o.order_number} ${o.product_summary}`.toLowerCase().includes(q));$('ordersList').innerHTML=rows.length?rows.map(o=>`<article class="order-card"><div class="order-head"><div><span class="status-pill status-${esc(o.status)}">${esc(o.status)}</span><h3>${esc(o.store).toUpperCase()} · ${esc(o.order_number)}</h3><p>${esc(o.product_summary||'Product details will improve as receipt emails are parsed.')}</p></div><strong>${money(o.total)}</strong></div><div class="order-meta"><div><small>Order date</small><br><b>${o.order_date?new Date(o.order_date).toLocaleDateString():'—'}</b></div><div><small>Tracking</small><br><b>${esc(o.tracking_number||'—')}</b></div><div><small>Credits spent</small><br><b>${money(o.credits_spent)}</b></div><div><small>Last update</small><br><b>${o.last_status_at?new Date(o.last_status_at).toLocaleString():'—'}</b></div></div><div class="order-actions"><button class="btn" onclick="openReceipt('${o.id}')">View / Print Receipt</button><button class="btn" onclick="editOrder('${o.id}')">Edit</button><button class="btn btn-danger" onclick="deleteOrder('${o.id}')">Delete</button></div></article>`).join(''):'<section class="tracker-panel"><p>No tracked orders match this view yet.</p></section>'}
async function openReceipt(id){const r=await fetch(`${API}/orders/receipt/${id}`,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok){alert('Receipt could not be opened');return}const html=await r.text();const w=window.open('','_blank');w.document.open();w.document.write(html);w.document.close()}
async function editOrder(id){const o=allOrders.find(x=>x.id===id);const status=prompt('Status: confirmed, processing, shipped, delivered, canceled, refunded',o.status);if(!status)return;const credits=prompt('Credits spent for this order',o.credits_spent||0);await api('/orders/tracked/'+id,{method:'PATCH',body:JSON.stringify({status,credits_spent:Number(credits||0)})});loadOrders()}
async function deleteOrder(id){if(!confirm('Delete this tracked order and its stored receipt?'))return;await api('/orders/tracked/'+id,{method:'DELETE'});loadOrders()}
async function runAutomaticScan(){setProgress(8,'Preparing your order tracker…','Loading existing orders and connected mailbox records.');const first=await bootstrap();if(!Number(first.connected_count||0)){setProgress(100,'Order tracker ready','No connected IMAP accounts were found. Existing website orders are still available.');return}
  setProgress(12,'Starting automatic email scan…','Only messages newer than each mailbox’s saved scan position will be checked.');
  const started=await api('/orders/scan/start',{method:'POST',body:'{}'});let job=started.job;const deadline=Date.now()+20*60*1000;
  while(job&&job.status==='running'&&Date.now()<deadline){const message=job.email?`Scanning ${job.email}`:'Scanning connected mailboxes';setProgress(Math.max(12,job.percent||12),message,job.message||'Checking unscanned email messages…');await new Promise(r=>setTimeout(r,1200));job=(await api('/orders/scan-progress')).job}
  if(job?.status==='failed')showWarning(job.error||'The email scan finished with an error. Saved orders will still load.');
  if(Date.now()>=deadline)showWarning('The scan is still running in the background. The page loaded saved orders while it continues.');
  setProgress(97,'Refreshing order statuses…','Loading confirmations, cancellations, shipping, and delivery updates.');await bootstrap();setProgress(100,'Order tracker ready','All saved results are loaded. Future visits only check newer messages, so they should be much faster than the first historical scan.');
}
async function refreshAycdStatus(){
  try{
    const j=await api('/orders/aycd/device-status');
    const status=$('aycdBridgeStatus');
    if(!j.paired){status.textContent='Not paired';status.className='status-pill status-canceled';$('aycdMessage').textContent='Generate a pairing code, then enter it in the local bridge page on the AYCD laptop.';return}
    if(j.online){status.textContent='Online';status.className='status-pill status-confirmed'}else{status.textContent='Offline';status.className='status-pill status-canceled'}
    const d=j.device||{};
    $('aycdMessage').textContent=`${d.name||'AYCD laptop'} · ${j.online?'connected now':'last seen '+(d.last_seen_at?new Date(d.last_seen_at).toLocaleString():'never')}${d.last_scan_at?' · last scan '+new Date(d.last_scan_at).toLocaleString():''}${d.last_error?' · '+d.last_error:''}`;
    $('scanAycd').disabled=!j.online || !!d.pending_command;
    if(d.pending_command) $('scanAycd').textContent='Scan requested…'; else $('scanAycd').textContent='Scan AYCD now';
  }catch(e){$('aycdMessage').textContent=e.message}
}
$('pairAycd').onclick=async()=>{try{const j=await api('/orders/aycd/pair/start',{method:'POST',body:'{}'});$('aycdPairCode').textContent=j.code;$('aycdPairBox').hidden=false;$('aycdMessage').textContent='Open http://127.0.0.1:43821 on the AYCD laptop and enter this code. It expires in 10 minutes.';}catch(e){$('aycdMessage').textContent=e.message}};
$('scanAycd').onclick=async()=>{try{await api('/orders/aycd/scan-request',{method:'POST',body:JSON.stringify({lookbackDays:Number($('aycdLookback').value||240)})});$('aycdMessage').textContent='AYCD scan requested. The laptop helper will begin within a few seconds.';await refreshAycdStatus()}catch(e){$('aycdMessage').textContent=e.message}};
$('refreshAycd').onclick=refreshAycdStatus;
setInterval(()=>{if(!$('aycdPanel').hidden)refreshAycdStatus()},10000);
$('printYear').onclick=async()=>{const y=$('yearFilter').value||new Date().getFullYear();const r=await fetch(`${API}/orders/tax-export?year=${y}`,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok){alert('Annual receipt archive could not be opened');return}const html=await r.text();const w=window.open('','_blank');w.document.open();w.document.write(html);w.document.close()};
$('refreshOrders').onclick=loadOrders;$('statusFilter').onchange=loadOrders;$('yearFilter').onchange=loadOrders;$('searchOrders').oninput=render;
initYears();
runAutomaticScan().catch(async e=>{showWarning(e.message);try{await bootstrap()}catch(_){}setProgress(100,'Order tracker loaded with saved data','The automatic mailbox scan could not finish, but your existing orders are available.')}).finally(()=>{setTimeout(()=>{$('scanOverlay').hidden=true;$('trackerApp').hidden=false},350)});
