(function(){
  // Try to get goal ID from URL path first (works for direct iframe embedding)
  var match = window.location.pathname.match(/\/zapgoalswasm\/public\/([^/]+)\/embed/);
  var GOAL_ID = match ? match[1] : '';
  var ORIGIN = window.location.origin;
  var API = ORIGIN + '/api/v1/ext/zapgoalswasm';
  var card = document.getElementById('zapgoals-card');
  var overlay = document.getElementById('zg-overlay');
  var dialog = document.getElementById('zg-dialog');
  var goal = null, amount = null, comment = '', invoice = null;
  var invoiceSocket = null, goalSocket = null, pollTimer = null;
  var creatingInvoice = false, bcPayment = null;
  var now = Date.now();
  var bridgeSubscriptionId = null, bridgeEventListener = null;

  // Use LNbitsBridge when available (inside the LNbits extension iframe, CSP blocks direct fetch).
  // Fall back to direct fetch/WebSocket when bridge is not available (external iframe embedding).
  function api(method, path, body){
    if (typeof window.LNbitsBridge !== 'undefined' && window.LNbitsBridge.callApi) {
      return window.LNbitsBridge.callApi(method, API + path, body).then(function(result){
        if (result && result.error) throw new Error(result.error);
        return result;
      });
    }
    var opts = {method:method, headers:{'Content-Type':'application/json'}};
    if(body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function escapeHtml(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
  function formatSats(v){return Number(v||0).toLocaleString()+' sats';}
  function formatDate(v){if(!v)return '—';return new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeStyle:'short'}).format(new Date(v));}
  function contrastColor(hex){hex=String(hex||'').replace('#','');if(!/^[0-9a-f]{6}$/i.test(hex))return '#111827';var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);return (r*299+g*587+b*114)/1000>=145?'#111827':'#ffffff';}

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
    if(Number(goal.currentAmount)>=Number(goal.goalAmount)){countdown='Goal reached — thank you!';}
    else if(diff<=0){countdown='Goal ended';}
    else{var d=Math.floor(diff/86400000),h=Math.floor((diff%86400000)/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    if(d)countdown=d+'d '+h+'h remaining';else if(h)countdown=h+'h '+m+'m remaining';else countdown=m+'m '+s+'s remaining';}
    var btnColor = goal.progressColor||'#f59e0b';
    var btnText = contrastColor(btnColor);
    // Use CSS custom properties for dynamic colors (avoids CSP inline style blocks)
    card.style.setProperty('--zg-progress-bg', goal.remainderColor||'#e5e7eb');
    card.style.setProperty('--zg-progress-fill', goal.progressColor||'#f59e0b');
    card.style.setProperty('--zg-btn-bg', btnColor);
    card.style.setProperty('--zg-btn-text', btnText);
    card.style.setProperty('--zg-progress-width', capped+'%');
    var html = '<h1 class="zg-title">'+escapeHtml(goal.title)+'</h1>';
    if(goal.recurring){
      var units={day:'Daily',week:'Weekly',month:'Monthly',quarter:'Quarterly',half_year:'Semi-annual',year:'Annual'};
      var label=units[goal.recurrenceUnit]||'Recurring';
      html+='<div class="zg-recurring"><span class="zg-recurring-badge">🔄 '+(label)+' — Period '+(Number(goal.periodIndex||0)+1)+'</span></div>';
    }
    if(goal.descriptionAbove) html+='<p class="zg-desc">'+escapeHtml(goal.descriptionAbove)+'</p>';
    html+='<div class="zg-progress"><div class="zg-progress-fill"></div><span class="zg-percent">'+pctLabel+'</span></div>';
    html+='<div class="zg-amounts"><span>Current '+formatSats(goal.currentAmount)+'</span><span>Goal '+formatSats(goal.goalAmount)+'</span></div>';
    html+='<div class="zg-target">📅 <span>'+formatDate(goal.targetDate)+'</span><div class="zg-countdown">'+escapeHtml(countdown)+'</div></div>';
    if(goal.descriptionBelow) html+='<p class="zg-desc">'+escapeHtml(goal.descriptionBelow)+'</p>';
    html+='<button class="zg-zap-btn" id="zg-zap-btn">⚡ Zap this goal</button>';
    card.innerHTML = html;
    var zb=card.querySelector('#zg-zap-btn');
    if(zb) zb.addEventListener('click', openAmountDialog);
    sendHeight();
  }

  function sendHeight(){var h=document.documentElement.scrollHeight;window.parent.postMessage({type:'zapgoals-embed-height',height:h},'*');}

  function getGoal(silent){
    if(!silent) card.innerHTML='<div class="zg-loading">Loading goal…</div>';
    api('GET','/goals/'+GOAL_ID+'/public').then(function(data){goal=data;renderGoal();}).catch(function(){card.innerHTML='<div class="zg-error">This goal is unavailable.</div>';sendHeight();});
  }

  function openAmountDialog(){
    amount=null;comment='';
    var suggested=(function(){try{return JSON.parse(goal.suggestedAmounts||'[21,100,500,1000]').slice(0,4);}catch(_){return [21,100,500,1000];}})();
    var btnColor=goal.progressColor||'#f59e0b';
    var btnText=contrastColor(btnColor);
    var html='<div class="zg-dialog-header"><div class="zg-dialog-title">Choose your zap</div><button class="zg-close" id="zg-close">×</button></div>';
    html+='<div class="zg-selected"><div class="zg-selected-value" id="zg-sel">—</div><div class="zg-sats-label">sats</div></div>';
    html+='<div class="zg-amounts-grid">';
    suggested.forEach(function(s){html+='<button class="zg-amt-btn" data-amt="'+s+'">'+formatSats(s)+'</button>';});
    html+='</div>';
    html+='<input class="zg-input" type="number" min="1" step="1" placeholder="Custom amount (sats)" id="zg-custom">';
    html+='<textarea class="zg-textarea" placeholder="Comment (optional)" id="zg-comment" maxlength="280"></textarea>';
    html+='<button class="zg-submit" id="zg-submit">Continue to payment</button>';
    dialog.innerHTML=html;
    overlay.classList.add('show');
    dialog.querySelector('#zg-close').addEventListener('click',closeDialog);
    dialog.querySelectorAll('.zg-amt-btn').forEach(function(b){b.addEventListener('click',function(){selectAmount(Number(b.getAttribute('data-amt')));});});
    var ci=dialog.querySelector('#zg-custom');
    ci.addEventListener('input',function(){amount=Number(ci.value)||null;var sel=dialog.querySelector('#zg-sel');if(sel)sel.textContent=ci.value?Number(ci.value).toLocaleString():'—';dialog.querySelectorAll('.zg-amt-btn').forEach(function(b){b.classList.remove('active');});});
    var cm=dialog.querySelector('#zg-comment');
    cm.addEventListener('input',function(){comment=cm.value;});
    dialog.querySelector('#zg-submit').addEventListener('click',createInvoice);
  }

  function selectAmount(s){
    amount=s;
    var sel=dialog.querySelector('#zg-sel');
    if(sel)sel.textContent=Number(s).toLocaleString();
    dialog.querySelectorAll('.zg-amt-btn').forEach(function(b){b.classList.toggle('active',Number(b.getAttribute('data-amt'))===s);});
  }

  function createInvoice(){
    if(creatingInvoice||!amount||amount<1)return;
    creatingInvoice=true;
    overlay.classList.remove('show');
    api('POST','/goals/'+GOAL_ID+'/invoice',{amount:Number(amount),comment:(comment||'').trim()||null}).then(function(data){
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
    try{
      var bc=window.ZapGoalsBitcoinConnect;
      if(!bc||!bc.launchPaymentModal){showInvoiceDialog();return;}
      try{bc.init({appName:'ZapGoals',showBalance:false,persistConnection:true});}catch(_){}
      bcPayment=bc.launchPaymentModal({
        invoice:paymentRequest,
        paymentMethods:'all',
        onPaid:function(){paymentComplete();},
        onCancelled:function(){closeDialog();}
      });
    }catch(e){
      console.warn('Bitcoin Connect failed in iframe, falling back to QR:',e);
      showInvoiceDialog();
    }
  }

  function showInvoiceDialog(){
    var html='<div class="zg-dialog-header"><div class="zg-dialog-title">Pay Lightning invoice</div><button class="zg-close" id="zg-close2">×</button></div>';
    html+='<div class="zg-qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=LIGHTNING:'+encodeURIComponent(invoice.paymentRequest.toUpperCase())+'" alt="QR code"></div>';
    html+='<div class="zg-invoice-box"><textarea class="zg-invoice-text" readonly rows="3">'+escapeHtml(invoice.paymentRequest)+'</textarea></div>';
    html+='<div class="zg-copy-row"><button class="zg-copy-btn" id="zg-copy-inv">📋 Copy invoice</button></div>';
    if(goal.walletMode==='all'){
      html+='<div class="zg-open-full"><a href="'+ORIGIN+'/ext/zapgoalswasm/public/'+GOAL_ID+'" target="_blank" rel="noopener">Open full page</a></div>';
    }
    dialog.innerHTML=html;
    overlay.classList.add('show');
    dialog.querySelector('#zg-close2').addEventListener('click',closeDialog);
    dialog.querySelector('#zg-copy-inv').addEventListener('click',function(){copyText(invoice.paymentRequest);});
  }

  function watchInvoice(paymentHash){
    // Use LNbitsBridge for payment subscription when available (inside LNbits iframe)
    if (typeof window.LNbitsBridge !== 'undefined' && window.LNbitsBridge.subscribePayment) {
      bridgeSubscriptionId = 'zg-embed-' + (paymentHash||'').slice(0,12);
      window.LNbitsBridge.subscribePayment(paymentHash, bridgeSubscriptionId).catch(function(){});
      return;
    }
    // Fall back to WebSocket for external embedding
    if(invoiceSocket){try{invoiceSocket.close();}catch(_){}}
    var wsUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/v1/ws/'+paymentHash;
    try{
      invoiceSocket=new WebSocket(wsUrl);
      invoiceSocket.onmessage=function(event){try{var msg=JSON.parse(event.data);if(msg.pending===false&&['success','settled','paid'].includes(String(msg.status||'')))paymentComplete();}catch(_){}};
      invoiceSocket.onclose=function(){invoiceSocket=null;};
    }catch(_){invoiceSocket=null;}
  }

  function onBridgeEvent(message){
    if (!bridgeSubscriptionId) return;
    if (!['payment.update','payment.settled'].includes(message.event)) return;
    if (message.subscriptionId !== bridgeSubscriptionId) return;
    var payment = message.data || {};
    if (message.event === 'payment.settled' || (payment.pending === false && ['success','settled','paid'].includes(String(payment.status||'')))) {
      paymentComplete();
    }
  }

  function paymentComplete(){
    if(bcPayment&&bcPayment.setPaid){var p=bcPayment;bcPayment=null;p.setPaid({preimage:''});}
    if(invoiceSocket){try{invoiceSocket.close();}catch(_){}invoiceSocket=null;}
    bridgeSubscriptionId=null;
    invoice=null;creatingInvoice=false;
    overlay.classList.remove('show');
    dialog.innerHTML='<div class="zg-thankyou"><h3>Payment received</h3><p>Thank you!</p></div>';
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
    // Use polling via bridge when available (CSP blocks WebSocket in LNbits iframe)
    if (typeof window.LNbitsBridge !== 'undefined') return;
    if(goalSocket){try{goalSocket.close();}catch(_){}}
    var wsUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/v1/ws/'+GOAL_ID;
    try{
      goalSocket=new WebSocket(wsUrl);
      goalSocket.onmessage=function(){getGoal(true);};
      goalSocket.onclose=function(){goalSocket=null;setTimeout(connectGoalSocket,3000);};
    }catch(_){goalSocket=null;}
  }

  function start() {
    if (!GOAL_ID) {
      card.innerHTML = '<div class="zg-error">Goal ID not found.</div>';
      return;
    }
    // Set up bridge event listener for payment notifications
    if (typeof window.LNbitsBridge !== 'undefined' && window.LNbitsBridge.onEvent) {
      bridgeEventListener = window.LNbitsBridge.onEvent(onBridgeEvent);
    }
    setInterval(function(){now=Date.now();if(goal)renderGoal();},1000);
    pollTimer=setInterval(function(){if(!creatingInvoice)getGoal(true);},15000);
    getGoal();
    connectGoalSocket();
    window.addEventListener('resize',sendHeight);
    window.addEventListener('load',sendHeight);
  }

  // When served inside the LNbits extension iframe, the URL won't contain
  // the goal ID. Use LNbitsBridge to get route params if available.
  function init() {
    if (typeof window.LNbitsBridge !== 'undefined' && window.LNbitsBridge.connect) {
      window.LNbitsBridge.connect().then(function(context) {
        if (context && context.routeParams && context.routeParams.goalId) {
          GOAL_ID = context.routeParams.goalId;
        }
        start();
      }).catch(function() { start(); });
    } else {
      start();
    }
  }

  init();
})();
