/*
 * Safe, browser-level regression tests for the real sandbox + Bitcoin Connect bundle.
 * Run ONLY this spec (the older e2e scripts make real payments):
 *   npx playwright test tests/payment-dialog.spec.cjs --workers=1
 *
 * Defaults to the local LNbits server and serves public.js from this checkout.
 * Optional: LNBITS_PAYMENT_TEST_BASE_URL, LNBITS_PAYMENT_TEST_GOAL_ID,
 * LNBITS_PAYMENT_TEST_DEPLOYED=1 (exercise deployed public.js instead), or
 * LNBITS_PAYMENT_TEST_SOURCE_REF=HEAD (serve a git revision to verify regression).
 * No login, real invoices, wallet credentials, or database writes are needed.
 */
const {test: base, expect} = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const baseURL = (process.env.LNBITS_PAYMENT_TEST_BASE_URL || 'http://localhost:5000').replace(/\/$/, '')
const goalId = process.env.LNBITS_PAYMENT_TEST_GOAL_ID || 'zg_shTfp_A9llE6zMfd'
const origin = new URL(baseURL).origin
const useRepoSource = process.env.LNBITS_PAYMENT_TEST_DEPLOYED !== '1'
const publicSource = !useRepoSource ? null : process.env.LNBITS_PAYMENT_TEST_SOURCE_REF
  ? execFileSync('git', ['show', `${process.env.LNBITS_PAYMENT_TEST_SOURCE_REF}:static/js/public.js`], {cwd: path.join(__dirname, '..'), encoding: 'utf8'})
  : fs.readFileSync(path.join(__dirname, '../static/js/public.js'), 'utf8')
const amount = 21
const preimage = '01'.repeat(32)
const paymentHash = '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793'
// Signed OFFLINE using bolt11.encode, private key 03*32, preimage 01*32,
// payment secret 02*32, 21 sats, timestamp 1788825600, expiry 315360000.
// This is deliberately not an invoice created by LNbits. NEVER pay this fixture.
const paymentRequest = 'lnbc210n1p4f75qqpp5wtxkappzcsrlkmgfs6g0zyct0hkhashh7hsaxz7e65slq9fkx7fssp5qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdpafanxvmrfdejjqun9vaex2umnd9hkugrxd9u8gatjv5sz6gzwg4ty253q2pq4jxqxfvcqcqn7hhv4vpa36t58ufc0my5a2qs90u79cvc0d0lqv76qn5fqcwaaqsptk2rgn6u8wyx8rkdwtrqmhc5yk9n28dadszwz4y3as8ynq6yccpdat4lu'
const goal = {
  id: goalId, title: 'Payment dialog regression fixture', descriptionAbove: '', descriptionBelow: '',
  currentAmount: 100, goalAmount: 1000, percent: 10, status: 'active',
  suggestedAmounts: '[21,100,500,1000]', targetDate: '2099-01-01T00:00:00Z',
  walletMode: 'all', recurring: false
}

const test = base.extend({
  harness: async ({page, context}, use) => {
    const network = {mode: 'success', payments: [], lookups: [], wallets: [], blocked: []}
    const pageErrors = []
    page.on('pageerror', error => {
      const stack = error.stack || error.message
      // With service workers blocked for interception safety, this LNbits
      // host build dereferences the absent registration.scope. It is unrelated
      // to the sandbox/payment flow; do not suppress any extension errors.
      if (error.message === "Cannot read properties of undefined (reading 'scope')" && stack.includes(`${origin}/static/bundle.min.js`)) return
      pageErrors.push(stack)
    })
    const json = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)})

    // Install BEFORE navigation. All payment POSTs, on ANY origin, are handled
    // here; no fallback/continue can accidentally reach a funding source.
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      if (/^\/api\/v1\/payments\/?$/.test(url.pathname) && method === 'POST') {
        network.payments.push({body: request.postDataJSON(), testKey: request.headers()['x-api-key'] === 'test-only', origin: url.origin})
        if (network.mode === 'payer-error') return json(route, {detail: 'Test-only payer failure'}, 500)
        return json(route, {payment_hash: paymentHash, payment_request: paymentRequest})
      }
      if (url.pathname.startsWith('/api/v1/payments/') && method === 'GET') {
        network.lookups.push(url.pathname)
        return json(route, {payment_hash: paymentHash, paid: true, pending: false, status: 'success', preimage: network.mode === 'success' ? preimage : null})
      }
      if (url.pathname === '/api/v1/wallet' && method === 'GET') {
        network.wallets.push({testKey: request.headers()['x-api-key'] === 'test-only'})
        return json(route, {id: 'test-only-wallet', name: 'Offline regression wallet', balance: 100000000})
      }
      // Only the host's in-memory sandbox-frame handshake may write to the
      // server. Invoice creation is mocked inside the bridge below; any leak,
      // including an extension invoice POST, is blocked and fails the test.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !(url.origin === origin && method === 'POST' && url.pathname === '/api/v1/ext/zapgoalswasm/_ui/frame')) {
        network.blocked.push(`${method} ${url.origin}${url.pathname}`)
        return json(route, {detail: 'Blocked unexpected mutation by payment-dialog test'}, 403)
      }
      if (useRepoSource && url.pathname === '/ext-assets/zapgoalswasm/js/public.js') {
        return route.fulfill({contentType: 'application/javascript', body: publicSource})
      }
      // Bitcoin Connect may request fiat rates; this test needs no external network.
      if (url.origin !== origin) return route.abort('blockedbyclient')
      return route.continue()
    })

    // Keep the real bridge connection and real sandbox. Intercept its API and
    // subscription boundary before public.js mounts and registers its listener.
    await context.addInitScript(({goal, paymentHash, paymentRequest}) => {
      let bridge
      Object.defineProperty(window, 'LNbitsBridge', {
        configurable: true,
        get: () => bridge,
        set(value) {
          bridge = value
          const listeners = new Set()
          const state = window.__paymentDialogTest = {
            invoiceRequests: [], subscriptions: [], unsubscriptions: [], apiCalls: [],
            currentAmount: goal.currentAmount,
            async emit(event, subscriptionId, data = {}) {
              await Promise.all([...listeners].map(listener => listener({type: 'lnbits-extension:event', event, subscriptionId, data})))
            }
          }
          bridge.callApi = async (method, pathname, body) => {
            state.apiCalls.push({method, pathname})
            if (method === 'GET' && pathname === `/api/v1/ext/zapgoalswasm/goals/${goal.id}/public`) {
              return {...goal, currentAmount: state.currentAmount, percent: state.currentAmount / goal.goalAmount * 100}
            }
            if (method === 'POST' && pathname === `/api/v1/ext/zapgoalswasm/goals/${goal.id}/invoice`) {
              state.invoiceRequests.push(body)
              return {paymentHash, paymentRequest}
            }
            throw new Error(`Unmocked bridge API: ${method} ${pathname}`)
          }
          bridge.subscribePayment = async (hash, id) => { state.subscriptions.push({hash, id}) }
          bridge.unsubscribePayment = async id => { state.unsubscriptions.push(id) }
          bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
        }
      })
    }, {goal, paymentHash, paymentRequest})

    await page.goto(`${baseURL}/ext/zapgoalswasm/public/${encodeURIComponent(goalId)}`)
    await expect.poll(() => page.frames().some(frame => frame.url().includes('/ext-frame/zapgoalswasm/'))).toBe(true)
    const frame = page.frames().find(frame => frame.url().includes('/ext-frame/zapgoalswasm/'))
    await expect(frame.getByRole('heading', {name: goal.title})).toBeVisible()
    await frame.waitForFunction(() => Boolean(window.ZapGoalsBitcoinConnect?.connect))
    await frame.evaluate(async () => {
      const bc = window.ZapGoalsBitcoinConnect
      // Observe callbacks without replacing the real payment modal or provider.
      // Holding them lets us reproduce already-queued callbacks after teardown.
      window.ZapGoalsBitcoinConnect = {...bc, launchPaymentModal(options) {
        window.__paymentDialogTest.callbacks = options
        return bc.launchPaymentModal(options)
      }}
      bc.init({appName: 'ZapGoals', showBalance: false, persistConnection: false})
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Mock LNbits connector did not connect')), 5000)
        const unsubscribe = bc.onConnected(() => { clearTimeout(timeout); unsubscribe(); resolve() })
        bc.connect({connectorType: 'lnbits', connectorName: 'LNbits', lnbitsInstanceUrl: location.origin, lnbitsAdminKey: 'test-only'})
      })
    })
    await use({page, frame, network})
    expect(network.blocked, 'Unexpected server mutation was blocked').toEqual([])
    expect(network.payments.every(payment => payment.testKey && payment.origin === origin), 'Only the fake LNbits connector may attempt payment').toBe(true)
    expect(network.wallets.every(wallet => wallet.testKey)).toBe(true)
    expect(pageErrors, 'Unexpected uncaught browser errors').toEqual([])
  }
})

test.use({viewport: {width: 1280, height: 900}, serviceWorkers: 'block'})
test.setTimeout(30000)

async function openPayment({frame}) {
  await frame.getByRole('button', {name: 'Zap this goal', exact: true}).click()
  await frame.getByRole('button', {name: String(amount), exact: true}).click()
  await frame.getByRole('button', {name: `Zap ${amount} sats`, exact: true}).click()
  const confirm = frame.getByRole('button', {name: /Confirm Payment/})
  await expect(confirm).toBeVisible()
  await expect(frame.locator('bc-modal')).toHaveCount(1)
  const state = await frame.evaluate(() => ({requests: window.__paymentDialogTest.invoiceRequests, subscriptions: window.__paymentDialogTest.subscriptions, paymentState: window.ZapGoalsPublicApp.paymentState}))
  expect(state.requests).toEqual([{amount, comment: null}])
  expect(state.subscriptions).toEqual([{hash: paymentHash, id: `zap-${paymentHash.slice(0, 12)}`}])
  expect(state.paymentState).toBe('pending')
  return {confirm, subscriptionId: state.subscriptions[0].id}
}

async function emitSettlement(frame, subscriptionId, event = 'payment.settled') {
  await frame.evaluate(async ({subscriptionId, event, amount}) => {
    const state = window.__paymentDialogTest
    state.currentAmount += amount
    // Deliberately omit preimage: receiver settlement is already authoritative.
    await state.emit(event, subscriptionId, {pending: false, status: 'success'})
  }, {subscriptionId, event, amount})
}

async function expectPaid({frame}, subscriptionId) {
  // Check the actual custom-element overlay, not just the app state underneath.
  // 750 ms is below the old six x 500 ms preimage-retry path.
  await expect(frame.locator('bc-modal'), 'Confirm Payment must disappear immediately, not wait for preimage retries').toHaveCount(0, {timeout: 750})
  await expect(frame.getByText('Payment received', {exact: true})).toBeVisible()
  await expect(frame.getByRole('button', {name: 'Done', exact: true})).toBeVisible()
  expect(await frame.evaluate(() => ({state: window.ZapGoalsPublicApp.paymentState, currentAmount: window.ZapGoalsPublicApp.goal.currentAmount}))).toEqual({state: 'paid', currentAmount: goal.currentAmount + amount})
  await expect.poll(() => frame.evaluate(() => window.__paymentDialogTest.unsubscriptions)).toEqual([subscriptionId])
}

test('real Confirm Payment closes immediately on provider success with a preimage', async ({harness}) => {
  const {frame, network} = harness
  const {confirm, subscriptionId} = await openPayment(harness)
  await frame.evaluate(() => { window.__paymentDialogTest.currentAmount += 21 })
  await confirm.click()
  await expectPaid(harness, subscriptionId)
  expect(network.payments.map(payment => payment.body)).toEqual([{bolt11: paymentRequest, out: true}])
  expect(network.lookups).toEqual([`/api/v1/payments/${paymentHash}`])
})

for (const mode of ['missing-preimage', 'payer-error']) {
  test(`verified bridge settlement closes Confirm Payment after ${mode}`, async ({harness}) => {
    const {frame, network} = harness
    network.mode = mode
    const {confirm, subscriptionId} = await openPayment(harness)
    await confirm.click()
    await expect(frame.getByText(mode === 'missing-preimage' ? 'No preimage' : 'Test-only payer failure', {exact: true})).toBeVisible()
    await expect(frame.locator('bc-modal')).toHaveCount(1)
    const lookupsBeforeSettlement = network.lookups.length
    // Do not await the async app listener: assert closure while any erroneous
    // preimage retries would still be running, not three seconds afterward.
    await frame.evaluate(({subscriptionId, amount}) => {
      const state = window.__paymentDialogTest
      state.currentAmount += amount
      state.settlementFinished = false
      state.emit('payment.settled', subscriptionId, {pending: false, status: 'success'}).then(() => { state.settlementFinished = true })
    }, {subscriptionId, amount})
    await expectPaid(harness, subscriptionId)
    expect(network.payments).toHaveLength(1)
    expect(network.lookups, 'Receiver settlement must not fetch/retry payer preimages').toHaveLength(lookupsBeforeSettlement)
    await expect.poll(() => frame.evaluate(() => window.__paymentDialogTest.settlementFinished)).toBe(true)
  })
}

test('cancelling Bitcoin Connect still exposes a usable QR invoice', async ({harness}) => {
  const {frame, network} = harness
  const {subscriptionId} = await openPayment(harness)
  await frame.locator('bc-modal-header').getByRole('button').last().click()
  await expect(frame.locator('bc-modal')).toHaveCount(0)
  await expect(frame.getByText('Pay Lightning invoice', {exact: true})).toBeVisible()
  await expect(frame.getByLabel('BOLT11 invoice')).toHaveValue(paymentRequest)
  await expect(frame.locator('.qr-box canvas, .qr-box svg')).toBeVisible()
  await expect(frame.getByText('Waiting for payment…', {exact: true})).toBeVisible()
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.paymentState)).toBe('pending')
  expect(network.payments).toHaveLength(0)
  // QR/external-wallet settlement still reaches the same success screen.
  await emitSettlement(frame, subscriptionId, 'payment.update')
  await expectPaid(harness, subscriptionId)
})

test('duplicate settlement and late paid/cancel callbacks cannot reopen after Done', async ({harness}) => {
  const {frame} = harness
  const {confirm, subscriptionId} = await openPayment(harness)
  await frame.evaluate(() => { window.__paymentDialogTest.currentAmount += 21 })
  await confirm.click()
  await expectPaid(harness, subscriptionId)
  await frame.evaluate(() => window.__paymentDialogTest.callbacks.onCancelled())
  await expect(frame.getByText('Payment received', {exact: true})).toBeVisible()
  await expect(frame.getByLabel('BOLT11 invoice')).toHaveCount(0)
  await frame.getByRole('button', {name: 'Done', exact: true}).click()
  await expect(frame.locator('.invoice-dialog')).toHaveCount(0)
  await frame.evaluate(async subscriptionId => {
    const state = window.__paymentDialogTest
    await state.emit('payment.settled', subscriptionId, {pending: false, status: 'success'})
    await state.emit('payment.update', subscriptionId, {pending: false, status: 'success'})
    // Invoke the actual onPaid/onCancelled callbacks captured at launch, as if
    // the provider had already queued them when Done closed the success view.
    await state.callbacks.onPaid({preimage: '01'.repeat(32)})
    state.callbacks.onCancelled()
    window.dispatchEvent(new CustomEvent('bc:onpaid', {detail: {preimage: '01'.repeat(32)}}))
    window.ZapGoalsBitcoinConnect.closeModal()
  }, subscriptionId)
  await expect(frame.locator('bc-modal')).toHaveCount(0)
  await expect(frame.locator('.invoice-dialog')).toHaveCount(0)
  expect(await frame.evaluate(() => ({state: window.ZapGoalsPublicApp.paymentState, invoice: window.ZapGoalsPublicApp.invoice, currentAmount: window.ZapGoalsPublicApp.goal.currentAmount}))).toEqual({state: 'idle', invoice: null, currentAmount: goal.currentAmount + amount})
})
