const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function setup() {
  let options, callbacks
  const calls = {closed: 0, refreshed: 0, unsubscribed: 0, launched: 0}
  const bitcoinConnect = {
    init() {},
    launchPaymentModal(args) {
      callbacks = args
      calls.launched++
      return {setPaid() { throw new Error('Closure must not require a preimage') }}
    },
    closeModal() {
      calls.closed++
      callbacks?.onCancelled()
    }
  }
  const context = {
    Vue: {createApp(value) { options = value; return {use() {}, mount() {}} }},
    Quasar: {},
    window: {ZAPGOALS_PUBLIC_RENDER: () => () => {}, ZapGoalsBitcoinConnect: bitcoinConnect},
    LNbitsBridge: {
      subscribePayment: async () => {},
      unsubscribePayment: async () => { calls.unsubscribed++ },
      notify: async () => {}
    },
    fetch() { throw new Error('Modal closure must not fetch payment preimages') },
    setTimeout() { throw new Error('Modal closure must not wait for retries') },
    clearTimeout() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/public.js'), 'utf8'), context)
  const app = options.data()
  for (const [name, method] of Object.entries(options.methods)) app[name] = method.bind(app)
  app.goalId = 'test-goal'
  app.goal = {walletMode: 'all', currentAmount: 10, goalAmount: 100}
  app.amount = 21
  app.api = async () => ({paymentHash: 'a'.repeat(64), paymentRequest: 'test-only-invoice'})
  app.scheduleAuthoritativeRefresh = () => { calls.refreshed++ }
  return {app, calls, context, callbacks: () => callbacks}
}

for (const source of ['bitcoin-connect', 'settled']) {
  test(`${source} immediately closes confirmation, without needing a preimage`, async () => {
    const {app, calls, callbacks} = setup()
    await app.createInvoice()
    assert.equal(calls.launched, 1)
    if (source === 'bitcoin-connect') await callbacks().onPaid()
    else await app.onBridgeEvent({event: 'payment.settled', subscriptionId: app.subscriptionId, data: {pending: false, status: 'success'}})
    assert.equal(calls.closed, 1)
    assert.equal(calls.unsubscribed, 1)
    assert.equal(app.bitcoinConnectPayment, null)
    assert.equal(app.paymentState, 'paid')
    assert.equal(app.goal.currentAmount, 31)
    assert.equal(app.invoiceDialog, true)
  })
}

test('duplicate settlement and late wallet/cancel callbacks cannot reopen a finished payment', async () => {
  const {app, calls, callbacks} = setup()
  await app.createInvoice()
  const subscriptionId = app.subscriptionId
  await app.markPaid()
  app.finishPayment()
  await callbacks().onPaid()
  callbacks().onCancelled()
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId})
  assert.equal(app.paymentState, 'idle')
  assert.equal(app.invoiceDialog, false)
  assert.equal(calls.closed, 1)
  assert.equal(calls.refreshed, 1)
})

test('callbacks from an old invoice cannot mark a new invoice paid or reopen its dialog', async () => {
  const {app, calls, callbacks} = setup()
  await app.createInvoice()
  const previous = callbacks()
  await app.markPaid()
  app.finishPayment()
  app.amount = 1
  app.api = async () => ({paymentHash: 'b'.repeat(64), paymentRequest: 'second-test-invoice'})
  await app.createInvoice()
  await previous.onPaid()
  previous.onCancelled()
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.invoiceDialog, false)
  assert.equal(calls.closed, 1)
})

test('manual cancellation still opens the unpaid QR fallback', async () => {
  const {app, callbacks} = setup()
  await app.createInvoice()
  callbacks().onCancelled()
  assert.equal(app.paymentState, 'pending')
  assert.equal(app.invoiceDialog, true)
  assert.equal(app.bitcoinConnectPayment, null)
  assert.ok(app.subscriptionId)
})

for (const stage of ['subscription', 'wallet loading']) {
  test(`settlement during ${stage} does not launch a confirmation for an already paid invoice`, async () => {
    const {app, calls, context} = setup()
    if (stage === 'subscription') context.LNbitsBridge.subscribePayment = async () => { await app.markPaid() }
    else app.ensureBitcoinConnect = async () => { await app.markPaid(); return context.window.ZapGoalsBitcoinConnect }
    await app.createInvoice()
    assert.equal(app.paymentState, 'paid')
    assert.equal(app.invoiceDialog, true)
    assert.equal(calls.launched, 0)
    assert.equal(app.creatingInvoice, false)
  })
}

test('pending, failed, and unrelated bridge events never close the confirmation', async () => {
  const {app, calls} = setup()
  await app.createInvoice()
  await app.onBridgeEvent({event: 'payment.update', subscriptionId: app.subscriptionId, data: {pending: true, status: 'pending'}})
  await app.onBridgeEvent({event: 'payment.update', subscriptionId: app.subscriptionId, data: {pending: false, status: 'failed'}})
  await app.onBridgeEvent({event: 'payment.settled', subscriptionId: 'another-payment'})
  assert.equal(app.paymentState, 'pending')
  assert.equal(calls.closed, 0)
})

test('QR-only payment still shows success and cleans up the subscription', async () => {
  const {app, calls} = setup()
  app.goal.walletMode = 'vanilla'
  await app.createInvoice()
  await app.onBridgeEvent({event: 'payment.update', subscriptionId: app.subscriptionId, data: {pending: false, status: 'success'}})
  assert.equal(app.paymentState, 'paid')
  assert.equal(app.invoiceDialog, true)
  assert.equal(calls.closed, 0)
  assert.equal(calls.unsubscribed, 1)
})
