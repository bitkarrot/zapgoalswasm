(function(){
  // Find this script tag to read data-goal and detect server origin
  var scripts = document.querySelectorAll('script[src*="/zapgoalswasm/js/embed.js"]');
  var scriptTag = scripts[scripts.length - 1];
  if(!scriptTag) return;
  var goalId = scriptTag.getAttribute('data-goal');
  if(!goalId) return;
  var srcUrl = new URL(scriptTag.src);
  var ORIGIN = srcUrl.origin;
  var API = ORIGIN + '/api/v1/ext/zapgoalswasm';

  var container = document.createElement('div');
  container.className = 'zapgoals-widget-container';
  scriptTag.parentNode.insertBefore(container, scriptTag);
  var shadow = container.attachShadow({mode: 'open'});

  var goal = null, amount = null, comment = '', invoice = null;
  var invoiceSocket = null, goalSocket = null, pollTimer = null;
  var creatingInvoice = false, bcPayment = null;
  var now = Date.now();

  function api(method, path, body){
    var opts = {method: method, headers: {'Content-Type': 'application/json'}};
    if(body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function escapeHtml(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
  function formatSats(v){return Number(v||0).toLocaleString()+' sats';}
  function formatDate(v){if(!v)return '\u2014';return new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeStyle:'short'}).format(new Date(v));}
  function contrastColor(hex){hex=String(hex||'').replace('#','');if(!/^[0-9a-f]{6}$/i.test(hex))return '#111827';var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);return (r*299+g*587+b*114)/1000>=145?'#111827':'#ffffff';}

  var style = document.createElement('style');
  style.textContent = `
*{margin:0;padding:0;box-sizing:border-box}
:host{display:block}
.zg-card{max-width:500px;margin:0 auto;padding:2rem;border-radius:1.25rem;overflow:hidden;background:#fff;color:#1f2937;font-size:16px;font-weight:400;font-family:sans-serif}
.zg-title{font-size:clamp(1.5rem,6vw,2.5rem);line-height:1.1;text-align:center;margin-bottom:1rem;overflow-wrap:anywhere;font-weight:inherit}
.zg-desc{white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:1rem;font-weight:inherit}
.zg-progress{position:relative;height:3rem;overflow:hidden;border-radius:999px;display:flex;align-items:center;justify-content:center;outline:1px solid rgba(0,0,0,.15);background:#e5e7eb}
.zg-progress-fill{position:absolute;inset:0 auto 0 0;transition:width .35s ease}
.zg-percent{position:relative;z-index:1;padding:.1rem .45rem;border-radius:.35rem;background:rgba(255,255,255,.72);color:#111827;font-weight:800;font-size:1.05rem}
.zg-amounts{display:flex;justify-content:space-between;margin-top:.5rem;font-weight:inherit}
.zg-target{text-align:center;margin:1rem 0;opacity:.9;font-weight:inherit}
.zg-recurring{text-align:center;margin-bottom:1rem}
.zg-recurring-badge{display:inline-flex;align-items:center;gap:.25rem;background:#0d9488;color:#fff;padding:.35rem .65rem;border-radius:.4rem;font-size:.85rem;font-weight:600}
.zg-zap-btn{display:block;width:100%;padding:.85rem;border:none;border-radius:.75rem;font-size:1.05rem;font-weight:700;cursor:pointer;color:#fff;background:#f59e0b;transition:opacity .15s}
.zg-zap-btn:hover{opacity:.9}
.zg-loading{text-align:center;padding:3rem;color:#999}
.zg-error{text-align:center;padding:3rem;color:#e00}
.zg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;z-index:2147483647;align-items:center;justify-content:center;padding:1rem}
.zg-overlay.show{display:flex}
.zg-dialog{background:#fff;border-radius:1rem;padding:1.5rem;max-width:420px;width:100%;color:#111}
.zg-dialog-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.zg-dialog-title{font-size:1.25rem;font-weight:700}
.zg-close{background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;line-height:1}
.zg-selected{text-align:center;padding:1rem 0}
.zg-selected-value{font-size:3rem;font-weight:700;line-height:1}
.zg-sats-label{font-size:1rem;color:#666;margin-top:.25rem}
.zg-amounts-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem;margin-bottom:1rem}
.zg-amt-btn{padding:.75rem;border:1px solid #ddd;border-radius:.6rem;font-size:1rem;font-weight:600;cursor:pointer;background:#fff;color:#111;transition:background .15s}
.zg-amt-btn.active{background:#f59e0b;color:#fff;border-color:#f59e0b}
.zg-amt-btn:hover{border-color:#f59e0b}
.zg-input{width:100%;padding:.6rem;border:1px solid #ddd;border-radius:.4rem;font-size:1rem;margin-bottom:.75rem}
.zg-textarea{width:100%;padding:.6rem;border:1px solid #ddd;border-radius:.4rem;font-size:1rem;resize:vertical;margin-bottom:.75rem;min-height:60px}
.zg-submit{display:block;width:100%;padding:.8rem;border:none;border-radius:.6rem;font-size:1.05rem;font-weight:700;cursor:pointer;color:#fff;background:#f59e0b}
.zg-qr{text-align:center;margin:1rem 0}
.zg-qr img{max-width:280px;width:100%;height:auto}
.zg-invoice-box{margin-top:.5rem}
.zg-invoice-text{width:100%;font-size:.8rem;font-family:monospace;padding:.5rem;border:1px solid #ddd;border-radius:.4rem;word-break:break-all;resize:none;background:#f9f9f9;color:#333}
.zg-thankyou{text-align:center;padding:2rem 1rem}
.zg-thankyou h3{font-size:1.5rem;margin-bottom:.5rem}
.zg-thankyou p{color:#666}
.zg-copy-btn{background:none;border:none;cursor:pointer;padding:.25rem;color:inherit;opacity:.6;font-size:1rem}
.zg-copy-btn:hover{opacity:1}
`;
  shadow.appendChild(style);

  var card = document.createElement('div');
  card.className = 'zg-card';
  card.innerHTML = '<div class="zg-loading">Loading goal\u2026</div>';
  shadow.appendChild(card);

  var overlay = document.createElement('div');
  overlay.className = 'zg-overlay';
  shadow.appendChild(overlay);

  function renderGoal(){
    if(!goal) return;
    var fw = Number(goal.fontWeight)||400;
    var ff = goal.fontName||'sans-serif';
    card.style.background = goal.backgroundColor||'#fff';
    card.style.color = goal.textColor||'#1f2937';
    card.style.fontFamily = ff;
    card.style.fontWeight = fw;
    var target = Number(goal.goalAmount)||1;
    var pct = goal.percent!==undefined?Number(goal.percent):(Number(goal.currentAmount||0)/target)*100;
    var capped = Math.min(100,Math.max(0,pct));
    var pctLabel = pct.toFixed(1)+'%';
    var diff = new Date(goal.targetDate).getTime()-now;
    var countdown = '';
    if(Number(goal.currentAmount)>=Number(goal.goalAmount)){countdown='Goal reached \u2014 thank you!';}
    else if(diff<=0){countdown='Goal ended';}
    else{var d=Math.floor(diff/86400000),h=Math.floor((diff%86400000)/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    if(d)countdown=d+'d '+h+'h remaining';else if(h)countdown=h+'h '+m+'m remaining';else countdown=m+'m '+s+'s remaining';}
    var btnColor = goal.progressColor||'#f59e0b';
    var btnText = contrastColor(btnColor);
    var html = '<h1 class="zg-title" style="font-weight:'+fw+'">'+escapeHtml(goal.title)+'</h1>';
    if(goal.recurring){
      var units={day:'Daily',week:'Weekly',month:'Monthly',quarter:'Quarterly',half_year:'Semi-annual',year:'Annual'};
      var label=units[goal.recurrenceUnit]||'Recurring';
      html+='<div class="zg-recurring"><span class="zg-recurring-badge">\uD83D\uDD04 '+label+' \u2014 Period '+(Number(goal.periodIndex||0)+1)+'</span></div>';
    }
    if(goal.descriptionAbove) html+='<p class="zg-desc" style="font-weight:'+fw+'">'+escapeHtml(goal.descriptionAbove)+'</p>';
    html+='<div class="zg-progress" style="background:'+(goal.remainderColor||'#e5e7eb')+'"><div class="zg-progress-fill" style="width:'+capped+'%;background:'+(goal.progressColor||'#f59e0b')+'"></div><span class="zg-percent">'+pctLabel+'</span></div>';
    html+='<div class="zg-amounts" style="font-weight:'+fw+'"><span>Current '+formatSats(goal.currentAmount)+'</span><span>Goal '+formatSats(goal.goalAmount)+'</span></div>';
    html+='<div class="zg-target" style="font-weight:'+fw+'">\uD83D\uDCC5 <span>'+formatDate(goal.targetDate)+'</span><div style="font-weight:700;margin-top:.25rem">'+escapeHtml(countdown)+'</div></div>';
    if(goal.descriptionBelow) html+='<p class="zg-desc" style="font-weight:'+fw+'">'+escapeHtml(goal.descriptionBelow)+'</p>';
    html+='<button class="zg-zap-btn" style="background:'+btnColor+';color:'+btnText+'">\u26A1 Zap this goal</button>';
    card.innerHTML = html;
    var zapBtn = card.querySelector('.zg-zap-btn');
    if(zapBtn) zapBtn.addEventListener('click', openAmountDialog);
  }

  function getGoal(silent){
    if(!silent) card.innerHTML = '<div class="zg-loading">Loading goal\u2026</div>';
    api('GET','/goals/'+goalId+'/public').then(function(data){goal=data;renderGoal();}).catch(function(){card.innerHTML='<div class="zg-error">This goal is unavailable.</div>';});
  }

  function openAmountDialog(){
    amount=null;comment='';
    var suggested=(function(){try{return JSON.parse(goal.suggestedAmounts||'[21,100,500,1000]').slice(0,4);}catch(_){return [21,100,500,1000];}})();
    var btnColor=goal.progressColor||'#f59e0b';
    var btnText=contrastColor(btnColor);
    var html='<div class="zg-dialog-header"><div class="zg-dialog-title">Choose your zap</div><button class="zg-close">\u00d7</button></div>';
    html+='<div class="zg-selected"><div class="zg-selected-value" id="zg-sel">\u2014</div><div class="zg-sats-label">sats</div></div>';
    html+='<div class="zg-amounts-grid">';
    suggested.forEach(function(s){html+='<button class="zg-amt-btn" data-amt="'+s+'">'+formatSats(s)+'</button>';});
    html+='</div>';
    html+='<input class="zg-input" type="number" min="1" step="1" placeholder="Custom amount (sats)" id="zg-custom">';
    html+='<textarea class="zg-textarea" placeholder="Comment (optional)" id="zg-comment" maxlength="280"></textarea>';
    html+='<button class="zg-submit" style="background:'+btnColor+';color:'+btnText+'">Continue to payment</button>';
    var dlg=document.createElement('div');
    dlg.className='zg-dialog';
    dlg.innerHTML=html;
    overlay.innerHTML='';
    overlay.appendChild(dlg);
    overlay.classList.add('show');
    dlg.querySelector('.zg-close').addEventListener('click',closeDialog);
    dlg.querySelectorAll('.zg-amt-btn').forEach(function(b){b.addEventListener('click',function(){selectAmount(Number(b.getAttribute('data-amt')),dlg);});});
    var ci=dlg.querySelector('#zg-custom');
    ci.addEventListener('input',function(){amount=Number(ci.value)||null;var sel=dlg.querySelector('#zg-sel');if(sel)sel.textContent=ci.value?Number(ci.value).toLocaleString():'\u2014';dlg.querySelectorAll('.zg-amt-btn').forEach(function(b){b.classList.remove('active');});});
    var cm=dlg.querySelector('#zg-comment');
    cm.addEventListener('input',function(){comment=cm.value;});
    dlg.querySelector('.zg-submit').addEventListener('click',createInvoice);
  }

  function selectAmount(s,dlg){
    amount=s;
    var sel=dlg.querySelector('#zg-sel');
    if(sel)sel.textContent=Number(s).toLocaleString();
    dlg.querySelectorAll('.zg-amt-btn').forEach(function(b){b.classList.toggle('active',Number(b.getAttribute('data-amt'))===s);});
  }

  function createInvoice(){
    if(creatingInvoice||!amount||amount<1)return;
    creatingInvoice=true;
    overlay.classList.remove('show');
    api('POST','/goals/'+goalId+'/invoice',{amount:Number(amount),comment:(comment||'').trim()||null}).then(function(data){
      invoice=data;
      watchInvoice(data.paymentHash);
      if(goal.walletMode==='all'){
        tryBitcoinConnect(data.paymentRequest);
      } else {
        showInvoiceDialog();
      }
    }).catch(function(e){creatingInvoice=false;alert('Could not create invoice: '+e.message);});
  }

  function tryBitcoinConnect(paymentRequest){
    // Bitcoin Connect runs in first-party context here (host page),
    // so localStorage and popups work normally.
    import('https://esm.sh/@getalby/bitcoin-connect@3.12.3').then(function(bc){
      try{bc.init({appName:'ZapGoals',showBalance:false,persistConnection:true});}catch(_){}
      bcPayment=bc.launchPaymentModal({
        invoice:paymentRequest,
        paymentMethods:'all',
        onPaid:function(){paymentComplete();},
        onCancelled:function(){closeDialog();}
      });
    }).catch(function(e){
      console.warn('Bitcoin Connect failed, falling back to QR:',e);
      showInvoiceDialog();
    });
  }

  function showInvoiceDialog(){
    var html='<div class="zg-dialog-header"><div class="zg-dialog-title">Pay Lightning invoice</div><button class="zg-close">\u00d7</button></div>';
    html+='<div class="zg-qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=LIGHTNING:'+encodeURIComponent(invoice.paymentRequest.toUpperCase())+'" alt="QR code"></div>';
    html+='<div class="zg-invoice-box"><textarea class="zg-invoice-text" readonly rows="3">'+escapeHtml(invoice.paymentRequest)+'</textarea></div>';
    html+='<div style="text-align:center;margin-top:.75rem"><button class="zg-copy-btn" data-copy="invoice">\uD83D\uDCCB Copy invoice</button></div>';
    var dlg=document.createElement('div');
    dlg.className='zg-dialog';
    dlg.innerHTML=html;
    overlay.innerHTML='';
    overlay.appendChild(dlg);
    overlay.classList.add('show');
    dlg.querySelector('.zg-close').addEventListener('click',closeDialog);
    dlg.querySelector('[data-copy]').addEventListener('click',function(){copyText(invoice.paymentRequest);});
  }

  function watchInvoice(paymentHash){
    if(invoiceSocket){try{invoiceSocket.close();}catch(_){}}
    var wsUrl=(ORIGIN.indexOf('https')===0?'wss:':'ws:')+'//'+ORIGIN.replace(/^https?:\/\//,'')+'/api/v1/ws/'+paymentHash;
    try{
      invoiceSocket=new WebSocket(wsUrl);
      invoiceSocket.onmessage=function(event){try{var msg=JSON.parse(event.data);if(msg.pending===false&&['success','settled','paid'].includes(String(msg.status||'')))paymentComplete();}catch(_){}};
      invoiceSocket.onclose=function(){invoiceSocket=null;};
    }catch(_){invoiceSocket=null;}
  }

  function paymentComplete(){
    if(bcPayment&&bcPayment.setPaid){var p=bcPayment;bcPayment=null;p.setPaid({preimage:''});}
    if(invoiceSocket){try{invoiceSocket.close();}catch(_){}invoiceSocket=null;}
    invoice=null;creatingInvoice=false;
    overlay.classList.remove('show');
    var dlg=document.createElement('div');
    dlg.className='zg-dialog';
    dlg.innerHTML='<div class="zg-thankyou"><h3>Payment received</h3><p>Thank you!</p></div>';
    overlay.innerHTML='';
    overlay.appendChild(dlg);
    overlay.classList.add('show');
    setTimeout(function(){overlay.classList.remove('show');},3000);
    getGoal(true);
  }

  function closeDialog(){
    overlay.classList.remove('show');
    if(invoiceSocket){try{invoiceSocket.close();}catch(_){}invoiceSocket=null;}
    creatingInvoice=false;bcPayment=null;
  }

  function copyText(text){try{navigator.clipboard.writeText(text);}catch(_){}}

  function connectGoalSocket(){
    if(goalSocket){try{goalSocket.close();}catch(_){}}
    var wsUrl=(ORIGIN.indexOf('https')===0?'wss:':'ws:')+'//'+ORIGIN.replace(/^https?:\/\//,'')+'/api/v1/ws/'+goalId;
    try{
      goalSocket=new WebSocket(wsUrl);
      goalSocket.onmessage=function(){getGoal(true);};
      goalSocket.onclose=function(){goalSocket=null;setTimeout(connectGoalSocket,3000);};
    }catch(_){goalSocket=null;}
  }

  setInterval(function(){now=Date.now();if(goal)renderGoal();},1000);
  pollTimer=setInterval(function(){if(!creatingInvoice)getGoal(true);},15000);

  getGoal();
  connectGoalSocket();
})();
