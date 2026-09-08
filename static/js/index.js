(() => {
  const API = '/api/v1/ext/zapgoalswasm'
  const defaultGoal = walletId => ({walletId: walletId || null, title: '', descriptionAbove: '', descriptionBelow: '', goalAmount: 10000, targetDate: '', suggestedAmounts: [21, 100, 500, 1000], walletMode: 'vanilla', backgroundColor: '#FFFFFF', textColor: '#1F2937', progressColor: '#F59E0B', remainderColor: '#E5E7EB', fontName: 'sans-serif', fontWeight: 400, currentAmount: 0, recurring: false, recurrenceUnit: 'month', recurrenceInterval: 1, recurrenceDayOfMonth: 0, targetWalletId: '', rolloverMode: 'counts_as_progress', sweepMode: 'target_amount'})
  const app = Vue.createApp({
    render: window.ZAPGOALS_INDEX_RENDER(),
    data: () => ({goals: [], wallets: [], loading: false, loadError: '', saving: false, formError: '', isDark: false, formDialog: {show: false, editing: false, original: null, data: defaultGoal(null)}, deleteDialog: {show: false, loading: false, goal: null}, embedDialog: {show: false, goal: null}, periodsDialog: {show: false, goal: null, periods: []}, recurrenceUnitOptions: [{label: 'Daily', value: 'day'}, {label: 'Weekly', value: 'week'}, {label: 'Monthly', value: 'month'}, {label: 'Quarterly', value: 'quarter'}, {label: 'Semi-annual', value: 'half_year'}, {label: 'Annual', value: 'year'}], sweepModeOptions: [{label: 'Target amount only', value: 'target_amount'}, {label: 'Entire amount', value: 'entire_amount'}], rolloverModeOptions: [{label: 'Counts as next period progress', value: 'counts_as_progress'}, {label: 'Reset progress to zero', value: 'reset_to_zero'}], fontOptions: ['sans-serif', 'system-ui, sans-serif', 'Arial, sans-serif', '"Trebuchet MS", sans-serif', 'Verdana, sans-serif', 'Tahoma, sans-serif', 'serif', 'Georgia, serif', '"Times New Roman", serif', 'monospace', '"Courier New", monospace'].map(value => ({label: value.replace(/,.*$/, '').replaceAll('"', ''), value})), fontWeightOptions: [{label: 'Regular', value: 400}, {label: 'Semi-bold', value: 600}, {label: 'Bold', value: 700}, {label: 'Extra-bold', value: 800}] }),
    computed: {
      financialRulesLocked() { return this.formDialog.editing && Boolean(this.formDialog.original?.recurring) },
      walletOptions() { return this.wallets.map(wallet => ({label: wallet.name, value: wallet.id})) },
      columns() { return [{name: 'title', label: 'Title', field: 'title', align: 'left', sortable: true}, {name: 'progress', label: 'Progress', field: row => `${this.formatSats(row.currentAmount)} / ${this.formatSats(row.goalAmount)}`, align: 'left'}, {name: 'target', label: 'Target date', field: row => this.formatDate(row.targetDate), align: 'left'}, {name: 'status', label: 'Status', field: row => this.goalStatus(row), align: 'left'}, {name: 'actions', label: '', field: 'id', align: 'right'}] },
      previewPercent() { const target = Number(this.formDialog.data.goalAmount) || 1; return Math.min(100, Math.max(0, Number(this.formDialog.data.currentAmount || 0) / target * 100)) },
      previewBarWidth() { return this.previewPercent * 6.52 },
      embedScriptSnippet() { const goal = this.embedDialog.goal; if (!goal) return ''; return `<script src="${this.embedScriptUrl(goal)}" data-goal="${goal.id}" async><\/script>` },
      periodColumns() { return [{name: 'index', label: '#', field: 'periodIndex', align: 'left'}, {name: 'start', label: 'Start', field: row => this.formatDate(row.startDate), align: 'left'}, {name: 'end', label: 'End', field: row => this.formatDate(row.endDate), align: 'left'}, {name: 'zapped', label: 'Zapped', field: row => this.formatSats(row.zappedAmount), align: 'left'}, {name: 'recorded', label: 'Recorded allocation (no transfer)', field: row => this.formatSats(row.movedAmount), align: 'left'}, {name: 'rollover', label: 'Rollover', field: row => this.formatSats(row.rolloverAmount), align: 'left'}, {name: 'retained', label: 'Retained excess', field: row => this.formatSats(row.retainedAmount), align: 'left'}] }
    },
    methods: {
      async api(method, path, body) { const result = await LNbitsBridge.callApi(method, API + path, body); if (result?.error) throw new Error(result.error); return result },
      initTheme() { this.isDark = matchMedia('(prefers-color-scheme: dark)').matches; this.applyTheme() },
      applyTheme() { document.body.classList.toggle('body--dark', this.isDark); this.$q.dark.set(this.isDark) },
      toggleTheme() { this.isDark = !this.isDark; this.applyTheme() },
      async load() { this.loading = true; this.loadError = ''; try { const [goals, wallets] = await Promise.all([this.api('GET', '/goals'), this.api('GET', '/wallets')]); this.goals = goals.data || []; this.wallets = wallets.data || [] } catch (error) { this.loadError = error.message || 'Goals could not be loaded.' } finally { this.loading = false } },
      openGoalDialog(goal = null) { const firstWallet = this.wallets[0]?.id || null; this.formError = ''; this.formDialog = {show: true, editing: Boolean(goal), original: goal ? Object.freeze({...goal}) : null, data: goal ? {...goal, walletMode: 'vanilla', targetDate: this.toLocalDateTime(goal.targetDate), suggestedAmounts: JSON.parse(goal.suggestedAmounts || '[]').concat([null, null, null, null]).slice(0, 4)} : defaultGoal(firstWallet)} },
      closeGoalDialog() { this.formDialog.show = false },
      resetDialog() { if (!this.formDialog.show) this.formError = '' },
      required(value) { return Boolean(value) || 'Required' },
      requiredTitle(value) { return Boolean(value?.trim()) || 'Enter a title between 1 and 120 characters.' },
      positiveAmount(value) { return Number.isInteger(Number(value)) && Number(value) >= 1 || 'Enter a whole number of at least 1 sat.' },
      async saveGoal() {
        if (this.saving) return
        const data = {...this.formDialog.data}
        const original = this.formDialog.original
        if (this.formDialog.editing && original) {
          data.walletId = original.walletId
          data.recurring = Boolean(original.recurring)
          if (original.recurring) {
            // Use the original values only for local validation. The PUT below
            // omits financial rules so the backend keeps its canonical anchor.
            for (const key of ['goalAmount', 'targetDate', 'recurrenceUnit', 'recurrenceInterval', 'recurrenceDayOfMonth', 'targetWalletId', 'sweepMode', 'rolloverMode']) data[key] = original[key]
          }
        }
        if (!data.title?.trim() || !data.walletId || !Number.isInteger(Number(data.goalAmount)) || Number(data.goalAmount) < 1 || !data.targetDate || !Number.isFinite(new Date(data.targetDate).getTime())) {
          this.formError = 'Complete the required fields with valid values.'
          return
        }
        const amounts = data.suggestedAmounts.filter(value => value !== null && value !== '').map(Number)
        if (!amounts.length || amounts.some(value => !Number.isInteger(value) || value < 1) || new Set(amounts).size !== amounts.length) {
          this.formError = 'Configure one to four unique whole-satoshi amounts.'
          return
        }
        const payload = {...data, walletMode: 'vanilla', title: data.title.trim(), targetDate: new Date(data.targetDate).toISOString(), suggestedAmounts: amounts, fontWeight: Number(data.fontWeight), recurring: Boolean(data.recurring), recurrenceInterval: Number(data.recurrenceInterval) || 1, recurrenceDayOfMonth: Number(data.recurrenceDayOfMonth) || 0}
        for (const key of ['currentAmount', 'periodIndex', 'periodStartDate', 'periodEndDate', 'percent', 'status', 'createdAt', 'updatedAt', 'archived', 'accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) delete payload[key]
        if (this.formDialog.editing) {
          delete payload.walletId
          delete payload.recurring
          if (original?.recurring) {
            for (const key of ['goalAmount', 'targetDate', 'recurrenceUnit', 'recurrenceInterval', 'recurrenceDayOfMonth', 'targetWalletId', 'sweepMode', 'rolloverMode']) delete payload[key]
          }
        }
        this.saving = true
        this.formError = ''
        try {
          const saved = await this.api(this.formDialog.editing ? 'PUT' : 'POST', this.formDialog.editing ? `/goals/${data.id}` : '/goals', payload)
          const index = this.goals.findIndex(goal => goal.id === saved.id)
          if (index < 0) this.goals.unshift(saved)
          else this.goals.splice(index, 1, saved)
          this.closeGoalDialog()
          LNbitsBridge.notify('Goal saved.', 'positive').catch(() => {})
        } catch (error) { this.formError = error.message }
        finally { this.saving = false }
      },
      confirmDelete(goal) { this.deleteDialog = {show: true, loading: false, goal} },
      async deleteGoal() { if (!this.deleteDialog.goal) return; this.deleteDialog.loading = true; try { await this.api('DELETE', `/goals/${this.deleteDialog.goal.id}`); this.goals = this.goals.filter(goal => goal.id !== this.deleteDialog.goal.id); this.deleteDialog.show = false } catch (error) { await LNbitsBridge.notify(error.message, 'negative') } finally { this.deleteDialog.loading = false } },
      publicUrl(goal) { return `${location.origin}/ext/zapgoalswasm/public/${goal.id}` },
      embedScriptUrl(goal) { return `${location.origin}/ext-assets/zapgoalswasm/js/embed.js` },
      openPublic(goal) { LNbitsBridge.openInNewTab(this.publicUrl(goal)) },
      async copyPublicUrl(goal) { try { await navigator.clipboard.writeText(this.publicUrl(goal)); await LNbitsBridge.notify('Public link copied.', 'positive') } catch (_) { await LNbitsBridge.notify('Clipboard access is unavailable. Open the public page and copy its URL.', 'warning') } },
      openEmbedDialog(goal) { this.embedDialog = {show: true, goal} },
      async copyEmbedSnippet(snippet) { try { await navigator.clipboard.writeText(snippet); await LNbitsBridge.notify('Embed snippet copied.', 'positive') } catch (_) { await LNbitsBridge.notify('Clipboard access is unavailable. Copy the snippet text manually.', 'warning') } },
      async openPeriodsDialog(goal) { this.periodsDialog = {show: true, goal, periods: []}; try { const result = await this.api('GET', `/goals/${goal.id}/periods`); this.periodsDialog.periods = result.data || [] } catch (error) { await LNbitsBridge.notify(error.message, 'negative') } },
      formatSats(value) { return `${Number(value || 0).toLocaleString()} sats` },
      formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value)) : '—' },
      toLocalDateTime(value) { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) },
      goalStatus(goal) { if (Number(goal.currentAmount) >= Number(goal.goalAmount)) return 'Funded'; if (new Date(goal.targetDate).getTime() <= Date.now()) return 'Ended'; return 'Active' }
    },
    async mounted() { this.initTheme(); try { await LNbitsBridge.connect(); await this.load(); setInterval(() => { if (!document.hidden) this.load() }, 10000) } catch (error) { this.loadError = error.message } finally { document.getElementById('q-app')?.classList.remove('vue-pending') } }
  })
  app.use(Quasar, {config: {notify: {}}})
  window.ZapGoalsApp = app.mount('#q-app')
})()
