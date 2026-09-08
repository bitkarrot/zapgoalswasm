// Offline invoice lifecycle regressions. Every API, bridge, clock and timer is
// mocked: these tests cannot create a live invoice or make a payment.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return {promise, resolve, reject}
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const invoice = letter => ({paymentHash: letter.repeat(64), paymentRequest: `offline-only-invoice-${letter}`})

function setup(script = 'public') {
  let options, nextTimer = 0, nextInvoice = 0
  const timers = new Map()
  const intervals = new Map()
  const receiptStatus = {paid: false}
  const calls = {api: [], subscribed: [], unsubscribed: [], notified: [], removedListeners: 0}
  const goal = {id: 'test-goal', title: 'Offline fixture', walletMode: 'all', currentAmount: 10, goalAmount: 100, targetDate: '2030-01-01T00:00:00Z', periodIndex: 0}
  const context = {
    Vue: {createApp(value) { options = value; return {use() {}, mount() {}} }},
    Quasar: {},
    window: {ZAPGOALS_PUBLIC_RENDER: () => () => {}, ZAPGOALS_INDEX_RENDER: () => () => {}},
    document: {hidden: false, getElementById() { return {classList: {remove() {}}} }},
    location: {origin: 'https://offline.invalid'},
    LNbitsBridge: {
      connect: async () => ({routeParams: {goalId: goal.id}}),
      onEvent() { return () => { calls.removedListeners++ } },
      async callApi(method, url, body) {
        calls.api.push({method, url, body})
        if (url.includes('/payments/')) return {...receiptStatus}
        return method === 'POST' ? invoice(String(++nextInvoice)) : {...goal}
      },
      async subscribePayment(hash, id) { calls.subscribed.push({hash, id}) },
      async unsubscribePayment(id) { calls.unsubscribed.push(id) },
      async notify(message, type) { calls.notified.push({message, type}) }
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay, cleared: false}); return id },
    clearTimeout(id) { if (timers.has(id)) timers.get(id).cleared = true },
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, {fn, delay, cleared: false}); return id },
    clearInterval(id) { if (intervals.has(id)) intervals.get(id).cleared = true },
    fetch() { throw new Error('Direct network access is forbidden in invoice lifecycle tests') }
  }
  vm.runInNewContext(read(`static/js/${script}.js`), context)
  const app = options.data()
  for (const [name, method] of Object.entries(options.methods)) app[name] = method.bind(app)
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(app, name, {get: getter.bind(app)})
  app.initTheme = () => {}
  app.applyGoalDesign = () => {}
  app.goalId = goal.id
  app.goal = {...goal}
  app.amount = 21
  app.amountDialog = true
  return {app, calls, context, timers, intervals, options, goal, receiptStatus,
    settle: () => { receiptStatus.paid = true; return app.onBridgeEvent({event: 'payment.settled', subscriptionId: app.subscriptionId, data: {pending: false, status: 'success'}}) },
    unmount: () => options.beforeUnmount.call(app)}
}

test('invoice amount, goal and comment are immutable; payment never increments the displayed total', async () => {
  const {app, calls, context, settle} = setup()
  const pending = deferred()
  const originalApi = context.LNbitsBridge.callApi
  context.LNbitsBridge.callApi = async (method, url, body) => { if (url.includes('/payments/')) return originalApi(method, url, body); calls.api.push({method, url, body}); return pending.promise }
  app.comment = '  original comment  '
  const work = app.createInvoice()
  const attempt = app.activeAttempt
  assert.equal(app.paymentState, 'creating')
  assert.equal(Object.isFrozen(attempt), true)
  assert.equal(calls.api[0].body.amount, 21)
  app.amount = 500
  app.comment = 'changed'
  app.selectAmount(1000)
  assert.equal(app.amount, 500, 'suggested buttons also refuse edits during creation')
  await app.createInvoice()
  assert.equal(calls.api.length, 1, 'duplicate creation is blocked')
  pending.resolve(invoice('a'))
  await work
  assert.equal(app.invoice.amount, 21)
  assert.equal(Object.isFrozen(app.invoice), true)
  assert.equal(attempt.comment, 'original comment')
  assert.equal(attempt.goalId, 'test-goal')
  await settle()
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.goal.currentAmount, 10)
  assert.equal(app.invoiceDialog, true)
})

test('QR is exposed before a slow subscription finishes', async () => {
  const {app, context} = setup()
  const subscription = deferred()
  context.LNbitsBridge.subscribePayment = () => subscription.promise
  const work = app.createInvoice()
  await flush()
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.creatingInvoice, false)
  assert.ok(app.invoice.paymentRequest)
  subscription.resolve()
  await work
})

test('subscription rejection retains the usable invoice and retry does not create a second invoice', async () => {
  const {app, context, calls, settle} = setup()
  context.LNbitsBridge.subscribePayment = async (hash, id) => { calls.subscribed.push({hash, id}); throw new Error('offline monitor failure') }
  await app.createInvoice()
  const firstId = calls.subscribed[0].id
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.subscriptionId, '')
  assert.match(app.monitoringError, /still payable/)
  assert.equal(calls.notified.length, 0, 'monitoring error is not reported as invoice creation failure')
  context.LNbitsBridge.subscribePayment = async (hash, id) => { calls.subscribed.push({hash, id}) }
  await app.watchInvoice()
  assert.notEqual(app.subscriptionId, firstId)
  assert.equal(app.monitoringError, '')
  assert.equal(calls.api.filter(call => call.method === 'POST').length, 1)
  await settle()
  assert.equal(app.paymentState, 'paid')
})

test('settlement arriving before subscribe resolves stays paid and cleans the late subscription', async () => {
  const {app, context, calls, settle} = setup()
  context.LNbitsBridge.subscribePayment = async (hash, id) => { calls.subscribed.push({hash, id}); await settle() }
  await app.createInvoice()
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.subscriptionId, '')
  assert.ok(calls.unsubscribed.includes(calls.subscribed[0].id))
  assert.equal(app.goal.currentAmount, 10)
})

test('socket event contents cannot confirm payment without a verified receipt', async () => {
  const {app, receiptStatus} = setup()
  await app.createInvoice()
  const id = app.subscriptionId
  for (const message of [
    {event: 'payment.update', subscriptionId: id, data: {pending: true, status: 'success'}},
    {event: 'payment.update', subscriptionId: id, data: {pending: false, status: 'failed'}},
    {event: 'payment.update', subscriptionId: id, data: {status: 'success'}},
    {event: 'unrelated.event', subscriptionId: id},
    {event: 'payment.settled', subscriptionId: 'another-subscription'},
    {event: 'payment.settled', subscriptionId: id, data: {payment_hash: 'wrong-hash'}}
  ]) await app.onBridgeEvent(message)
  assert.equal(app.paymentState, 'pending')
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId: id, data: {paid: true, pending: false, status: 'success'}})
  assert.equal(app.paymentState, 'pending', 'a forged settled event is not a verified receipt')
  receiptStatus.paid = true
  await app.onBridgeEvent({event: 'payment.update', subscriptionId: id, data: {pending: true, status: 'pending'}})
  assert.equal(app.paymentState, 'paid', 'even a pending wakeup is sufficient once the receiver verifies the receipt')
})

test('duplicate and stale settlement callbacks cannot complete a subsequent invoice, even with a reused hash', async () => {
  const {app, context, settle, timers} = setup()
  const originalApi = context.LNbitsBridge.callApi
  context.LNbitsBridge.callApi = async (method, ...args) => method === 'POST' ? invoice('a') : originalApi(method, ...args)
  await app.createInvoice()
  const firstAttempt = app.activeAttempt
  const firstId = app.subscriptionId
  await settle()
  await app.checkInvoiceStatus(firstAttempt)
  assert.equal([...timers.values()].filter(timer => !timer.cleared).length, 1)
  app.finishPayment()
  app.amount = 1
  await app.createInvoice()
  assert.notEqual(app.subscriptionId, firstId)
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId: firstId})
  await app.checkInvoiceStatus(firstAttempt)
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.invoice.amount, 1)
})

test('A → Done → B → A queued refresh cannot detach B or load stale progress', async () => {
  const {app, calls, settle, timers} = setup()
  await app.createInvoice()
  await settle()
  const timerId = app.authoritativeRetryTimer
  const staleTimer = timers.get(timerId).fn
  app.finishPayment()
  assert.equal(timers.get(timerId).cleared, true)
  app.amount = 1
  await app.createInvoice()
  const secondId = app.subscriptionId
  const callCount = calls.api.length
  await staleTimer() // A timer may already have been queued before clearTimeout.
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.subscriptionId, secondId)
  assert.equal(calls.api.length, callCount)
  assert.equal(calls.unsubscribed.includes(secondId), false)
})

test('an in-flight old authoritative refresh cannot modify or unsubscribe a newer attempt', async () => {
  const {app, context, settle, timers, calls} = setup()
  await app.createInvoice()
  await settle()
  const pending = deferred()
  const originalApi = context.LNbitsBridge.callApi
  context.LNbitsBridge.callApi = (method, ...args) => method === 'GET' ? pending.promise : originalApi(method, ...args)
  const refresh = timers.get(app.authoritativeRetryTimer).fn()
  app.finishPayment()
  app.amount = 1
  await app.createInvoice()
  const secondId = app.subscriptionId
  pending.resolve({...app.goal, currentAmount: 999})
  await refresh
  assert.equal(app.goal.currentAmount, 10)
  assert.equal(app.subscriptionId, secondId)
  assert.equal(app.paymentState, 'pending')
  assert.equal(calls.unsubscribed.includes(secondId), false)
  assert.equal(app.authoritativeRetryTimer, null)
})

test('authoritative lower totals and rollover are applied; older polls cannot overwrite a newer refresh', async () => {
  const {app, context, settle, timers} = setup()
  await app.createInvoice()
  const oldPoll = deferred(), fresh = deferred()
  let requests = 0
  const originalApi = context.LNbitsBridge.callApi
  context.LNbitsBridge.callApi = (method, url) => url.includes('/payments/') ? originalApi(method, url) : ++requests === 1 ? oldPoll.promise : fresh.promise
  const oldWork = app.loadGoal(true, true)
  await settle()
  const refresh = timers.get(app.authoritativeRetryTimer).fn()
  fresh.resolve({...app.goal, currentAmount: 0, percent: 0, periodIndex: 1})
  await refresh
  assert.equal(app.goal.currentAmount, 0)
  assert.equal(app.goal.periodIndex, 1)
  oldPoll.resolve({...app.goal, currentAmount: 900, periodIndex: 0})
  await oldWork
  assert.equal(app.goal.currentAmount, 0)
  assert.equal(app.goal.periodIndex, 1)
})

test('other donors raising aggregate progress never marks this pending invoice paid', async () => {
  const {app, context} = setup()
  await app.createInvoice()
  context.LNbitsBridge.callApi = async () => ({...app.goal, currentAmount: 1000})
  const id = app.subscriptionId
  await app.loadGoal(true, true)
  assert.equal(app.goal.currentAmount, 1000)
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.subscriptionId, id)
})

test('closing a pending creation invalidates its response without clearing the next request busy state', async () => {
  const {app, context, calls} = setup()
  const first = deferred(), second = deferred()
  let requests = 0
  context.LNbitsBridge.callApi = () => ++requests === 1 ? first.promise : second.promise
  const firstWork = app.createInvoice()
  app.onAmountDialogChange(false)
  app.openAmountDialog()
  app.amount = 2
  const secondWork = app.createInvoice()
  first.resolve(invoice('a'))
  await firstWork
  assert.equal(app.creatingInvoice, true)
  assert.equal(app.invoice, null)
  assert.equal(calls.subscribed.length, 0)
  second.resolve(invoice('b'))
  await secondWork
  assert.equal(app.invoice.paymentHash, 'b'.repeat(64))
  assert.equal(app.invoice.amount, 2)
  assert.equal(calls.subscribed.length, 1)
})

test('a rejected canceled creation does not report failure in the next dialog', async () => {
  const {app, context, calls} = setup()
  const pending = deferred()
  context.LNbitsBridge.callApi = () => pending.promise
  const work = app.createInvoice()
  app.closeAmountDialog()
  app.openAmountDialog()
  pending.reject(new Error('old failure'))
  await work
  assert.equal(app.amountDialog, true)
  assert.equal(app.paymentState, 'idle')
  assert.equal(calls.notified.length, 0)
})

for (const outcome of ['resolve', 'reject']) test(`late subscribe ${outcome} after closing A cleans only A, never B`, async () => {
  const {app, context, calls} = setup()
  const first = deferred()
  let subscriptions = 0
  context.LNbitsBridge.subscribePayment = (hash, id) => { calls.subscribed.push({hash, id}); return ++subscriptions === 1 ? first.promise : Promise.resolve() }
  const work = app.createInvoice()
  await flush()
  const oldId = app.subscriptionId
  app.closeInvoice()
  app.amount = 2
  await app.createInvoice()
  const newId = app.subscriptionId
  if (outcome === 'resolve') first.resolve()
  else first.reject(new Error('stale monitoring failure'))
  await work
  assert.equal(app.subscriptionId, newId)
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.monitoringError, '')
  assert.equal(calls.unsubscribed.filter(id => id === oldId).length, 2)
  assert.equal(calls.unsubscribed.includes(newId), false)
})

test('unmount during invoice creation prevents a late invoice from opening or subscribing', async () => {
  const {app, context, calls, unmount} = setup()
  const pending = deferred()
  context.LNbitsBridge.callApi = () => pending.promise
  const work = app.createInvoice()
  unmount()
  pending.resolve(invoice('a'))
  await work
  assert.equal(app.invoiceDialog, false)
  assert.equal(app.invoice, null)
  assert.equal(app.paymentState, 'idle')
  assert.equal(calls.subscribed.length, 0)
})

test('unmount during subscribe cleans the subscription again if it completes late', async () => {
  const {app, context, calls, unmount} = setup()
  const pending = deferred()
  context.LNbitsBridge.subscribePayment = () => pending.promise
  const work = app.createInvoice()
  await flush()
  const id = app.subscriptionId
  unmount()
  pending.resolve()
  await work
  assert.equal(calls.unsubscribed.filter(value => value === id).length, 2)
  assert.equal(app.invoiceDialog, false)
  assert.equal(app.subscriptionId, '')
})

test('unmount during bridge connection does not install listeners, load goals or start intervals', async () => {
  const {app, options, context, calls, intervals, unmount} = setup()
  const pending = deferred()
  context.LNbitsBridge.connect = () => pending.promise
  const work = options.mounted.call(app)
  unmount()
  pending.resolve({routeParams: {goalId: 'late-goal'}})
  await work
  assert.equal(calls.api.length, 0)
  assert.equal(intervals.size, 0)
  assert.equal(app.removeBridgeListener, null)
})

test('polling continues on the receipt; unmount removes all intervals, timers and listeners', async () => {
  const {app, options, context, intervals, timers, settle, calls, unmount} = setup()
  await options.mounted.call(app)
  assert.equal(intervals.size, 2)
  await app.createInvoice()
  await settle()
  const retry = app.authoritativeRetryTimer
  context.LNbitsBridge.callApi = async () => ({...app.goal, currentAmount: 0, periodIndex: 1})
  app.lastGoalLoad = 0
  intervals.get(app.pollTimer).fn()
  await app.loadInFlight
  assert.equal(app.goal.currentAmount, 0)
  assert.equal(app.paymentState, 'paid')
  unmount()
  assert.equal(timers.get(retry).cleared, true)
  assert.ok([...intervals.values()].every(timer => timer.cleared))
  assert.equal(calls.removedListeners, 1)
  await timers.get(retry).fn()
  assert.equal(app.authoritativeRetryTimer, null)
})

test('unmount invalidates an in-flight goal response and prevents branding changes', async () => {
  const {app, context, unmount} = setup()
  const pending = deferred()
  let designs = 0
  app.applyGoalDesign = () => { designs++ }
  context.LNbitsBridge.callApi = () => pending.promise
  const work = app.loadGoal(true, true)
  unmount()
  pending.resolve({...app.goal, currentAmount: 999})
  await work
  assert.equal(app.goal.currentAmount, 10)
  assert.equal(designs, 0)
})

test('ended goals cannot open payment or invoice even when the rendered clock is stale', async () => {
  const {app, calls} = setup()
  app.goal.targetDate = '2020-01-01T00:00:00Z'
  app.now = new Date('2019-01-01T00:00:00Z').getTime()
  app.amountDialog = false
  app.openAmountDialog()
  await app.createInvoice()
  assert.equal(app.amountDialog, false)
  assert.equal(calls.api.length, 0)
  assert.equal(app.paymentState, 'idle')
})

test('fractional, unsafe, non-positive and excessive amounts are rejected before invoice creation', async () => {
  const {app, calls} = setup()
  for (const amount of [0, -1, 1.1, NaN, Infinity, 2100000001, Number.MAX_SAFE_INTEGER + 1]) {
    app.amount = amount
    await app.createInvoice()
  }
  assert.equal(calls.api.length, 0)
})

test('public template is invoice-only, disables editing, and uses immediate model changes rather than delayed hide callbacks', () => {
  const source = read('static/js/public.js')
  const template = read('templates/public.html')
  assert.doesNotMatch(source + template, /bitcoin.?connect|storage-shim|applyOptimisticPayment|walletMode/i)
  assert.match(template, /qrcode-vue/)
  assert.match(template, /v-model.number="amount" :disable="creatingInvoice"/)
  assert.match(template, /v-model="comment" :disable="creatingInvoice"/)
  assert.match(template, /@update:model-value="onInvoiceDialogChange"/)
  assert.doesNotMatch(template, /@hide="closeInvoice"/)
})

test('new and legacy edited goals always send vanilla with no payment selector or iframe snippet', async () => {
  const {app, context, calls} = setup('index')
  app.wallets = [{id: 'wallet', name: 'Offline wallet'}]
  context.LNbitsBridge.callApi = async (method, url, body) => { calls.api.push({method, url, body}); return {...body, id: 'saved-goal'} }
  for (const existing of [null, {id: 'old-goal', walletId: 'wallet', walletMode: 'all', suggestedAmounts: '[21]', targetDate: '2030-01-01T00:00:00Z'}]) {
    app.openGoalDialog(existing)
    Object.assign(app.formDialog.data, {title: 'Offline goal', targetDate: '2030-01-01T00:00', goalAmount: 100, walletMode: 'all'})
    await app.saveGoal()
    assert.equal(calls.api.at(-1).body.walletMode, 'vanilla')
    if (!existing) {
      assert.equal(calls.api.at(-1).body.walletId, 'wallet')
      assert.equal(calls.api.at(-1).body.recurring, false)
    } else {
      assert.equal('walletId' in calls.api.at(-1).body, false)
      assert.equal('recurring' in calls.api.at(-1).body, false)
    }
  }
  const source = read('static/js/index.js')
  const template = read('templates/index.html')
  assert.doesNotMatch(source + template, /bitcoin.?connect|\bmodeOptions\b|embedIframeSnippet|Wallet payment mode|<iframe/i)
  assert.match(template, /JavaScript widget snippet/)
  assert.doesNotMatch(template, /LNURL-pay endpoint/)
})

test('fixed-calendar period history is read-only, with allocation, rollover and retained excess', async () => {
  const {app, context, calls} = setup('index')
  const period = {id: 'period-0', movedAmount: 100, rolloverAmount: 0, retainedAmount: 21}
  context.LNbitsBridge.callApi = async (method, url) => { calls.api.push({method, url}); return {data: [period]} }
  await app.openPeriodsDialog({id: 'goal', recurring: true})
  assert.equal(calls.api[0].method, 'GET')
  assert.equal(calls.api[0].url, '/api/v1/ext/zapgoalswasm/goals/goal/periods')
  assert.equal(app.periodColumns.find(column => column.name === 'recorded').label, 'Recorded allocation (no transfer)')
  assert.equal(app.periodColumns.find(column => column.name === 'retained').field(period), '21 sats')
  const template = read('templates/index.html')
  assert.match(template, /Periods advance automatically on the fixed calendar/)
  assert.doesNotMatch(template + read('static/js/index.js'), /sweepGoal|confirmSweep|sweepDialog|Close period|scheduler extension/)
})


test('admin rejects invalid dates locally and can open legacy invalid-date goals for correction', async () => {
  const {app, calls} = setup('index')
  app.wallets = [{id: 'wallet', name: 'Offline wallet'}]
  app.openGoalDialog({id: 'old-goal', title: 'Old goal', goalAmount: 100, walletId: 'wallet', suggestedAmounts: '[21]', targetDate: 'not-a-date'})
  assert.equal(app.formDialog.data.targetDate, '')
  app.formDialog.data.targetDate = 'not-a-date'
  await app.saveGoal()
  assert.equal(calls.api.length, 0)
  assert.match(app.formError, /valid values/)
})

test('untrusted socket success cannot confirm while durable receipt is absent or non-boolean', async () => {
  const {app, receiptStatus, calls} = setup()
  await app.createInvoice()
  const id = app.subscriptionId
  for (const paid of [false, undefined, 'true', 1]) {
    receiptStatus.paid = paid
    await app.onBridgeEvent({event: 'payment.settled', subscriptionId: id, data: {pending: false, status: 'success', paid: true}})
    assert.equal(app.paymentState, 'pending')
    assert.equal(app.goal.currentAmount, 10)
  }
  const checks = calls.api.filter(call => call.url.includes('/payments/'))
  assert.equal(checks.length, 4)
  assert.ok(checks.every(call => call.url === `/api/v1/ext/zapgoalswasm/goals/test-goal/payments/${app.invoice.paymentHash}`))
  receiptStatus.paid = true
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId: id})
  assert.equal(app.paymentState, 'paid')
})

test('receipt polling confirms without any socket event even after subscription failure', async () => {
  const {app, context, receiptStatus, timers} = setup()
  context.LNbitsBridge.subscribePayment = async () => { throw new Error('socket unavailable') }
  await app.createInvoice()
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.subscriptionId, '')
  await timers.get(app.receiptPollTimer).fn()
  assert.equal(app.paymentState, 'pending')
  const next = timers.get(app.receiptPollTimer)
  assert.equal(next.delay, 3000)
  receiptStatus.paid = true
  await next.fn()
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.monitoringError, '')
  assert.equal(app.receiptPollTimer, null)
  assert.equal(app.goal.currentAmount, 10)
})

test('receipt API failures keep QR usable and schedule another authoritative check', async () => {
  const {app, context, timers} = setup()
  await app.createInvoice()
  context.LNbitsBridge.callApi = async () => { throw new Error('receiver temporarily unavailable') }
  await app.checkInvoiceStatus()
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.paymentState, 'pending')
  assert.match(app.receiptError, /keep checking/)
  context.LNbitsBridge.callApi = async () => ({paid: true})
  await timers.get(app.receiptPollTimer).fn()
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.receiptError, '')
})

test('socket wakeups coalesce during one receipt check, without trusting their paid claims', async () => {
  const {app, context} = setup()
  await app.createInvoice()
  const pending = deferred()
  let requests = 0
  context.LNbitsBridge.callApi = () => { requests++; return pending.promise }
  const first = app.onBridgeEvent({event: 'payment.settled', subscriptionId: app.subscriptionId})
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId: app.subscriptionId, data: {paid: true}})
  await app.checkInvoiceStatus()
  assert.equal(requests, 1)
  assert.equal(app.paymentState, 'pending')
  pending.resolve({paid: false})
  await first
  assert.equal(app.paymentState, 'pending')
})

test('a timed-out receipt check cannot stop polling or later turn a pending invoice into a false receipt', async () => {
  const {app, context, timers} = setup()
  await app.createInvoice()
  const hung = deferred()
  context.LNbitsBridge.callApi = () => hung.promise
  const checking = app.checkInvoiceStatus()
  const timeout = timers.get(app.receiptRequestTimer)
  assert.equal(timeout.delay, 10000)
  timeout.fn()
  await checking
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.receiptCheck, null)
  assert.ok(app.receiptPollTimer)
  context.LNbitsBridge.callApi = async () => ({paid: false})
  await timers.get(app.receiptPollTimer).fn()
  hung.resolve({paid: true})
  await flush()
  assert.equal(app.paymentState, 'pending', 'the timed-out response cannot complete its obsolete check')
})

test('A receipt response and queued poll after closing A cannot mark or detach B', async () => {
  const {app, context, timers, calls} = setup()
  await app.createInvoice()
  const oldTimer = timers.get(app.receiptPollTimer).fn
  const originalApi = context.LNbitsBridge.callApi
  const old = deferred(), current = deferred()
  let checks = 0
  context.LNbitsBridge.callApi = (method, url, body) => url.includes('/payments/') ? (++checks === 1 ? old.promise : current.promise) : originalApi(method, url, body)
  const oldCheck = app.checkInvoiceStatus()
  app.closeInvoice()
  app.amount = 2
  await app.createInvoice()
  const currentId = app.subscriptionId
  const currentCheck = app.checkInvoiceStatus()
  const activeCheck = app.receiptCheck
  await oldTimer()
  old.resolve({paid: true})
  await oldCheck
  assert.equal(checks, 2)
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.subscriptionId, currentId)
  assert.equal(app.receiptCheck, activeCheck)
  assert.equal(calls.unsubscribed.includes(currentId), false)
  current.resolve({paid: true})
  await currentCheck
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.invoice.amount, 2)
})

test('unmount invalidates receipt checks and clears polling/request timeouts', async () => {
  const {app, context, timers, unmount} = setup()
  await app.createInvoice()
  const pending = deferred()
  context.LNbitsBridge.callApi = () => pending.promise
  const work = app.checkInvoiceStatus()
  unmount()
  assert.ok([...timers.values()].every(timer => timer.cleared))
  pending.resolve({paid: true})
  await work
  assert.equal(app.paymentState, 'idle')
  assert.equal(app.invoiceDialog, false)
  assert.equal(app.receiptPollTimer, null)
  assert.equal(app.receiptCheck, null)
})

test('recurring PUT omits locked rules and read-only accounting projections', async () => {
  const {app, context, calls} = setup('index')
  app.wallets = [{id: 'wallet', name: 'Offline wallet'}]
  app.openGoalDialog()
  const original = {...app.formDialog.data, suggestedAmounts: '[21,100,500,1000]', id: 'fixed-goal', title: 'Recurring goal', recurring: true, targetDate: '2030-01-01T13:14:15.678Z', currentAmount: 99, periodIndex: 2, periodEndDate: '2030-03-01T13:14:15.678Z', accountingVersion: 2, accountingTotals: {received: 99}, totals: {received: 99}, accountingOnly: true, legacyOpeningUnverified: 8}
  app.openGoalDialog(original)
  assert.equal(app.financialRulesLocked, true)
  Object.assign(app.formDialog.data, {walletId: 'other', recurring: false, goalAmount: 1, targetDate: '2040-01-01T00:00', recurrenceUnit: 'day', recurrenceInterval: 99, recurrenceDayOfMonth: 3, targetWalletId: 'other', sweepMode: 'entire_amount', rolloverMode: 'reset_to_zero', title: 'Edited presentation'})
  context.LNbitsBridge.callApi = async (method, url, body) => { calls.api.push({method, url, body}); return {...body, id: original.id} }
  await app.saveGoal()
  const payload = calls.api[0].body
  for (const key of ['walletId', 'recurring', 'goalAmount', 'targetDate', 'recurrenceUnit', 'recurrenceInterval', 'recurrenceDayOfMonth', 'targetWalletId', 'sweepMode', 'rolloverMode']) assert.equal(key in payload, false, key)
  assert.equal(payload.title, 'Edited presentation')
  assert.equal('currentAmount' in payload, false)
  assert.equal('periodIndex' in payload, false)
  assert.equal('periodEndDate' in payload, false)
  for (const key of ['accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) assert.equal(key in payload, false, key)
  const template = read('templates/index.html')
  assert.match(template, /Financial rules are fixed after creation\. Create a new goal to change them\./)
  for (const key of ['goalAmount', 'targetDate', 'recurrenceUnit', 'recurrenceInterval', 'recurrenceDayOfMonth', 'targetWalletId', 'sweepMode', 'rolloverMode']) assert.ok(template.includes(`="formDialog.data.${key}" :disable="financialRulesLocked"`), key)
  assert.match(template, /v-model="formDialog.data.recurring" :disable="formDialog.editing"/)
})

test('ordinary goal edits keep recurrence and receiving wallet fixed but allow amount/date edits', async () => {
  const {app, context, calls} = setup('index')
  app.wallets = [{id: 'wallet', name: 'Offline wallet'}]
  app.openGoalDialog()
  assert.equal(app.financialRulesLocked, false)
  const original = {...app.formDialog.data, suggestedAmounts: '[21,100,500,1000]', id: 'ordinary-goal', title: 'Ordinary goal', targetDate: '2030-01-01T00:00:00Z'}
  app.openGoalDialog(original)
  assert.equal(app.financialRulesLocked, false)
  Object.assign(app.formDialog.data, {walletId: 'other', recurring: true, goalAmount: 55, targetDate: '2031-01-01T00:00'})
  context.LNbitsBridge.callApi = async (method, url, body) => { calls.api.push({method, url, body}); return {...body, id: original.id} }
  await app.saveGoal()
  assert.equal('recurring' in calls.api[0].body, false)
  assert.equal('walletId' in calls.api[0].body, false)
  assert.equal(calls.api[0].body.goalAmount, 55)
  assert.equal(new Date(calls.api[0].body.targetDate).getTime(), new Date('2031-01-01T00:00').getTime())
})

test('archive action retains compatible DELETE request and removes only the archived active row', async () => {
  const {app, context, calls} = setup('index')
  app.goals = [{id: 'archived-goal'}, {id: 'keep-goal'}]
  context.LNbitsBridge.callApi = async (method, url) => { calls.api.push({method, url}); return {archived: true} }
  app.confirmDelete(app.goals[0])
  await app.deleteGoal()
  assert.equal(calls.api[0].method, 'DELETE')
  assert.equal(calls.api[0].url, '/api/v1/ext/zapgoalswasm/goals/archived-goal')
  assert.equal(app.goals.length, 1)
  assert.equal(app.goals[0].id, 'keep-goal')
  const template = read('templates/index.html')
  assert.match(template, /Archive goal/)
  assert.match(template, /Existing payment and accounting records are retained/)
  assert.doesNotMatch(template, /Delete goal|This cannot be undone|label="Delete"|icon="delete"/)
})


test('archived or invalid-date public goals cannot create a new invoice', async () => {
  for (const fields of [{archived: true}, {status: 'archived'}, {targetDate: 'not-a-date'}]) {
    const {app, calls} = setup()
    Object.assign(app.goal, fields)
    app.amountDialog = false
    app.openAmountDialog()
    assert.equal(app.isEnded, true)
    assert.equal(app.amountDialog, false)
    await app.createInvoice()
    assert.equal(calls.api.filter(call => call.method === 'POST').length, 0)
  }
})
