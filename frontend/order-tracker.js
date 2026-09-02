const API=location.hostname==='localhost'||location.hostname==='127.0.0.1'?'http://localhost:3000':'https://profile-platform.onrender.com';
const token=localStorage.getItem('token');
if(!token) location.href='login.html';
const headers={'Authorization':`Bearer ${token}`,'Content-Type':'application/json'};
let allOrders=[];
const $=id=>document.getElementById(id);
function logout(){localStorage.removeItem('token');location.href='login.html'}
function money(n){return `$${Number(n||0).toFixed(2)}`}
function orderHeadlineValue(o){const s=String(o.status||'').toLowerCase();if(s==='canceled')return 'Canceled';if(s==='refunded')return 'Refunded';return money(o.total)}
function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function initYears(){const s=$('yearFilter'),y=new Date().getFullYear();s.innerHTML='<option value="">All years</option>';for(let i=y;i>=y-7;i--)s.innerHTML+=`<option value="${i}">${i}</option>`}
async function api(path,opt={}){const r=await fetch(API+path,{...opt,headers:{...headers,...(opt.headers||{})}});if(r.status===401){logout();return}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`Request failed (${r.status})`);return j}
function setProgress(percent,stage,detail=''){const p=Math.max(0,Math.min(100,Number(percent)||0));$('scanProgressBar').style.width=`${p}%`;$('scanPercent').textContent=`${Math.round(p)}%`;if(stage)$('scanStage').textContent=stage;if(detail)$('scanDetail').textContent=detail}
function showWarning(text){$('scanWarning').hidden=!text;$('scanWarning').textContent=text||''}
function renderAccounts(accounts=[]){const el=$('scanAccounts');el.innerHTML=accounts.length?accounts.map(a=>`<div class="mail-account"><div class="mail-ok">✓ ${esc(a.email)}</div><div>${esc(a.provider||'IMAP')} · ${a.last_success_at?'Last scan '+new Date(a.last_success_at).toLocaleString():'Ready for first scan'}</div>${a.scanned_through_at?`<div class="subtle-text">Scanned through ${new Date(a.scanned_through_at).toLocaleString()}</div>`:''}${a.last_error?`<div class="mail-error">${esc(a.last_error)}</div>`:''}</div>`).join(''):'<p class="subtle-text">No supported IMAP/app password was found in saved profiles.</p>'}
function applyOrders(orders=[],summary={}){allOrders=orders;render();$('countAll').textContent=allOrders.length;$('countActive').textContent=(summary.confirmed||0)+(summary.processing||0);$('countSuccess').textContent=(summary.shipped||0)+(summary.delivered||0);$('countCanceled').textContent=(summary.canceled||0)+(summary.refunded||0);$('successRate').textContent=`${Number(summary.success_rate||0).toFixed(1)}%`}
async function bootstrap(){const j=await api('/orders/bootstrap');renderAccounts(j.accounts||[]);applyOrders(j.orders||[],j.summary||{});$('scanMessage').textContent=`${j.connected_count||0} connected mailbox${Number(j.connected_count||0)===1?'':'es'}. Scans continue from the last saved IMAP UID, so previously checked messages are not searched again.`;if(Array.isArray(j.warnings)&&j.warnings.length)showWarning(`Some optional data could not be refreshed: ${j.warnings.join(' | ')}`);if(j.is_super_admin){$('aycdPanel').hidden=false;refreshAycdStatus()}return j}
async function loadOrders(){const qs=new URLSearchParams();if($('statusFilter').value)qs.set('status',$('statusFilter').value);if($('yearFilter').value)qs.set('year',$('yearFilter').value);const j=await api('/orders/tracked?'+qs);applyOrders(j.orders||[],j.summary||{})}
function isPokemonCenterOrder(o){const store=String(o.store||'').toLowerCase().replace(/[^a-z0-9]/g,'');return store==='pokemon'||store==='pokemoncenter'}
function hasPokemonConfirmationEmail(o){const c=o.email_counts||{};return Number(c.confirmed||0)>0||Boolean(o.receipt_html||o.receipt_text)}
function displayOrderStatus(o){const s=String(o.status||'waiting_confirmation').toLowerCase();if(isPokemonCenterOrder(o)&&['confirmed','processing','waiting_confirmation'].includes(s)&&!hasPokemonConfirmationEmail(o))return 'waiting_confirmation';return s}
function statusCardClass(o){const s=displayOrderStatus(o);if(s==='canceled'||s==='refunded')return 'order-canceled';if(s==='delivered')return 'order-delivered';if(s==='shipped')return 'order-shipped';if(s==='confirmed'||s==='processing')return 'order-confirmed';return 'order-waiting'}
function emailButtons(o){const c=o.email_counts||{};const buttons=[];if(Number(c.confirmed||0)>0||o.receipt_html||o.receipt_text)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','confirmed')">View confirmed receipt</button>`);if(Number(c.shipped||0)>0)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','shipped')">View tracking confirmation</button>`);if(Number(c.delivered||0)>0)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','delivered')">View delivered confirmation</button>`);if(Number(c.canceled||0)>0)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','canceled')">View cancellation</button>`);else if(Number(c.refunded||0)>0)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','refunded')">View refund confirmation</button>`);if(Number(c.total||0)>0)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','all')">View all order emails (${Number(c.total||0)})</button>`);if(!buttons.length)buttons.push(`<button class="btn" onclick="openOrderEmails('${o.id}','all')">Find order emails</button>`);return buttons.join('')}

function renderItems(o){
  const items=Array.isArray(o.items)?o.items:[]; if(!items.length)return '';
  return `<div class="order-items">${items.map(i=>`<div class="order-item-row"><div><b>${esc(i.product_name||'Item')}</b>${i.size?`<small>Size: ${esc(i.size)}</small>`:''}${i.style?`<small>Style: ${esc(i.style)}</small>`:''}<small>Qty: ${esc(i.quantity||1)}${i.price!=null?` · Price: ${money(i.price)}`:''}</small></div><span class="item-role ${i.role==='main'?'item-main':i.role==='filler'?'item-filler':''}">${esc(i.role||'item')}</span><span class="item-status">${esc(i.status||'confirmed')}</span></div>`).join('')}</div>`
}
function renderShipments(o){
  const ships=Array.isArray(o.shipments)?o.shipments:[]; if(!ships.length)return '';
  return `<div class="shipments">${ships.map(s=>`<div class="shipment-row"><b>${esc(s.status||'shipped')}</b> · ${esc(s.carrier||'carrier')} · ${esc(s.tracking_number||'')}${s.tracking_url?` · <a class="tracking-link" href="${esc(s.tracking_url)}" target="_blank" rel="noopener">Track package</a>`:''}</div>`).join('')}</div>`
}
function renderReconciliation(o){
  if(!o.reconciliation_status&&!o.reconciliation_note)return '';
  const label=o.reconciliation_status==='main_item_missing'?'Main item missing':o.reconciliation_status==='matched'?'Item-level matched':o.reconciliation_status==='probable'?'Probable email match':o.reconciliation_status;
  return `<div class="item-level-note"><b>${esc(label||'Reconciliation')}</b>${o.reconciliation_score!=null?` · score ${Number(o.reconciliation_score).toFixed(1)}`:''}${o.reconciliation_note?`<br>${esc(o.reconciliation_note)}`:''}</div>`
}
function render(){const q=$('searchOrders').value.toLowerCase();const selectedStatus=$('statusFilter').value;const selectedYear=$('yearFilter').value;const rows=allOrders.filter(o=>{const shownStatus=displayOrderStatus(o);const matchesSearch=`${o.store} ${o.order_number} ${o.product_summary} ${o.source_email||''} ${(o.items||[]).map(i=>i.product_name).join(' ')}`.toLowerCase().includes(q);const matchesStatus=!selectedStatus||shownStatus===selectedStatus;const matchesYear=!selectedYear||String(new Date(o.order_date||0).getFullYear())===selectedYear;return matchesSearch&&matchesStatus&&matchesYear});$('ordersList').innerHTML=rows.length?rows.map(o=>{const shownStatus=displayOrderStatus(o);const missingPokemonConfirmation=isPokemonCenterOrder(o)&&['waiting_confirmation','confirmed','processing'].includes(String(o.status||'').toLowerCase())&&!hasPokemonConfirmationEmail(o);return `<article class="order-card ${statusCardClass(o)}"><div class="order-head"><div><span class="status-pill status-${esc(shownStatus)}">${esc(shownStatus)}</span>${missingPokemonConfirmation?'<span class="email-missing-pill">No confirmation email linked</span>':(!o.has_linked_email&&!['shipped','delivered'].includes(String(o.status||''))?'<span class="email-missing-pill">No retailer email linked</span>':'')}<h3>${esc(o.store).toUpperCase()} · ${esc(o.order_number)}</h3><p>${esc(o.product_summary||'Product details will improve as receipt emails are parsed.')}</p><p class="order-email"><b>Purchase email:</b> ${esc(o.source_email||'Not linked yet')}</p></div><strong>${esc(orderHeadlineValue(o))}</strong></div>${renderReconciliation(o)}${renderItems(o)}${renderShipments(o)}<div class="order-meta"><div><small>Order date</small><br><b>${o.order_date?new Date(o.order_date).toLocaleDateString():'—'}</b></div><div><small>Tracking</small><br><b>${esc((o.shipments||[]).length?`${o.shipments.length} package${o.shipments.length===1?'':'s'}`:(o.tracking_number||'—'))}</b>${!((o.shipments||[]).length)&&o.tracking_url?`<br><a class="tracking-link" href="${esc(o.tracking_url)}" target="_blank" rel="noopener">Track package</a>`:''}</div><div><small>${(['canceled','refunded'].includes(String(o.status||'').toLowerCase())&&o.credits_refunded)?'Credits refunded':'Credits spent'}</small><br><b>${(['canceled','refunded'].includes(String(o.status||'').toLowerCase())&&o.credits_refunded)?`Refunded ${money(o.credits_spent)}`:money(o.credits_spent)}</b></div><div><small>Last update</small><br><b>${o.last_status_at?new Date(o.last_status_at).toLocaleString():'—'}</b></div></div><div class="order-actions">${emailButtons(o)}${String(o.status||'').toLowerCase()==='shipped'?`<button class="btn" onclick="markDelivered('${o.id}')">Mark as delivered</button>`:''}<button class="btn" onclick="editOrder('${o.id}')">Edit</button><button class="btn btn-danger" onclick="deleteOrder('${o.id}')">Delete</button></div></article>`}).join(''):'<section class="tracker-panel"><p>No tracked orders match this view yet.</p></section>'}
async function openOrderEmails(id,type='all'){const r=await fetch(`${API}/orders/emails/${id}?type=${encodeURIComponent(type)}`,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok){alert('Order emails could not be opened');return}const html=await r.text();const w=window.open('','_blank');w.document.open();w.document.write(html);w.document.close()}
async function openReceipt(id){return openOrderEmails(id,'confirmed')}
async function editOrder(id){const o=allOrders.find(x=>x.id===id);const status=prompt('Status: waiting_confirmation, confirmed, processing, shipped, delivered, canceled, refunded',o.status);if(!status)return;const credits=prompt('Credits spent for this order',o.credits_spent||0);await api('/orders/tracked/'+id,{method:'PATCH',body:JSON.stringify({status,credits_spent:Number(credits||0)})});loadOrders()}
async function markDelivered(id){
  const o=allOrders.find(x=>x.id===id);
  if(!o||String(o.status||'').toLowerCase()!=='shipped')return;
  if(!confirm('Mark this shipped order as delivered? This will also mark all known packages for the order as delivered.'))return;
  try{
    await api('/orders/tracked/'+id+'/mark-delivered',{method:'POST',body:'{}'});
    await loadOrders();
  }catch(e){alert(e.message||'Could not mark this order delivered')}
}
async function deleteOrder(id){if(!confirm('Delete this tracked order and its stored receipt?'))return;await api('/orders/tracked/'+id,{method:'DELETE'});loadOrders()}
async function runAutomaticScan(){
  // Order Tracker is now a fast read-only view. Render scans mailboxes in the background and
  // checkout webhooks trigger priority scans, so opening this page must not wait on IMAP.
  setProgress(35,'Loading saved orders…','Reading the latest tracked order records. No mailbox scan is required to open this page.');
  const first=await bootstrap();
  const mins=Math.max(1,Math.round(Number(first.scan_interval_ms||300000)/60000));
  $('scanMessage').textContent=`Order Tracker loads from saved records. Render scans connected mailboxes in the background about every ${mins} minute${mins===1?'':'s'}, and new checkout webhooks are prioritized automatically.`;
  setProgress(100,'Order tracker ready','Saved orders loaded. Email scanning continues on Render in the background.');
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

function showReconcileDiagnostics(text){
  const modal=$('reconcileDiagModal'), log=$('reconcileDiagLog');
  if(!modal||!log){alert(text);return}
  log.textContent=String(text||'');
  modal.hidden=false;
  log.scrollTop=0;
}
if($('closeReconcileDiag')) $('closeReconcileDiag').onclick=()=>{$('reconcileDiagModal').hidden=true};
if($('reconcileDiagModal')) $('reconcileDiagModal').onclick=e=>{if(e.target===$('reconcileDiagModal')) $('reconcileDiagModal').hidden=true};
if($('copyReconcileDiag')) $('copyReconcileDiag').onclick=async()=>{const text=$('reconcileDiagLog')?.textContent||'';try{await navigator.clipboard.writeText(text);$('copyReconcileDiag').textContent='Copied';setTimeout(()=>{$('copyReconcileDiag').textContent='Copy complete log'},1500)}catch(_){alert('Could not copy the log automatically. Select the text in the log and copy it manually.')}};
if($('downloadReconcileDiag')) $('downloadReconcileDiag').onclick=()=>{const text=$('reconcileDiagLog')?.textContent||'';const blob=new Blob([text],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`retailer-reconcile-${new Date().toISOString().replace(/[:.]/g,'-')}.log.txt`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)};

if($('checkTracking')) $('checkTracking').onclick=async()=>{const b=$('checkTracking');const old=b.textContent;b.disabled=true;b.textContent='Checking tracking…';try{const j=await api('/orders/check-tracking',{method:'POST',body:'{}'});alert(j.disabled?'Tracking verification is not enabled yet. Add EASYPOST_API_KEY to Render, then this button and the automatic background checker will work.':`Tracking check complete. Checked ${j.checked||0} package(s); ${j.delivered_shipments||0} package(s) delivered; ${j.delivered_orders||0} order(s) marked delivered.`);await loadOrders()}catch(e){alert(e.message||'Tracking check failed')}finally{b.disabled=false;b.textContent=old}};

$('reconcileRetailer').onclick=async()=>{const b=$('reconcileRetailer');const old=b.textContent;b.disabled=true;b.textContent='Reconciling…';try{let j=await api('/orders/reconcile-retailer-emails',{method:'POST',body:JSON.stringify({max_messages:2500,repair_orders:250})});if(j?.job){const started=Date.now();while(true){await new Promise(resolve=>setTimeout(resolve,2500));const status=await api('/orders/reconcile-retailer-emails/status');const job=status?.job||{};if(job.status==='complete'){j=job.result||{};break}if(job.status==='error')throw new Error(job.error||'Retailer reconciliation failed');if(job.status==='idle')throw new Error('Retailer reconciliation job was lost after the server restarted. Please run it again.');if(Date.now()-started>45*60*1000)throw new Error('Retailer reconciliation is still running after 45 minutes. Refresh the page and try again later.')}}const r=j.repair||{};const details=Array.isArray(r.details)?r.details:[];const priority=details.filter(x=>x.result!=='mailbox_not_connected');const detailText=priority.length?`

Live repair details:
${priority.map(x=>{const itemBits=[];if(x.main_item_status)itemBits.push(`main=${x.main_item_status}`);if(x.filler_item_status)itemBits.push(`filler=${x.filler_item_status}`);if(x.final_order_status)itemBits.push(`final=${x.final_order_status}`);return `${x.store||'retailer'} ${x.order_number||'-'} · ${x.mailbox||'-'} · found ${x.messages_found||0}, processed ${x.messages_processed||0}, saved ${x.saved_messages||0} · ${x.result||'-'}${itemBits.length?` · ${itemBits.join(', ')}`:''}`}).join('\n')}`:'';const missing=details.filter(x=>x.result==='mailbox_not_connected');const missingText=missing.length?`

Mailbox not connected (${missing.length}):
${missing.map(x=>`${x.order_number||'-'} · ${x.mailbox||'-'}`).join('\n')}`:'';showReconcileDiagnostics(`${j.message}
Archive matched: ${j.matched}
Archive ignored: ${j.ignored}
Failed: ${j.failed}
Supreme user-owned mailboxes selected: ${j.supreme_live?.profile_mailboxes||0}
Supreme mailboxes checked live: ${j.supreme_live?.mailboxes_checked||0}
Supreme live messages found: ${j.supreme_live?.messages_found||0}
Supreme live messages saved: ${j.supreme_live?.messages_saved||0}
Supreme live mailbox failures: ${j.supreme_live?.failures||0}
Supreme metadata scanned: ${j.supreme_discovery?.metadata_scanned||0}
Pokemon Center archive messages replayed: ${j.pokemon_archive_messages||0}
Pokemon Center rows classified: ${j.pokemon_stats?.classified_rows||0}
Pokemon Center rows with P-order number: ${j.pokemon_stats?.with_order_number||0}
Pokemon Center confirmations detected: ${j.pokemon_stats?.confirmations||0}
Pokemon Center shipped detected: ${j.pokemon_stats?.shipped||0}
Pokemon Center delivered detected: ${j.pokemon_stats?.delivered||0}
Pokemon Center rows saved/linked: ${j.pokemon_stats?.saved||0}
Pokemon Center rows ignored: ${j.pokemon_stats?.ignored||0}
Pokemon Center not-platform-order: ${j.pokemon_stats?.not_platform_order||0}
Pokemon Center missing order number: ${j.pokemon_stats?.no_order_number||0}
Pokemon Center errors: ${j.pokemon_stats?.errors||0}
Supreme emails discovered: ${j.supreme_discovery?.candidates_found||0}
Supreme confirmations parsed: ${j.supreme_rebuild?.confirmations||0}
Supreme order numbers parsed: ${j.supreme_rebuild?.parsed_order_numbers||0}
Supreme webhook orders: ${j.supreme_rebuild?.supreme_webhook_orders||0}
Supreme candidate pairs: ${j.supreme_rebuild?.candidate_pairs||0}
Supreme assignments rebuilt: ${j.supreme_rebuild?.assigned||0}
Unresolved Target orders prioritized: ${j.damaged_target_orders||0}
Live mailbox orders checked: ${r.checked_orders||0}
Live MIME messages matched: ${r.matched_messages||0}
Orders repaired: ${r.repaired_orders||0}
Mailbox failures: ${r.mailbox_failures||0}

========== COMPLETE POKEMON CENTER DIAGNOSTIC LOG ==========
${(j.pokemon_debug||[]).join('\n') || 'No Pokemon Center diagnostic lines returned.'}
========== END POKEMON CENTER DIAGNOSTIC LOG ==========

========== COMPLETE SUPREME DIAGNOSTIC LOG ==========
${(j.supreme_debug||[]).join('\n') || 'No Supreme diagnostic lines returned.'}
========== END SUPREME DIAGNOSTIC LOG ==========
${r.concurrent_with_background_repair?`\nManual repair ran alongside an existing background repair.`:''}${r.skipped?`
Repair skipped: ${r.reason||'no candidates'}`:''}${detailText}${missingText}`);await loadOrders()}catch(e){alert(e.message)}finally{b.disabled=false;b.textContent=old}};
$('refreshOrders').onclick=loadOrders;$('statusFilter').onchange=()=>{render();loadOrders().catch(e=>showWarning(e.message));};$('yearFilter').onchange=()=>{render();loadOrders().catch(e=>showWarning(e.message));};$('searchOrders').oninput=render;
initYears();
runAutomaticScan().catch(async e=>{showWarning(e.message);try{await bootstrap()}catch(_){}setProgress(100,'Order tracker loaded with saved data','The automatic mailbox scan could not finish, but your existing orders are available.')}).finally(()=>{setTimeout(()=>{$('scanOverlay').hidden=true;$('trackerApp').hidden=false},350)});
