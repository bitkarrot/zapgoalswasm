(function () {
  'use strict';
  // Capture synchronously: async tags may all exist before any one executes.
  var scriptTag = document.currentScript;
  if (!scriptTag || !scriptTag.parentNode) return;
  var goalId = scriptTag.getAttribute('data-goal');
  if (!goalId || !/^[a-zA-Z0-9_-]{1,128}$/.test(goalId)) return;
  var srcUrl;
  try { srcUrl = new URL(scriptTag.src, document.baseURI); } catch (_) { return; }
  if (!/^https?:$/.test(srcUrl.protocol)) return;
  var ORIGIN = srcUrl.origin;
  var API = ORIGIN + '/api/v1/ext/zapgoalswasm';
  var QR_URL = new URL('qr.js', srcUrl).href;
  var MAX_SATS = 2100000000;
  var disposed = false, suspended = false, goal = null, goalRequest = null, current = null, sequence = 0;
  var goalSocket = null, goalRetry = null, goalWatchdog = null, goalRetries = 0;
  var tickTimer = null, pollTimer = null, amountForm = null;
  var fonts = ['sans-serif', 'system-ui, sans-serif', 'Arial, sans-serif', '"Trebuchet MS", sans-serif', 'Verdana, sans-serif', 'Tahoma, sans-serif', 'serif', 'Georgia, serif', '"Times New Roman", serif', 'monospace', '"Courier New", monospace'];

  function element(tag, cls, text, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }
  function button(cls, text, parent, click) {
    var node = element('button', cls, text, parent);
    node.type = 'button';
    if (click) node.addEventListener('click', click);
    return node;
  }
  function replaceContents(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function validAmount(value) { return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SATS; }
  function numeric(value) { var n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function color(value, fallback) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; }
  function formatSats(value) { return numeric(value).toLocaleString() + ' sats'; }
  function contrastColor(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 145 ? '#111827' : '#ffffff';
  }
  function brand(node) {
    node.style.backgroundColor = color(goal && goal.progressColor, '#f59e0b');
    node.style.color = contrastColor(color(goal && goal.progressColor, '#f59e0b'));
  }
  function isOpen() {
    if (!goal || goal.archived === true || goal.disabled === true || goal.enabled === false || ['disabled', 'ended', 'closed', 'archived'].includes(goal.status)) return false;
    var end = Date.parse(goal.targetDate);
    return Number.isFinite(end) && end > Date.now();
  }
  function api(method, path, body, signal) {
    var opts = {method: method, credentials: 'omit', headers: {'Content-Type': 'application/json'}};
    if (signal) opts.signal = signal;
    if (body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  var container = element('div', 'zapgoals-widget-container');
  container.setAttribute('data-goal', goalId);
  scriptTag.parentNode.insertBefore(container, scriptTag);
  var shadow = container.attachShadow({mode: 'open'});
  element('style', '', `
*{margin:0;padding:0;box-sizing:border-box}
:host{display:block}
button,input,textarea{font:inherit}button:disabled{opacity:.5;cursor:not-allowed}
.zg-card{max-width:500px;margin:0 auto;padding:2rem;border-radius:1.25rem;overflow:hidden;background:#fff;color:#1f2937;font:16px sans-serif}
.zg-title{font-size:clamp(1.5rem,6vw,2.5rem);line-height:1.1;text-align:center;margin-bottom:1rem;overflow-wrap:anywhere;font-weight:inherit}
.zg-desc{white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:1rem}
.zg-progress{position:relative;height:3rem;overflow:hidden;border-radius:999px;display:flex;align-items:center;justify-content:center;outline:1px solid #0002;background:#e5e7eb}
.zg-progress-fill{position:absolute;inset:0 auto 0 0;transition:width .35s ease}
.zg-percent{position:relative;padding:.1rem .45rem;border-radius:.35rem;background:#ffffffb8;color:#111827;font-weight:800}
.zg-amounts{display:flex;justify-content:space-between;gap:.5rem;margin-top:.5rem;flex-wrap:wrap}
.zg-target{text-align:center;margin:1rem 0}.zg-countdown{font-weight:700;margin-top:.25rem}
.zg-recurring{text-align:center;margin-bottom:1rem}.zg-recurring-badge{display:inline-block;background:#0d9488;color:#fff;padding:.35rem .65rem;border-radius:.4rem;font-size:.85rem}
.zg-zap-btn,.zg-submit{display:block;width:100%;padding:.85rem;border:none;border-radius:.75rem;font-weight:700;cursor:pointer;background:#f59e0b}
.zg-loading,.zg-error{text-align:center;padding:2rem}.zg-error,.zg-form-error{color:#b91c1c}
.zg-overlay{position:fixed;inset:0;background:#0008;display:none;z-index:2147483647;align-items:center;justify-content:center;padding:1rem;font:16px sans-serif;color:#111827}
.zg-overlay.show{display:flex}.zg-dialog{background:#fff;border-radius:1rem;padding:1.5rem;max-width:420px;width:100%;max-height:95vh;overflow:auto;color:#111827}
.zg-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem}.zg-dialog-title{font-size:1.25rem;font-weight:700}
.zg-close{background:none;border:none;font-size:1.5rem;cursor:pointer;color:#666;line-height:1}
.zg-selected{text-align:center;padding:1rem 0}.zg-selected-value{font-size:3rem;font-weight:700;line-height:1}.zg-sats-label{color:#666;margin-top:.25rem}
.zg-amounts-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem;margin-bottom:1rem}.zg-amt-btn{padding:.75rem;border:1px solid #ddd;border-radius:.6rem;font-weight:600;cursor:pointer;background:#fff;color:#111}
.zg-amt-btn.active{background:#f59e0b;color:#111;border-color:#f59e0b}
.zg-input,.zg-textarea{width:100%;padding:.6rem;border:1px solid #ddd;border-radius:.4rem;margin-bottom:.75rem}.zg-textarea{resize:vertical;min-height:60px}
.zg-form-error{font-size:.9rem;margin:.5rem 0}.zg-qr{text-align:center;margin:1rem 0}.zg-qr canvas{display:block;width:100%;max-width:280px;height:auto;margin:auto;image-rendering:pixelated}
.zg-invoice-text{width:100%;font:.8rem monospace;padding:.5rem;border:1px solid #ddd;border-radius:.4rem;resize:none;background:#f9f9f9;color:#333}
.zg-copy-btn{display:block;margin:.75rem auto;background:none;border:1px solid #bbb;border-radius:.4rem;padding:.5rem;cursor:pointer;color:inherit}
.zg-note,.zg-monitor,.zg-copy-status{font-size:.85rem;line-height:1.4;margin:.75rem 0;overflow-wrap:anywhere}.zg-thankyou{text-align:center;padding:1rem}.zg-thankyou h3{font-size:1.5rem;margin-bottom:.5rem}
`, shadow);
  var card = element('div', 'zg-card', null, shadow);
  element('div', 'zg-loading', 'Loading goal\u2026', card);
  var overlay = element('div', 'zg-overlay', null, shadow);

  function updateAvailability() {
    if (!goal || disposed) return;
    var open = isOpen();
    var zap = card.querySelector('.zg-zap-btn');
    if (zap) {
      zap.disabled = !open || !!(current && current.state === 'creating');
      zap.textContent = open ? '\u26a1 Zap this goal' : 'Goal unavailable for payments';
    }
    var countdown = card.querySelector('.zg-countdown');
    if (countdown) {
      if (!open) countdown.textContent = 'Goal ended or disabled';
      else if (numeric(goal.currentAmount) >= numeric(goal.goalAmount)) countdown.textContent = 'Goal reached \u2014 thank you!';
      else {
        var diff = Math.max(0, Date.parse(goal.targetDate) - Date.now());
        var days = Math.floor(diff / 86400000), hours = Math.floor(diff % 86400000 / 3600000), mins = Math.floor(diff % 3600000 / 60000);
        countdown.textContent = days ? days + 'd ' + hours + 'h remaining' : hours ? hours + 'h ' + mins + 'm remaining' : mins + 'm ' + Math.floor(diff % 60000 / 1000) + 's remaining';
      }
    }
    if (amountForm && (!current || current.state !== 'creating')) {
      amountForm.submit.disabled = !open || !validAmount(amountForm.amount);
      if (!open) amountForm.error.textContent = 'This goal is no longer accepting payments.';
    }
  }

  function renderGoal() {
    if (!goal || disposed) return;
    card.style.backgroundColor = color(goal.backgroundColor, '#ffffff');
    card.style.color = color(goal.textColor, '#1f2937');
    card.style.fontFamily = fonts.includes(goal.fontName) ? goal.fontName : 'sans-serif';
    card.style.fontWeight = [400, 600, 700, 800].includes(Number(goal.fontWeight)) ? String(goal.fontWeight) : '400';
    replaceContents(card);
    element('h1', 'zg-title', goal.title, card);
    if (goal.recurring === true) {
      var units = {day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', half_year: 'Semi-annual', year: 'Annual'};
      var label = Object.prototype.hasOwnProperty.call(units, goal.recurrenceUnit) ? units[goal.recurrenceUnit] : 'Recurring';
      element('span', 'zg-recurring-badge', label + ' \u2014 Period ' + (numeric(goal.periodIndex) + 1), element('div', 'zg-recurring', null, card));
    }
    if (goal.descriptionAbove) element('p', 'zg-desc', goal.descriptionAbove, card);
    // The aggregate is display-only; it never confirms an individual invoice.
    var pct = numeric(goal.currentAmount) / Math.max(1, numeric(goal.goalAmount)) * 100;
    var progress = element('div', 'zg-progress', null, card);
    progress.style.backgroundColor = color(goal.remainderColor, '#e5e7eb');
    var fill = element('div', 'zg-progress-fill', null, progress);
    fill.style.width = Math.min(100, pct) + '%';
    fill.style.backgroundColor = color(goal.progressColor, '#f59e0b');
    element('span', 'zg-percent', pct.toFixed(1) + '%', progress);
    var amounts = element('div', 'zg-amounts', null, card);
    element('span', '', 'Current ' + formatSats(goal.currentAmount), amounts);
    element('span', '', 'Goal ' + formatSats(goal.goalAmount), amounts);
    var target = element('div', 'zg-target', null, card), date = Date.parse(goal.targetDate);
    element('span', '', Number.isFinite(date) ? new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeStyle: 'short'}).format(new Date(date)) : 'No valid end date', target);
    element('div', 'zg-countdown', '', target);
    if (goal.descriptionBelow) element('p', 'zg-desc', goal.descriptionBelow, card);
    brand(button('zg-zap-btn', '\u26a1 Zap this goal', card, openAmountDialog));
    updateAvailability();
  }

  function getGoal() {
    if (disposed || suspended || goalRequest) return goalRequest;
    goalRequest = api('GET', '/goals/' + encodeURIComponent(goalId) + '/public').then(function (data) {
      if (disposed) return;
      if (!data || data.id !== goalId) throw new Error('Goal identity mismatch');
      goal = data;
      renderGoal();
    }).catch(function () {
      if (!disposed && !goal) {
        replaceContents(card);
        element('div', 'zg-error', 'This goal is unavailable.', card);
      }
    }).finally(function () { goalRequest = null; });
    return goalRequest;
  }

  function dialog(title) {
    replaceContents(overlay);
    var dlg = element('div', 'zg-dialog', null, overlay);
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', title);
    var header = element('div', 'zg-dialog-header', null, dlg);
    element('h2', 'zg-dialog-title', title, header);
    var close = button('zg-close', '\xd7', header, closeDialog);
    close.setAttribute('aria-label', 'Close payment dialog');
    overlay.classList.add('show');
    close.focus();
    return dlg;
  }
  function suggestedAmounts() {
    var suggested = goal.suggestedAmounts;
    try { if (typeof suggested === 'string') suggested = JSON.parse(suggested); } catch (_) { suggested = null; }
    if (!Array.isArray(suggested)) return [21, 100, 500, 1000];
    suggested = suggested.filter(function (value, index, all) { return typeof value === 'number' && validAmount(value) && all.indexOf(value) === index; }).slice(0, 4);
    return suggested.length ? suggested : [21, 100, 500, 1000];
  }
  function openAmountDialog() {
    if (disposed || !isOpen() || current && current.state === 'creating') return;
    stopAttempt();
    var dlg = dialog('Choose your zap');
    var selected = element('div', 'zg-selected', null, dlg);
    var selectedValue = element('div', 'zg-selected-value', '\u2014', selected);
    element('div', 'zg-sats-label', 'sats', selected);
    var grid = element('div', 'zg-amounts-grid', null, dlg);
    var form = {amount: null, dlg: dlg};
    var input = element('input', 'zg-input', null, dlg);
    input.type = 'number'; input.min = '1'; input.max = String(MAX_SATS); input.step = '1';
    input.placeholder = 'Custom amount (sats)'; input.setAttribute('aria-label', 'Amount in sats');
    var comment = element('textarea', 'zg-textarea', null, dlg);
    comment.placeholder = 'Comment (optional)'; comment.maxLength = 280; comment.setAttribute('aria-label', 'Comment (optional)');
    form.input = input; form.comment = comment;
    form.error = element('p', 'zg-form-error', '', dlg);
    form.error.setAttribute('role', 'status');
    form.submit = button('zg-submit', 'Create Lightning invoice', dlg, function () { createInvoice(form); });
    brand(form.submit);
    function select(value) {
      if (amountForm !== form || current && current.state === 'creating') return;
      form.amount = value;
      selectedValue.textContent = validAmount(value) ? value.toLocaleString() : '\u2014';
      form.error.textContent = validAmount(value) ? '' : 'Enter a whole number of sats between 1 and 2,100,000,000.';
      grid.querySelectorAll('button').forEach(function (node) { node.classList.toggle('active', Number(node.dataset.amount) === value); });
      updateAvailability();
    }
    suggestedAmounts().forEach(function (value) {
      var node = button('zg-amt-btn', formatSats(value), grid, function () { input.value = String(value); select(value); });
      node.dataset.amount = String(value);
    });
    input.addEventListener('input', function () { select(Number(input.value)); });
    amountForm = form;
    updateAvailability();
    input.focus();
  }
  function lockForm(form, locked) {
    form.dlg.querySelectorAll('input,textarea,.zg-amt-btn,.zg-submit').forEach(function (node) { node.disabled = locked; });
    form.submit.textContent = locked ? 'Creating invoice\u2026' : 'Create Lightning invoice';
    updateAvailability();
  }
  function active(attempt, state) { return !disposed && !suspended && current === attempt && (!state || attempt.state === state); }
  function createInvoice(form) {
    if (disposed || amountForm !== form || current && current.state === 'creating' || !isOpen()) return;
    if (!validAmount(form.amount)) { form.error.textContent = 'Enter a whole number of sats between 1 and 2,100,000,000.'; return; }
    // Only connection/lifecycle fields mutate. Request and invoice snapshots do not.
    var attempt = {request: Object.freeze({id: ++sequence, amount: form.amount, comment: form.comment.value.trim() || null}), invoice: null, state: 'creating', socket: null, retry: null, watchdog: null, retries: 0, statusTimer: null, statusWatchdog: null, statusRequest: null};
    stopAttempt();
    current = attempt;
    lockForm(form, true);
    form.error.textContent = '';
    api('POST', '/goals/' + encodeURIComponent(goalId) + '/invoice', {amount: attempt.request.amount, comment: attempt.request.comment}).then(function (data) {
      if (!active(attempt, 'creating')) return;
      if (!data || typeof data.paymentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(data.paymentHash) || typeof data.paymentRequest !== 'string' || data.paymentRequest.length > 8192 || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(data.paymentRequest)) throw new Error('Invalid invoice response');
      attempt.invoice = Object.freeze({paymentHash: data.paymentHash.toLowerCase(), paymentRequest: data.paymentRequest});
      attempt.state = 'pending';
      amountForm = null;
      showInvoice(attempt); // Always make BOLT11 usable before trying monitoring or QR.
      watchInvoice(attempt);
      checkReceipt(attempt);
      updateAvailability();
    }).catch(function () {
      if (!active(attempt, 'creating')) return;
      current = null;
      lockForm(form, false);
      form.error.textContent = 'Could not create an invoice. Please try again.';
    });
  }

  function loadQR(attempt) {
    // This is a self-hosted asset beside embed.js, never a QR service or remote CDN.
    if (window.ZapGoalsQR && typeof window.ZapGoalsQR.create === 'function') return Promise.resolve(window.ZapGoalsQR);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script'), finished = false;
      var timer = setTimeout(function () { finish(new Error('QR loading timed out')); }, 10000);
      function finish(error) {
        if (finished) return;
        finished = true;
        attempt.qrCancel = null;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        if (error) reject(error);
        else if (window.ZapGoalsQR && typeof window.ZapGoalsQR.create === 'function') resolve(window.ZapGoalsQR);
        else reject(new Error('QR unavailable'));
      }
      attempt.qrCancel = function () { finish(new Error('Attempt closed')); };
      script.src = QR_URL;
      script.async = true;
      if (scriptTag.nonce) script.nonce = scriptTag.nonce;
      script.onload = function () { finish(); };
      script.onerror = function () { finish(new Error('QR unavailable')); };
      document.head.appendChild(script);
    });
  }
  function showInvoice(attempt) {
    if (!active(attempt, 'pending')) return;
    var dlg = dialog('Pay Lightning invoice');
    element('p', '', formatSats(attempt.request.amount), dlg);
    var qrBox = element('div', 'zg-qr', 'Preparing local QR\u2026', dlg);
    var text = element('textarea', 'zg-invoice-text', null, dlg);
    text.readOnly = true; text.rows = 3; text.value = attempt.invoice.paymentRequest; text.setAttribute('aria-label', 'Lightning invoice');
    var copyStatus = element('p', 'zg-copy-status', '', dlg);
    copyStatus.setAttribute('role', 'status');
    button('zg-copy-btn', 'Copy invoice', dlg, function () {
      Promise.resolve().then(function () { return navigator.clipboard.writeText(attempt.invoice.paymentRequest); }).then(function () {
        if (active(attempt, 'pending')) copyStatus.textContent = 'Invoice copied.';
      }).catch(function () {
        if (active(attempt, 'pending')) { text.focus(); text.select(); copyStatus.textContent = 'Select and copy the invoice text.'; }
      });
    });
    var link = element('a', '', 'Open in Lightning wallet', dlg);
    link.href = 'lightning:' + attempt.invoice.paymentRequest;
    attempt.monitor = element('p', 'zg-monitor', 'Connecting for payment confirmation\u2026', dlg);
    attempt.monitor.setAttribute('role', 'status');
    element('p', 'zg-note', 'Closing this dialog does not cancel the invoice. If confirmation is unavailable, check your wallet before paying again.', dlg);
    loadQR(attempt).then(function (library) {
      if (!active(attempt, 'pending')) return;
      var qr = library.create(0, 'M');
      qr.addData('LIGHTNING:' + attempt.invoice.paymentRequest.toUpperCase(), 'Alphanumeric');
      qr.make();
      var count = qr.getModuleCount(), scale = 4, margin = 4;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = (count + margin * 2) * scale;
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Lightning invoice QR code');
      var context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      for (var row = 0; row < count; row++) for (var col = 0; col < count; col++) if (qr.isDark(row, col)) context.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
      replaceContents(qrBox);
      qrBox.appendChild(canvas);
    }).catch(function () { if (active(attempt, 'pending')) qrBox.textContent = 'Local QR unavailable. Copy the invoice below or open it in your wallet.'; });
  }
  function closeSocket(socket) {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch (_) {}
  }
  function stopWatching(attempt) {
    clearTimeout(attempt.retry); clearTimeout(attempt.watchdog);
    attempt.retry = attempt.watchdog = null;
    var socket = attempt.socket;
    attempt.socket = null;
    closeSocket(socket);
  }
  function stopChecking(attempt) {
    clearTimeout(attempt.statusTimer); clearTimeout(attempt.statusWatchdog);
    attempt.statusTimer = attempt.statusWatchdog = null;
    if (attempt.statusRequest) attempt.statusRequest.abort();
  }
  function checkReceipt(attempt) {
    if (!active(attempt, 'pending') || attempt.statusRequest) return;
    clearTimeout(attempt.statusTimer); attempt.statusTimer = null;
    var request = new AbortController();
    attempt.statusRequest = request;
    attempt.statusWatchdog = setTimeout(function () { request.abort(); }, 10000);
    // The host's generic hash websocket is publicly writable. Its messages are
    // hints, not receipts. Only the extension's verified goal/hash receipt can
    // confirm payment; polling also recovers settlements missed while offline.
    api('GET', '/goals/' + encodeURIComponent(goalId) + '/payments/' + attempt.invoice.paymentHash, null, request.signal).then(function (data) {
      if (active(attempt, 'pending') && data && data.paid === true) paymentComplete(attempt);
    }).catch(function () {
      if (active(attempt, 'pending')) attempt.monitor.textContent = 'Payment confirmation unavailable; retrying. This invoice is still payable. Check your wallet before paying again.';
    }).finally(function () {
      clearTimeout(attempt.statusWatchdog); attempt.statusWatchdog = null;
      attempt.statusRequest = null;
      if (active(attempt, 'pending')) attempt.statusTimer = setTimeout(function () {
        attempt.statusTimer = null;
        checkReceipt(attempt);
      }, 5000);
    });
  }
  function stopAttempt() {
    var attempt = current;
    current = null; // Invalidate before closing, including synchronous callbacks.
    if (attempt) { stopWatching(attempt); stopChecking(attempt); if (attempt.qrCancel) attempt.qrCancel(); }
  }
  function retryInvoice(attempt) {
    if (!active(attempt, 'pending') || attempt.retry !== null) return;
    attempt.monitor.textContent = 'Automatic confirmation unavailable; reconnecting. This invoice is still payable. Check your wallet before paying again.';
    attempt.retry = setTimeout(function () {
      attempt.retry = null;
      if (active(attempt, 'pending')) watchInvoice(attempt);
    }, Math.min(30000, 1000 * Math.pow(2, Math.min(attempt.retries++, 5))));
  }
  function socketURL(id) { return (srcUrl.protocol === 'https:' ? 'wss://' : 'ws://') + srcUrl.host + '/api/v1/ws/' + encodeURIComponent(id); }
  function watchInvoice(attempt) {
    if (!active(attempt, 'pending')) return;
    stopWatching(attempt);
    var socket;
    try { socket = new WebSocket(socketURL(attempt.invoice.paymentHash)); } catch (_) { retryInvoice(attempt); return; }
    attempt.socket = socket;
    function valid() { return active(attempt, 'pending') && attempt.socket === socket; }
    function lost() {
      if (!valid()) return;
      stopWatching(attempt);
      retryInvoice(attempt);
    }
    socket.onopen = function () {
      if (!valid()) return;
      clearTimeout(attempt.watchdog); attempt.watchdog = null; attempt.retries = 0;
      attempt.monitor.textContent = 'Waiting for confirmed payment\u2026';
    };
    socket.onmessage = function (event) {
      if (!valid()) return;
      try {
        var msg = JSON.parse(event.data);
        if (!msg || msg.pending !== false || !['success', 'settled', 'paid'].includes(msg.status)) return;
        if (msg.payment_hash !== undefined && msg.payment_hash !== attempt.invoice.paymentHash) return;
        if (msg.paymentHash !== undefined && msg.paymentHash !== attempt.invoice.paymentHash) return;
        checkReceipt(attempt);
      } catch (_) {}
    };
    socket.onerror = socket.onclose = lost;
    attempt.watchdog = setTimeout(lost, 10000);
  }
  function paymentComplete(attempt) {
    if (!active(attempt, 'pending')) return;
    attempt.state = 'paid';
    stopWatching(attempt);
    stopChecking(attempt);
    if (attempt.qrCancel) attempt.qrCancel();
    var dlg = dialog('Payment received');
    var receipt = element('div', 'zg-thankyou', null, dlg);
    element('h3', '', 'Thank you!', receipt);
    element('p', '', formatSats(attempt.request.amount) + ' received', receipt);
    brand(button('zg-submit', 'Done', dlg, closeDialog));
    // No timed dialog closure and no aggregate-based paid detection. A late goal
    // refresh can update only the card, never any attempt or its subscription.
    getGoal();
  }
  function closeDialog() {
    stopAttempt();
    amountForm = null;
    overlay.classList.remove('show');
    replaceContents(overlay);
    updateAvailability();
    var zap = card.querySelector('.zg-zap-btn');
    if (zap) zap.focus();
  }
  overlay.addEventListener('click', function (event) { if (event.target === overlay) closeDialog(); });
  overlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
    if (event.key === 'Tab') {
      var nodes = Array.from(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]'));
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  function retryGoal() {
    if (disposed || suspended || goalRetry !== null) return;
    goalRetry = setTimeout(function () { goalRetry = null; connectGoalSocket(); }, Math.min(30000, 1000 * Math.pow(2, Math.min(goalRetries++, 5))));
  }
  function connectGoalSocket() {
    if (disposed || suspended) return;
    var socket;
    try { socket = new WebSocket(socketURL(goalId)); } catch (_) { retryGoal(); return; }
    goalSocket = socket;
    function valid() { return !disposed && !suspended && goalSocket === socket; }
    function lost() {
      if (!valid()) return;
      clearTimeout(goalWatchdog); goalWatchdog = null;
      goalSocket = null;
      closeSocket(socket);
      retryGoal();
    }
    socket.onopen = function () { if (valid()) { clearTimeout(goalWatchdog); goalWatchdog = null; goalRetries = 0; } };
    socket.onmessage = function () { if (valid()) getGoal(); };
    socket.onerror = socket.onclose = lost;
    goalWatchdog = setTimeout(lost, 10000);
  }
  function stopBackground() {
    clearInterval(tickTimer); clearInterval(pollTimer);
    clearTimeout(goalRetry); clearTimeout(goalWatchdog);
    tickTimer = pollTimer = goalRetry = goalWatchdog = null;
    var socket = goalSocket; goalSocket = null; closeSocket(socket);
  }
  function startBackground() {
    tickTimer = setInterval(updateAvailability, 1000);
    pollTimer = setInterval(getGoal, 15000);
    getGoal();
    connectGoalSocket();
  }
  function onPageHide(event) {
    if (!event.persisted) { dispose(); return; }
    // Back/forward cache restores the same closure: pause, rather than leave a
    // restored page permanently disconnected or displaying an unwatched invoice.
    suspended = true;
    closeDialog();
    stopBackground();
  }
  function onPageShow(event) {
    if (!event.persisted || !suspended || disposed) return;
    if (!container.isConnected) { dispose(); return; }
    suspended = false;
    startBackground();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopAttempt();
    stopBackground();
    observer.disconnect();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  var observer = new MutationObserver(function () { if (!container.isConnected) dispose(); });
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  startBackground();
})();
