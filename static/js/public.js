(() => {
  const API = '/api/v1/ext/zapgoalswasm'
  const app = Vue.createApp({
    render: window.ZAPGOALS_PUBLIC_RENDER(),
    data: () => ({
      goalId: '', goal: null, loading: true, loadError: '', amount: null, comment: '',
      amountDialog: false, invoiceDialog: false, creatingInvoice: false, invoice: null,
      paymentState: 'idle', activeAttempt: null, attemptSequence: 0, watchSequence: 0,
      subscriptionId: '', subscribing: false, monitoringError: '', receiptError: '', removeBridgeListener: null,
      receiptPollTimer: null, receiptRequestTimer: null, receiptCheck: null,
      pollTimer: null, clockTimer: null, disposed: false,
      brandingSheet: null, lastGoalLoad: 0, loadInFlight: null, goalRequestSequence: 0,
      now: Date.now(), isDark: false
    }),
    computed: {
      actualPercent() { return Number(this.goal?.percent ?? (Number(this.goal?.currentAmount || 0) / Math.max(1, Number(this.goal?.goalAmount || 1)) * 100)) || 0 },
      cappedPercent() { return Math.min(100, Math.max(0, this.actualPercent)) },
      percentLabel() { return `${this.actualPercent.toFixed(1)}%` },
      suggestedAmounts() { try { return JSON.parse(this.goal?.suggestedAmounts || '[21,100,500,1000]').slice(0, 4) } catch (_) { return [21, 100, 500, 1000] } },
      selectedAmountLabel() { return Number.isInteger(Number(this.amount)) && Number(this.amount) > 0 ? Number(this.amount).toLocaleString() : '—' },
      paymentButtonLabel() { return this.amount ? `Zap ${Number(this.amount).toLocaleString()} sats` : 'Continue to payment' },
      targetLabel() { return Number.isFinite(Date.parse(this.goal?.targetDate)) ? new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeStyle: 'short'}).format(new Date(this.goal.targetDate)) : '—' },
      countdownLabel() { if (!this.goal) return ''; if (!Number.isFinite(Date.parse(this.goal.targetDate))) return 'Deadline unavailable'; const difference = new Date(this.goal.targetDate).getTime() - this.now; if (difference <= 0) return this.goal.recurring ? 'Updating period…' : 'Goal ended'; const days = Math.floor(difference / 86400000), hours = Math.floor(difference % 86400000 / 3600000), minutes = Math.floor(difference % 3600000 / 60000), seconds = Math.floor(difference % 60000 / 1000); return days ? `${days}d ${hours}h remaining` : hours ? `${hours}h ${minutes}m remaining` : `${minutes}m ${seconds}s remaining` },
      isComplete() { return Number(this.goal?.currentAmount || 0) >= Number(this.goal?.goalAmount || Infinity) },
      isEnded() { return this.goal?.archived === true || this.goal?.status === 'archived' || !Number.isFinite(Date.parse(this.goal?.targetDate)) || new Date(this.goal.targetDate).getTime() <= this.now },
      zapButtonLabel() { if (this.goal?.archived === true || this.goal?.status === 'archived') return 'Goal archived'; return this.isEnded ? (this.goal?.recurring ? 'Updating period…' : 'Goal ended') : 'Zap this goal' },
      amountOptionColor() { return this.isDark ? 'grey-5' : 'grey-8' },
      recurrenceLabel() { if (!this.goal?.recurring) return ''; const units = {day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', half_year: 'Semi-annual', year: 'Annual'}; const base = units[this.goal.recurrenceUnit] || 'Recurring'; const interval = Number(this.goal.recurrenceInterval || 1); return interval > 1 ? `${base} (every ${interval})` : base }
    },
    methods: {
      async api(method, path, body) { const result = await LNbitsBridge.callApi(method, API + path, body); if (result?.error) throw new Error(result.error); return result },
      initTheme() { this.isDark = matchMedia('(prefers-color-scheme: dark)').matches; this.applyTheme() },
      applyTheme() { document.body.classList.toggle('body--dark', this.isDark); this.$q.dark.set(this.isDark) },
      toggleTheme() { this.isDark = !this.isDark; this.applyTheme() },
      safeColor(value, fallback) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback },
      contrastColor(value) { const hex = this.safeColor(value, '#673AB7').slice(1); const channels = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)); return (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000 >= 145 ? '#111827' : '#FFFFFF' },
      applyGoalDesign(goal) { if (!goal || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return; const allowedFonts = ['sans-serif', 'system-ui, sans-serif', 'Arial, sans-serif', '"Trebuchet MS", sans-serif', 'Verdana, sans-serif', 'Tahoma, sans-serif', 'serif', 'Georgia, serif', '"Times New Roman", serif', 'monospace', '"Courier New", monospace']; const text = this.safeColor(goal.textColor, '#1F2937'); const progress = this.safeColor(goal.progressColor, '#673AB7'); const font = allowedFonts.includes(goal.fontName) ? goal.fontName : 'sans-serif'; const weight = [400, 600, 700, 800].includes(Number(goal.fontWeight)) ? Number(goal.fontWeight) : 400; const sheet = new CSSStyleSheet(); sheet.replaceSync(`.public-card-content{color:${text}!important;font-family:${font}!important;font-weight:${weight}!important}.public-card-content .goal-title,.public-card-content .goal-description,.public-card-content .goal-target span,.public-card-content .row.justify-between span{font-weight:${weight}!important}.public-card-content .zap-action{background:${progress}!important;color:${this.contrastColor(progress)}!important}`); const previous = this.brandingSheet; this.brandingSheet = sheet; document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter(item => item !== previous), sheet] },
      async loadGoal(silent = false, force = false, attempt = null) {
        if (this.disposed) return this.goal
        const requestedAt = Date.now()
        if (!force && silent && requestedAt - this.lastGoalLoad < 3000) return this.goal
        if (!force && this.loadInFlight) return this.loadInFlight
        const requestId = ++this.goalRequestSequence
        const goalId = this.goalId
        if (!silent) this.loading = true
        this.lastGoalLoad = requestedAt
        const isCurrentRequest = () => !this.disposed && this.goalId === goalId && requestId === this.goalRequestSequence && (!attempt || this.isCurrentAttempt(attempt))
        const request = this.api('GET', `/goals/${goalId}/public`).then(goal => {
          if (!isCurrentRequest()) return this.goal
          // The receiver's public API is the only source of displayed progress.
          // A lower total can be legitimate (for example, after period closure).
          this.goal = goal
          this.applyGoalDesign(goal)
          this.loadError = ''
          return goal
        }).catch(error => {
          if (isCurrentRequest() && !silent) this.loadError = error.message || 'This goal is unavailable.'
          return this.goal
        }).finally(() => {
          if (this.loadInFlight === request) this.loadInFlight = null
          if (!this.disposed && requestId === this.goalRequestSequence) this.loading = false
        })
        this.loadInFlight = request
        return request
      },
      goalHasEnded() { return this.goal?.archived === true || this.goal?.status === 'archived' || !Number.isFinite(Date.parse(this.goal?.targetDate)) || new Date(this.goal.targetDate).getTime() <= Date.now() },
      openAmountDialog() {
        if (this.disposed || !this.goal || this.goalHasEnded() || this.creatingInvoice || this.paymentState === 'pending') return
        this.resetPayment()
        this.amount = null
        this.comment = ''
        this.amountDialog = true
      },
      closeAmountDialog() { this.amountDialog = false; if (this.paymentState === 'creating') this.resetPayment() },
      onAmountDialogChange(visible) { if (!visible) this.closeAmountDialog() },
      selectAmount(amount) { if (!this.creatingInvoice) this.amount = Number(amount) },
      positiveAmount(value) { return Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 2100000000 || 'Enter a whole number from 1 to 2,100,000,000 sats.' },
      isCurrentAttempt(attempt) { return !this.disposed && Boolean(attempt) && this.activeAttempt === attempt },
      resetPayment() {
        // Invalidate before unsubscribing: queued callbacks and unresolved API
        // requests may outlive the dialog that originally started them.
        this.activeAttempt = null
        clearTimeout(this.receiptPollTimer)
        clearTimeout(this.receiptRequestTimer)
        this.receiptPollTimer = this.receiptRequestTimer = null
        this.receiptCheck = null
        this.receiptError = ''
        this.stopWatching()
        this.invoice = null
        this.invoiceDialog = false
        this.creatingInvoice = false
        this.monitoringError = ''
        this.paymentState = 'idle'
      },
      async createInvoice() {
        if (this.disposed || !this.goal || this.goalHasEnded() || this.creatingInvoice || this.paymentState === 'pending' || this.positiveAmount(this.amount) !== true) return
        this.resetPayment()
        const attempt = Object.freeze({id: ++this.attemptSequence, goalId: this.goalId, amount: Number(this.amount), comment: this.comment.trim() || null, periodIndex: this.goal.periodIndex ?? null})
        this.activeAttempt = attempt
        this.paymentState = 'creating'
        this.creatingInvoice = true
        try {
          const invoice = await this.api('POST', `/goals/${attempt.goalId}/invoice`, {amount: attempt.amount, comment: attempt.comment})
          if (!this.isCurrentAttempt(attempt)) return
          if (!invoice?.paymentHash || !invoice?.paymentRequest) throw new Error('The server did not return a usable invoice.')
          this.invoice = Object.freeze({...invoice, amount: attempt.amount, attemptId: attempt.id})
          this.amountDialog = false
          this.paymentState = 'pending'
          // Display the locally generated QR before awaiting monitoring. A bridge
          // failure must never strand an invoice that was already created.
          this.invoiceDialog = true
          this.creatingInvoice = false
          this.scheduleReceiptCheck(1000, attempt)
          await this.watchInvoice(attempt)
        } catch (error) {
          if (!this.isCurrentAttempt(attempt)) return
          this.resetPayment()
          try { await LNbitsBridge.notify(error.message || 'Could not create invoice.', 'negative') } catch (_) {}
        } finally {
          if (this.isCurrentAttempt(attempt)) this.creatingInvoice = false
        }
      },
      async watchInvoice(attempt = this.activeAttempt) {
        if (!this.isCurrentAttempt(attempt) || this.paymentState !== 'pending' || !this.invoice || this.subscribing) return
        this.stopWatching()
        const paymentHash = this.invoice.paymentHash
        const id = `zap-${attempt.id}-${++this.watchSequence}-${paymentHash.slice(0, 12)}`
        this.subscriptionId = id
        this.subscribing = true
        this.monitoringError = ''
        try {
          await LNbitsBridge.subscribePayment(paymentHash, id)
        } catch (_) {
          if (this.isCurrentAttempt(attempt) && this.subscriptionId === id && this.paymentState === 'pending') {
            this.subscriptionId = ''
            this.subscribing = false
            this.monitoringError = 'Live payment updates are unavailable. This invoice is still payable; we will keep checking the receiving server for a verified receipt.'
          }
        } finally {
          if (this.isCurrentAttempt(attempt) && this.subscriptionId === id && this.paymentState === 'pending') this.subscribing = false
          else {
            // A close/unmount may have unsubscribed before subscribe completed.
            // Repeat cleanup for this captured ID only, never the next invoice.
            await this.stopWatching(id)
          }
        }
      },
      async stopWatching(id = this.subscriptionId) {
        if (!id) return
        if (this.subscriptionId === id) { this.subscriptionId = ''; this.subscribing = false }
        try { await LNbitsBridge.unsubscribePayment(id) } catch (_) {}
      },
      async onBridgeEvent(message) {
        if (!message || !['payment.update', 'payment.settled'].includes(message.event) || !this.subscriptionId || message.subscriptionId !== this.subscriptionId) return
        const payment = message.data || {}
        const hash = payment.paymentHash || payment.payment_hash
        if (hash && hash !== this.invoice?.paymentHash) return
        // Public hash-socket payloads are untrusted broadcasts, including
        // "settled" events. They are wakeups, never evidence of payment.
        await this.checkInvoiceStatus(this.activeAttempt)
      },
      scheduleReceiptCheck(delay, attempt) {
        if (!this.isCurrentAttempt(attempt) || this.paymentState !== 'pending') return
        clearTimeout(this.receiptPollTimer)
        this.receiptPollTimer = setTimeout(() => {
          if (!this.isCurrentAttempt(attempt) || this.paymentState !== 'pending') return
          this.receiptPollTimer = null
          return this.checkInvoiceStatus(attempt)
        }, delay)
      },
      async checkInvoiceStatus(attempt = this.activeAttempt) {
        if (!this.isCurrentAttempt(attempt) || this.paymentState !== 'pending' || this.invoice?.attemptId !== attempt.id || this.receiptCheck?.attempt === attempt) return
        clearTimeout(this.receiptPollTimer)
        this.receiptPollTimer = null
        const check = Object.freeze({attempt, paymentHash: this.invoice.paymentHash})
        this.receiptCheck = check
        let timeout
        try {
          // A stuck bridge request must not permanently stop receipt polling.
          const status = await Promise.race([
            this.api('GET', `/goals/${encodeURIComponent(attempt.goalId)}/payments/${encodeURIComponent(check.paymentHash)}`),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Receipt check timed out.')), 10000)
              this.receiptRequestTimer = timeout
            })
          ])
          if (!this.isCurrentAttempt(attempt) || this.receiptCheck !== check || this.paymentState !== 'pending' || this.invoice?.paymentHash !== check.paymentHash) return
          this.receiptError = ''
          // Only a durable, receiver-verified extension receipt can confirm this
          // invoice. Neither aggregate progress nor a wallet/socket claim can.
          if (status?.paid !== true) return
          this.paymentState = 'paid'
          this.monitoringError = ''
          // Confirm with a toast, refresh the authoritative progress, and close
          // the dialog. No attempt state survives a completed payment.
          this.loadGoal(true, true).catch(() => {})
          try { await LNbitsBridge.notify('Payment received — thank you!', 'positive') } catch (_) {}
          this.resetPayment()
        } catch (_) {
          if (this.isCurrentAttempt(attempt) && this.receiptCheck === check && this.paymentState === 'pending') this.receiptError = 'The receiving server has not confirmed this payment. We will keep checking. Check your wallet before paying again.'
        } finally {
          clearTimeout(timeout)
          if (this.receiptCheck === check) {
            this.receiptCheck = null
            this.receiptRequestTimer = null
            if (this.isCurrentAttempt(attempt) && this.paymentState === 'pending') this.scheduleReceiptCheck(3000, attempt)
          }
        }
      },
      async retryPaymentMonitoring() {
        const attempt = this.activeAttempt
        const checking = this.checkInvoiceStatus(attempt)
        if (!this.subscriptionId && !this.subscribing) this.watchInvoice(attempt)
        await checking
      },
      async copyInvoice() { if (!this.invoice?.paymentRequest) return; try { await navigator.clipboard.writeText(this.invoice.paymentRequest); await LNbitsBridge.notify('Invoice copied.', 'positive') } catch (_) { try { await LNbitsBridge.notify('Clipboard access is unavailable. Select and copy the invoice text.', 'warning') } catch (_) {} } },
      onInvoiceDialogChange(visible) { if (!visible) this.closeInvoice() },
      closeInvoice() { this.resetPayment(); this.amount = null; this.comment = '' },
      formatSats(value) { return Number(value || 0).toLocaleString() }
    },
    async mounted() {
      this.initTheme()
      try {
        const context = await LNbitsBridge.connect()
        if (this.disposed) return
        this.goalId = context?.routeParams?.goalId || ''
        this.removeBridgeListener = LNbitsBridge.onEvent(message => this.onBridgeEvent(message))
        await this.loadGoal()
        if (this.disposed) return
        this.clockTimer = setInterval(() => { this.now = Date.now() }, 1000)
        this.pollTimer = setInterval(() => { if (!this.disposed && !document.hidden) this.loadGoal(true) }, 15000)
      } catch (error) {
        if (!this.disposed) { this.loadError = error.message; this.loading = false }
      } finally {
        if (!this.disposed) document.getElementById('q-app')?.classList.remove('vue-pending')
      }
    },
    beforeUnmount() {
      this.disposed = true
      ++this.goalRequestSequence
      this.resetPayment()
      clearInterval(this.pollTimer)
      clearInterval(this.clockTimer)
      this.pollTimer = this.clockTimer = null
      this.loadInFlight = null
      this.removeBridgeListener?.()
      this.removeBridgeListener = null
      if (this.brandingSheet && 'adoptedStyleSheets' in document) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== this.brandingSheet)
      this.brandingSheet = null
    }
  })
  app.use(Quasar, {config: {notify: {}}})
  if (window.QrcodeVue?.default) app.component('qrcode-vue', window.QrcodeVue.default)
  window.ZapGoalsPublicApp = app.mount('#q-app')
})()
