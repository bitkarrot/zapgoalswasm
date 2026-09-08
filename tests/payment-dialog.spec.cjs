/*
 * INVOICE-ONLY, SAFE browser regressions against the real LNbits public host.
 * Run only this spec: npx playwright test tests/payment-dialog.spec.cjs --workers=1
 * SCREENSHOTS=1 additionally writes screenshots/invoice-only-*.png.
 * Optional LNBITS_PAYMENT_TEST_BASE_URL (default http://localhost:5000).
 *
 * The sole real POST allowed is /api/v1/ext/zapgoalswasm/_ui/frame, the host's
 * in-memory frame-token handshake. ALL other APIs/mutations are fixture-only or
 * blocked BEFORE navigation, including payer APIs on every origin. No login,
 * credentials, invoice creation, payment, accounting changes, or database writes.
 * All extension static files AND frame HTML come from this checkout (raw bytes,
 * never relaxed CSP or hand-built UI). Host-provided _lnbits assets retain their
 * response headers. The local host's patched sandbox/CSP is reset to stock v1.6.
 * Admin tests mount the ACTUAL index template in the same public host frame;
 * only bridge connect/context/API boundaries are replaced with in-memory data.
 */
const {test: base, expect} = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const baseURL = (process.env.LNBITS_PAYMENT_TEST_BASE_URL || 'http://localhost:5000').replace(/\/$/, '')
const origin = new URL(baseURL).origin
const goalId = 'zg_offline_browser_demo'
const API = '/api/v1/ext/zapgoalswasm'
const frameHandshake = `${API}/_ui/frame`
const assetPrefix = '/ext-assets/zapgoalswasm/'
const assets = `${origin}${assetPrefix}`
const stockCSP = `sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src ${assets}; script-src-attr 'none'; style-src ${assets}; style-src-attr 'none'; img-src ${assets} data:; font-src ${assets}; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; media-src ${assets}; manifest-src 'none'; frame-ancestors 'self'`
const amount = 21
const paymentHash = '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793'
// Real BOLT11 signed OFFLINE: key 03*32, preimage 01*32, secret 02*32,
// 21 sats, timestamp 1788825600, expiry 315360000. NEVER PAY THIS FIXTURE.
// It is NOT an invoice created by any LNbits server or connected wallet.
const paymentRequest = 'lnbc210n1p4f75qqpp5wtxkappzcsrlkmgfs6g0zyct0hkhashh7hsaxz7e65slq9fkx7fssp5qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdpafanxvmrfdejjqun9vaex2umnd9hkugrxd9u8gatjv5sz6gzwg4ty253q2pq4jxqxfvcqcqn7hhv4vpa36t58ufc0my5a2qs90u79cvc0d0lqv76qn5fqcwaaqsptk2rgn6u8wyx8rkdwtrqmhc5yk9n28dadszwz4y3as8ynq6yccpdat4lu'
const goal = {
  id: goalId, walletId: 'offline-demo-wallet', title: 'Offline demo — community workshop',
  descriptionAbove: 'Demo goal with fixture data only. No real funds or connected wallets.',
  descriptionBelow: 'Browser test invoices are offline fixtures. Never pay them.',
  currentAmount: 4200, goalAmount: 10000, percent: 42, status: 'active',
  suggestedAmounts: '[21,100,500,1000]', targetDate: '2026-10-01T00:00:00Z',
  walletMode: 'vanilla', recurring: false, backgroundColor: '#FFFFFF', textColor: '#1F2937',
  progressColor: '#F59E0B', remainderColor: '#E5E7EB', fontName: 'sans-serif', fontWeight: 400
}
const recurringGoal = {
  ...goal, id: 'zg_offline_monthly_demo', title: 'Offline demo — monthly supplies',
  recurring: true, recurrenceUnit: 'month', recurrenceInterval: 1, recurrenceDayOfMonth: 1,
  periodIndex: 2, periodStartDate: '2026-09-01T00:00:00Z', periodEndDate: '2026-10-01T00:00:00Z',
  targetWalletId: 'offline-demo-wallet', rolloverMode: 'reset_to_zero', sweepMode: 'target_amount'
}
const periods = [{
  id: 'offline-period-1', goalId: recurringGoal.id, periodIndex: 1,
  startDate: '2026-08-01T00:00:00Z', endDate: '2026-09-01T00:00:00Z',
  zappedAmount: 12000, movedAmount: 10000, rolloverAmount: 0, retainedAmount: 2000,
  createdAt: '2026-09-01T00:00:00Z'
}]

function contentType(filename) {
  return ({'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'})[path.extname(filename)] || 'application/octet-stream'
}

const test = base.extend({
  harness: async ({page, context}, use) => {
    const network = {blocked: [], external: [], handshakes: [], overlays: [], frames: [], websockets: []}
    const pageErrors = []
    let template = 'public'
    page.on('pageerror', error => {
      const stack = error.stack || error.message
      // Playwright's own serviceWorkers:'block' init script reads serviceWorker
      // in opaque frames; stock sandbox correctly throws. Do not hide errors
      // from any extension script or from localStorage access.
      if (error.message.includes("Failed to read the 'serviceWorker' property") && !stack.includes('/ext-assets/')) return
      // Known LNbits host bug after Playwright blocks service-worker registration.
      if (error.message === "Cannot read properties of undefined (reading 'scope')" && stack.includes(`${origin}/static/bundle.min.js`)) return
      pageErrors.push(stack)
    })
    const json = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)})

    // No WebSocket may contact a real server. Payment events are fixture wakeups.
    await context.routeWebSocket('**/*', socket => {
      network.websockets.push(socket.url())
      socket.close({code: 1000, reason: 'Offline browser fixtures only'})
    })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method()
      if (url.origin === origin && method === 'POST' && url.pathname === frameHandshake) {
        network.handshakes.push(request.postDataJSON())
        return route.continue()
      }
      if (!['GET', 'HEAD'].includes(method)) {
        network.blocked.push(`${method} ${url.origin}${url.pathname}`)
        return json(route, {detail: 'Unexpected mutation blocked by offline browser suite'}, 403)
      }
      if (url.origin !== origin) {
        network.external.push(`${method} ${url.href}`)
        return route.abort('blockedbyclient')
      }
      // No direct read API is needed either. Goals, invoices, receipt checks,
      // wallets and administration are mocked only at the bridge boundary.
      if (url.pathname.startsWith('/api/')) {
        network.blocked.push(`${method} ${url.pathname}`)
        return json(route, {detail: 'Unexpected API blocked by offline browser suite'}, 403)
      }
      if (url.pathname === '/static/bundle-components.min.js') {
        const response = await route.fetch()
        const original = await response.text()
        const body = original.replaceAll('allow-scripts allow-pointer-lock allow-same-origin', 'allow-scripts allow-pointer-lock')
        if (!body.includes('allow-scripts allow-pointer-lock')) throw new Error('Host sandbox declaration not found; cannot prove stock sandbox')
        return route.fulfill({response, body})
      }
      if (url.pathname.startsWith('/ext-frame/zapgoalswasm/')) {
        const response = await route.fetch()
        expect(response.ok(), 'The host must issue a real sandbox frame').toBe(true)
        const filename = `templates/${template}.html`
        const body = fs.readFileSync(path.join(root, filename))
        network.frames.push({filename, csp: stockCSP})
        return route.fulfill({response, status: 200, headers: {...response.headers(), 'content-security-policy': stockCSP, 'content-type': 'text/html; charset=utf-8'}, body})
      }
      if (url.pathname.startsWith(assetPrefix)) {
        const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length))
        if (relative.includes('..') || /bitcoin-connect|storage-shim|embed-page/.test(relative)) {
          network.blocked.push(`Forbidden/removed asset: ${relative}`)
          return route.abort('blockedbyclient')
        }
        // Fulfill bytes even for host dependencies, avoiding loopback/PNA issues
        // for opaque frames while preserving the host's security/CORS headers.
        const response = await route.fetch()
        if (relative.startsWith('_lnbits/')) return route.fulfill({response})
        const filename = path.join(root, 'static', relative)
        if (!fs.existsSync(filename)) throw new Error(`Missing source overlay: ${filename}`)
        network.overlays.push(relative)
        return route.fulfill({response, status: 200, contentType: contentType(filename), body: fs.readFileSync(filename)})
      }
      // Only read-only local host shell/static requests can reach the server.
      if (url.pathname.startsWith('/static/') || url.pathname === `/ext/zapgoalswasm/public/${goalId}` || url.pathname === '/favicon.ico' || url.pathname === '/manifest.webmanifest') return route.continue()
      network.blocked.push(`${method} ${url.pathname}`)
      return route.abort('blockedbyclient')
    })

    await context.addInitScript(({goal, recurringGoal, periods, paymentHash, paymentRequest, API}) => {
      window.__stockCsp = []
      window.addEventListener('securitypolicyviolation', event => window.__stockCsp.push({directive: event.effectiveDirective, blocked: event.blockedURI, policy: event.originalPolicy}))
      let bridge
      Object.defineProperty(window, 'LNbitsBridge', {
        configurable: true,
        get: () => bridge,
        set(value) {
          bridge = value
          const listeners = new Set()
          const state = window.__invoiceOnlyTest = {
            goal: {...goal}, goals: [{...goal}, {...recurringGoal}], paid: false,
            invoiceRequests: [], receipts: [], subscriptions: [], unsubscriptions: [], apiCalls: [], unexpected: [], notifications: [], saves: [], sweeps: [],
            invoiceQueue: [], receiptQueue: [], subscriptionQueue: [],
            holdInvoice: false, holdReceipt: false, holdSubscription: false,
            rejectSubscription: false, rejectReceipt: false, rejectInvoice: false,
            async emit(event, subscriptionId, data = {}) {
              await Promise.all([...listeners].map(listener => listener({type: 'lnbits-extension:event', event, subscriptionId, data})))
            },
            release(queue) { const callbacks = this[queue].splice(0); callbacks.forEach(resolve => resolve()) }
          }
          bridge.callApi = async (method, pathname, body) => {
            state.apiCalls.push({method, pathname, body})
            if (method === 'GET' && pathname === `${API}/goals/${goal.id}/public`) {
              return {...state.goal, percent: state.goal.currentAmount / state.goal.goalAmount * 100}
            }
            if (method === 'POST' && pathname === `${API}/goals/${goal.id}/invoice`) {
              state.invoiceRequests.push(structuredClone(body))
              if (state.holdInvoice) await new Promise(resolve => state.invoiceQueue.push(resolve))
              if (state.rejectInvoice) throw new Error('Offline fixture invoice failure')
              return {paymentHash, paymentRequest}
            }
            if (method === 'GET' && pathname === `${API}/goals/${goal.id}/payments/${paymentHash}`) {
              // Snapshot before waiting to reproduce a stale, already-in-flight
              // paid response arriving after cancellation / a new attempt.
              const paid = state.paid
              state.receipts.push({pathname, paid})
              if (state.holdReceipt) await new Promise(resolve => state.receiptQueue.push(resolve))
              if (state.rejectReceipt) throw new Error('Offline fixture receipt unavailable')
              return {paid}
            }
            if (method === 'GET' && pathname === `${API}/goals`) return {data: structuredClone(state.goals)}
            if (method === 'GET' && pathname === `${API}/wallets`) return {data: [{id: 'offline-demo-wallet', name: 'Offline demo wallet — no funds'}]}
            if (method === 'GET' && pathname === `${API}/goals/${recurringGoal.id}/periods`) return {data: structuredClone(periods)}
            // The guarded sweep regression never transfers anything: the fixture
            // always reports an empty allocation.
            if (method === 'POST' && pathname.endsWith('/sweep')) {
              state.sweeps.push({pathname, body: structuredClone(body)})
              return {swept: false, goalId: recurringGoal.id, reason: 'Nothing available to sweep yet',
                movedAmount: 1000, sweptAmount: 0, available: 0, closedPeriods: 2}
            }
            if ((method === 'POST' && pathname === `${API}/goals`) || (method === 'PUT' && pathname.startsWith(`${API}/goals/`))) {
              state.saves.push({method, pathname, body: structuredClone(body)})
              const id = method === 'PUT' ? decodeURIComponent(pathname.slice(`${API}/goals/`.length)) : body.id || 'zg_offline_saved_demo'
              const index = state.goals.findIndex(item => item.id === id)
              if (method === 'PUT' && index < 0) {
                state.unexpected.push(`${method} ${pathname}`)
                throw new Error('Unknown fixture goal; mutation blocked')
              }
              // PUT is a cosmetic partial update, not replacement of the stored
              // goal. Preserve omitted immutable rules and accounting metadata.
              const saved = {...structuredClone(state.goals[index] || {}), ...structuredClone(body), id}
              if (Array.isArray(body.suggestedAmounts)) saved.suggestedAmounts = JSON.stringify(body.suggestedAmounts)
              if (index < 0) state.goals.push(saved); else state.goals[index] = saved
              return structuredClone(saved)
            }
            state.unexpected.push(`${method} ${pathname}`)
            throw new Error(`Unmocked bridge API blocked: ${method} ${pathname}`)
          }
          bridge.subscribePayment = async (hash, id) => {
            state.subscriptions.push({hash, id})
            if (state.holdSubscription) await new Promise(resolve => state.subscriptionQueue.push(resolve))
            if (state.rejectSubscription) throw new Error('Offline fixture subscription unavailable')
          }
          bridge.unsubscribePayment = async id => { state.unsubscriptions.push(id) }
          bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
          bridge.notify = async (message, type) => { state.notifications.push({message, type}) }
          bridge.openInNewTab = async () => { throw new Error('Navigation disabled in offline fixture') }
          // Keep the real public bridge connection and parent MessageChannel.
          // The admin UI is mounted in a public frame, never in an authenticated
          // route. Its context is entirely synthetic and contains no secrets.
          if (document.title === 'ZapGoals') bridge.connect = async () => ({routeParams: {}, wallets: [], user: {id: 'offline-demo-user'}})
        }
      })
    }, {goal, recurringGoal, periods, paymentHash, paymentRequest, API})
    await page.clock.setFixedTime(new Date('2026-09-08T12:00:00Z'))
    const mount = async (name = 'public') => {
      template = name
      await page.goto(`${baseURL}/ext/zapgoalswasm/public/${goalId}`)
      await expect.poll(() => page.frames().some(frame => frame.url().includes('/ext-frame/zapgoalswasm/'))).toBe(true)
      const frame = page.frames().find(frame => frame.url().includes('/ext-frame/zapgoalswasm/'))
      await frame.waitForFunction(name => Boolean(name === 'public' ? window.ZapGoalsPublicApp?.goal : window.ZapGoalsApp?.goals.length), name)
      await expect(frame.locator('#q-app')).not.toHaveClass(/vue-pending/)
      return frame
    }
    await use({page, context, mount, network})
    expect(network.blocked, 'All unexpected APIs/mutations/assets must be blocked and fail the test').toEqual([])
    expect(network.external, 'No external QR, wallet connector or service is requested').toEqual([])
    expect(network.handshakes.length, 'Real host handshake was exercised').toBeGreaterThan(0)
    for (const frame of page.frames().filter(item => item.url().includes('/ext-frame/zapgoalswasm/'))) {
      expect(await frame.evaluate(() => window.__invoiceOnlyTest.unexpected)).toEqual([])
      expect(await frame.evaluate(() => window.__stockCsp), 'Extension must work without any stock CSP violation').toEqual([])
    }
    expect(pageErrors, 'Unexpected browser errors').toEqual([])
  }
})

test.use({viewport: {width: 1280, height: 1000}, serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light'})
test.setTimeout(45000)

async function screenshot(frame, name, selector = 'body') {
  if (process.env.SCREENSHOTS !== '1') return
  const directory = path.join(root, 'screenshots')
  fs.mkdirSync(directory, {recursive: true})
  await frame.evaluate(() => document.fonts.ready)
  await frame.locator(selector).screenshot({path: path.join(directory, `invoice-only-${name}.png`), animations: 'disabled'})
}
async function chooseAmount(frame, comment = '') {
  await frame.getByRole('button', {name: 'Zap this goal', exact: true}).click()
  await frame.getByRole('button', {name: String(amount), exact: true}).click()
  if (comment) await frame.getByLabel('Comment (optional)').fill(comment)
}
async function openInvoice(frame) {
  await chooseAmount(frame)
  await frame.getByRole('button', {name: `Zap ${amount} sats`, exact: true}).click()
  await expectInvoice(frame)
  return frame.evaluate(() => window.__invoiceOnlyTest.subscriptions.at(-1)?.id)
}
async function expectInvoice(frame) {
  await expect(frame.getByLabel('BOLT11 invoice')).toHaveValue(paymentRequest)
  await expect(frame.locator('.qr-box canvas, .qr-box svg')).toBeVisible()
  await expect(frame.getByText('Pay 21 sats', {exact: true})).toBeVisible()
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.paymentState)).toBe('pending')
}
async function emit(frame, subscriptionId, data = {}, event = 'payment.settled') {
  await frame.evaluate(async ({subscriptionId, data, event}) => window.__invoiceOnlyTest.emit(event, subscriptionId, data), {subscriptionId, data, event})
}
async function expectPaid(frame) {
  // Confirmation is a toast plus an automatic close; no attempt survives.
  await expect(frame.locator('.invoice-dialog')).toHaveCount(0)
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.paymentState)).toBe('idle')
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.activeAttempt)).toBe(null)
  const notifications = await frame.evaluate(() => window.__invoiceOnlyTest.notifications)
  expect(notifications).toContainEqual({message: 'Payment received — thank you!', type: 'positive'})
}

test('stock v1.6 opaque sandbox renders actual invoice-only public UI and local QR', async ({harness}) => {
  const {page, mount, network} = harness
  const frame = await mount()
  await expect(page.locator('iframe.wasm-extension-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock')
  expect(await frame.evaluate(() => window.origin)).toBe('null')
  expect(network.frames).toEqual([{filename: 'templates/public.html', csp: stockCSP}])
  expect(network.overlays).toEqual(expect.arrayContaining(['js/bridge.js', 'js/public.js', 'js/public-template.js', 'css/public.css', 'css/theme.css']))
  const html = await frame.locator('body').innerText()
  expect(html).not.toMatch(/Bitcoin Connect|Nostr|LNURL|WebLN|payment mode/i)
  await screenshot(frame, 'public-goal', '.public-page')
  await chooseAmount(frame, 'OFFLINE DEMO — never pay this test invoice')
  await screenshot(frame, 'choose-zap', '.amount-dialog')
  await frame.getByRole('button', {name: 'Zap 21 sats', exact: true}).click()
  await expectInvoice(frame)
  await expect(frame.getByText('Waiting for verified payment…', {exact: true})).toBeVisible()
  await expect(frame.locator('bc-modal, bc-connect')).toHaveCount(0)
  await expect(frame.getByRole('button', {name: /connect wallet|confirm payment|open wallet/i})).toHaveCount(0)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toEqual([{amount, comment: 'OFFLINE DEMO — never pay this test invoice'}])
  expect(await frame.evaluate(() => ({attempt: Object.isFrozen(window.ZapGoalsPublicApp.activeAttempt), invoice: Object.isFrozen(window.ZapGoalsPublicApp.invoice)}))).toEqual({attempt: true, invoice: true})
  await screenshot(frame, 'bolt11', '.invoice-dialog')
})

test('settlement broadcasts and aggregate progress are only wakeups; durable paid boolean confirms', async ({harness}) => {
  const frame = await harness.mount()
  const id = await openInvoice(frame)
  await emit(frame, id, {payment_hash: 'f'.repeat(64), paid: true, pending: false, status: 'success'})
  await emit(frame, 'wrong-subscription', {paid: true})
  await frame.evaluate(() => { window.__invoiceOnlyTest.goal.currentAmount = 9999 })
  await emit(frame, id, {payment_hash: paymentHash, paid: true, pending: false, status: 'success', preimage: '01'.repeat(32)})
  await expectInvoice(frame)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.receipts.length)).toBeGreaterThan(0)
  await frame.evaluate(async () => window.ZapGoalsPublicApp.loadGoal(true, true))
  await expect(frame.getByText('Current 9,999 sats', {exact: true})).toBeVisible()
  await expectInvoice(frame)
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = true; window.__invoiceOnlyTest.goal.currentAmount = 4221 })
  await emit(frame, id, {}, 'payment.update')
  await expectPaid(frame)
  await expect(frame.getByText('Current 4,221 sats', {exact: true})).toBeVisible()
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.unsubscriptions)).toContain(id)
  await emit(frame, id, {paid: true})
  await expect(frame.locator('.invoice-dialog')).toHaveCount(0)
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.paymentState)).toBe('idle')
})

test('receiver status polling confirms without any payment event', async ({harness}) => {
  const frame = await harness.mount()
  await openInvoice(frame)
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = true })
  await expectPaid(frame)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toHaveLength(1)
})

test('rejected live monitoring leaves QR/copy usable and retries never mint another invoice', async ({harness}) => {
  const frame = await harness.mount()
  await frame.evaluate(() => { window.__invoiceOnlyTest.rejectSubscription = true })
  await openInvoice(frame)
  await expect(frame.getByText(/Live payment updates are unavailable/)).toBeVisible()
  await expectInvoice(frame)
  await frame.getByRole('button', {name: 'Copy invoice', exact: true}).click()
  await expect.poll(() => frame.evaluate(() => window.__invoiceOnlyTest.notifications.length)).toBeGreaterThan(0)
  await frame.getByRole('button', {name: 'Retry payment monitoring', exact: true}).click()
  await expectInvoice(frame)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toHaveLength(1)
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = true; window.__invoiceOnlyTest.rejectSubscription = false })
  await frame.getByRole('button', {name: 'Retry payment monitoring', exact: true}).click()
  await expectPaid(frame)
})

test('slow subscription never delays invoice display; late completion cannot reopen after close', async ({harness}) => {
  const frame = await harness.mount()
  await frame.evaluate(() => { window.__invoiceOnlyTest.holdSubscription = true })
  const id = await openInvoice(frame)
  await expectInvoice(frame)
  await frame.getByRole('button', {name: 'Close', exact: true}).click()
  await frame.evaluate(() => window.__invoiceOnlyTest.release('subscriptionQueue'))
  await emit(frame, id, {paid: true})
  await expect(frame.locator('.invoice-dialog')).toHaveCount(0)
  await expect.poll(() => frame.evaluate(id => window.__invoiceOnlyTest.unsubscriptions.filter(item => item === id).length, id)).toBeGreaterThan(0)
  expect(await frame.evaluate(() => window.ZapGoalsPublicApp.paymentState)).toBe('idle')
})

test('receipt failure stays pending with a usable invoice, then explicit receiver recheck recovers', async ({harness}) => {
  const frame = await harness.mount()
  await frame.evaluate(() => { window.__invoiceOnlyTest.rejectReceipt = true })
  const id = await openInvoice(frame)
  await emit(frame, id, {paid: true})
  await expect(frame.getByText(/The receiving server has not confirmed this payment/)).toBeVisible()
  await expectInvoice(frame)
  await frame.evaluate(() => { window.__invoiceOnlyTest.rejectReceipt = false; window.__invoiceOnlyTest.paid = true })
  await frame.getByRole('button', {name: 'Retry payment monitoring', exact: true}).click()
  await expectPaid(frame)
})

test('an expired goal disables an already-open amount dialog and the underlying submit guard', async ({harness}) => {
  const frame = await harness.mount()
  await chooseAmount(frame)
  await frame.evaluate(() => {
    window.__invoiceOnlyTest.goal.targetDate = '2026-09-01T00:00:00Z'
    return window.ZapGoalsPublicApp.loadGoal(true, true)
  })
  await expect(frame.getByRole('button', {name: 'Zap 21 sats', exact: true})).toBeDisabled()
  await frame.evaluate(() => window.ZapGoalsPublicApp.createInvoice())
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toEqual([])
  await frame.getByRole('button', {name: 'Cancel', exact: true}).click()
  await expect(frame.getByRole('button', {name: 'Goal ended', exact: true})).toBeDisabled()
  await screenshot(frame, 'ended-goal', '.public-page')
})

test('invoice attempts snapshot input; cancellation invalidates unresolved invoice creation', async ({harness}) => {
  const frame = await harness.mount()
  await frame.evaluate(() => { window.__invoiceOnlyTest.holdInvoice = true })
  await chooseAmount(frame, 'Original demo comment')
  await frame.getByRole('button', {name: 'Zap 21 sats', exact: true}).click()
  await expect.poll(() => frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests.length)).toBe(1)
  await frame.evaluate(() => {
    window.ZapGoalsPublicApp.amount = 999
    window.ZapGoalsPublicApp.comment = 'Changed too late'
  })
  expect(await frame.evaluate(() => ({...window.ZapGoalsPublicApp.activeAttempt}))).toMatchObject({goalId, amount: 21, comment: 'Original demo comment'})
  await frame.getByRole('button', {name: 'Cancel', exact: true}).click()
  await frame.evaluate(() => { window.__invoiceOnlyTest.holdInvoice = false; window.__invoiceOnlyTest.release('invoiceQueue') })
  await expect(frame.locator('.invoice-dialog, .amount-dialog')).toHaveCount(0)
  await openInvoice(frame)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toEqual([{amount: 21, comment: 'Original demo comment'}, {amount: 21, comment: null}])
})

test('stale paid receipt from a cancelled attempt cannot confirm a new attempt with the same hash', async ({harness}) => {
  const frame = await harness.mount()
  const firstId = await openInvoice(frame)
  await frame.evaluate(id => {
    const state = window.__invoiceOnlyTest
    state.paid = true
    state.holdReceipt = true
    state.emit('payment.settled', id, {paid: true})
  }, firstId)
  await expect.poll(() => frame.evaluate(() => window.__invoiceOnlyTest.receiptQueue.length)).toBe(1)
  await frame.getByRole('button', {name: 'Close', exact: true}).click()
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = false; window.__invoiceOnlyTest.holdReceipt = false })
  const secondId = await openInvoice(frame)
  expect(secondId).not.toBe(firstId)
  await frame.evaluate(() => window.__invoiceOnlyTest.release('receiptQueue'))
  await emit(frame, firstId, {paid: true})
  await expectInvoice(frame)
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = true })
  await emit(frame, secondId)
  await expectPaid(frame)
})

test('actual administration offers invoice-only configuration and saves only in-memory fixtures', async ({harness}) => {
  const frame = await harness.mount('index')
  expect(harness.network.frames).toEqual([{filename: 'templates/index.html', csp: stockCSP}])
  expect(harness.network.overlays).toEqual(expect.arrayContaining(['js/index.js', 'js/index-template.js', 'css/index.css']))
  await expect(frame.getByText(/No wallet connection is required/)).toBeVisible()
  await expect(frame.getByRole('button', {name: /Close period|Reset period|Delete goal/i})).toHaveCount(0)
  // The manual sweep is offered only for recurring goals with a target wallet.
  await expect(frame.getByRole('button', {name: 'Sweep to target wallet', exact: true})).toHaveCount(1)
  await screenshot(frame, 'goals', '.page-wrap')
  const row = frame.getByRole('row').filter({hasText: goal.title})
  await row.getByRole('button', {name: 'Edit goal', exact: true}).click()
  await expect(frame.locator('.q-field').filter({has: frame.getByText('Wallet *', {exact: true})})).toHaveClass(/q-field--disabled/)
  await expect(frame.getByRole('switch', {name: 'Enable recurring periods', exact: true})).toBeDisabled()
  await expect(frame.getByLabel('Goal amount *', {exact: true})).toBeEnabled()
  expect(await frame.locator('.goal-dialog').innerText()).not.toMatch(/Bitcoin Connect|LNURL|Nostr|WebLN|payment mode/i)
  await expect(frame.getByText(/Contributors pay a standard BOLT11 invoice/)).toBeVisible()
  await screenshot(frame, 'edit-goal', '.goal-dialog')
  await frame.getByLabel('Background', {exact: true}).fill('#fff7ed')
  await frame.getByLabel('Progress', {exact: true}).fill('#ea580c')
  await frame.getByRole('img', {name: 'Goal design preview', exact: true}).scrollIntoViewIfNeeded()
  await expect(frame.locator('.preview-background')).toHaveAttribute('fill', '#fff7ed')
  await screenshot(frame, 'design-preview', '.goal-dialog')
  await frame.evaluate(() => Object.assign(window.ZapGoalsApp.formDialog.data, {
    accountingVersion: 999, accountingTotals: {offlineTamper: true}, totals: {offlineTamper: true}, accountingOnly: true, legacyOpeningUnverified: true
  }))
  await frame.getByRole('button', {name: 'Save goal', exact: true}).click()
  await expect(frame.locator('.goal-dialog')).toHaveCount(0)
  const saves = await frame.evaluate(() => window.__invoiceOnlyTest.saves)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({method: 'PUT', pathname: `${API}/goals/${goalId}`, body: {walletMode: 'vanilla', backgroundColor: '#fff7ed', progressColor: '#ea580c'}})
  for (const name of ['walletId', 'recurring', 'currentAmount', 'periodIndex', 'accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) expect(saves[0].body).not.toHaveProperty(name)
  const stored = await frame.evaluate(id => window.__invoiceOnlyTest.goals.find(item => item.id === id), goalId)
  expect(stored).toMatchObject({walletId: goal.walletId, recurring: false, currentAmount: 4200, backgroundColor: '#fff7ed'})
  for (const name of ['accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) expect(stored).not.toHaveProperty(name)
})

test('fixed recurring rules are visibly disabled and protected on cosmetic save', async ({harness}) => {
  const frame = await harness.mount('index')
  const row = frame.getByRole('row').filter({hasText: recurringGoal.title})
  await row.getByRole('button', {name: 'Edit goal', exact: true}).click()
  for (const name of ['Wallet *', 'Goal amount *', 'Target date *', 'Recurrence unit', 'Interval', 'Day of month (0 = same day)', 'Target wallet for manual sweeps', 'Allocation amount', 'Rollover mode']) {
    // Quasar removes a disabled q-select's combobox/input from the a11y
    // tree, so inspect its real disabled field rather than a nonexistent input.
    const field = frame.locator('.q-field').filter({has: frame.getByText(name, {exact: true})})
    await expect(field, `${name} must be locked for an existing recurring goal`).toHaveClass(/q-field--disabled/)
    await expect(field.locator('[role="combobox"], input:not([disabled]):not([type="hidden"])')).toHaveCount(0)
  }
  await expect(frame.getByRole('switch', {name: 'Enable recurring periods', exact: true})).toBeDisabled()
  await frame.getByText('Financial rules are fixed after creation. Create a new goal to change them.', {exact: true}).scrollIntoViewIfNeeded()
  // Scroll the real dialog, not its markup/styles: capture the locked financial
  // inputs and automatic-calendar explanation together instead of clipping them.
  await frame.locator('.goal-dialog').evaluate(dialog => {
    const banner = [...dialog.querySelectorAll('.q-banner')].find(item => item.textContent.includes('Financial rules are fixed'))
    dialog.scrollTop += banner.getBoundingClientRect().top - dialog.getBoundingClientRect().top - 100
  })
  await expect(frame.getByText(/no manual reset or scheduler is needed/)).toBeVisible()
  await screenshot(frame, 'fixed-rules', '.goal-dialog')
  await frame.getByLabel('Title *', {exact: true}).fill('Offline demo — supplies, updated title')
  // The save boundary must preserve these fields even if a stale component or
  // script changes reactive form data behind disabled controls.
  await frame.evaluate(() => Object.assign(window.ZapGoalsApp.formDialog.data, {
    walletId: 'tampered-wallet', goalAmount: 1, targetDate: '2099-12-31T00:00',
    recurring: false, recurrenceUnit: 'day', recurrenceInterval: 9,
    recurrenceDayOfMonth: 7, targetWalletId: 'tampered-reference',
    sweepMode: 'entire_amount', rolloverMode: 'counts_as_progress',
    accountingVersion: 999, accountingTotals: {offlineTamper: true}, totals: {offlineTamper: true}, accountingOnly: true, legacyOpeningUnverified: true
  }))
  await frame.getByRole('button', {name: 'Save goal', exact: true}).click()
  await expect(frame.locator('.goal-dialog')).toHaveCount(0)
  const {saved, stored} = await frame.evaluate(id => ({
    saved: window.__invoiceOnlyTest.saves[0].body,
    stored: window.__invoiceOnlyTest.goals.find(item => item.id === id)
  }), recurringGoal.id)
  for (const name of ['walletId', 'goalAmount', 'targetDate', 'recurring', 'recurrenceUnit', 'recurrenceInterval', 'recurrenceDayOfMonth', 'targetWalletId', 'sweepMode', 'rolloverMode']) {
    expect(saved, `${name} must be omitted, not echoed from a projected goal`).not.toHaveProperty(name)
    expect(stored[name], `${name} remains unchanged in the fixture store`).toBe(recurringGoal[name])
  }
  for (const name of ['currentAmount', 'periodIndex', 'periodStartDate', 'periodEndDate', 'percent', 'status', 'accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) expect(saved).not.toHaveProperty(name)
  expect(stored).toMatchObject({currentAmount: 4200, periodIndex: 2, title: 'Offline demo — supplies, updated title'})
  for (const name of ['accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) expect(stored).not.toHaveProperty(name)
  expect(saved.title).toBe('Offline demo — supplies, updated title')
})

test('read-only period history and archive disclosure replace manual financial controls', async ({harness}) => {
  const frame = await harness.mount('index')
  const row = frame.getByRole('row').filter({hasText: recurringGoal.title})
  await row.getByRole('button', {name: 'Period history', exact: true}).click()
  await expect(frame.getByText(/Fixed-calendar accounting/)).toBeVisible()
  await expect(frame.getByRole('columnheader', {name: 'Recorded allocation', exact: true})).toBeVisible()
  await expect(frame.getByRole('columnheader', {name: 'Retained excess', exact: true})).toBeVisible()
  await expect(frame.getByText('12,000 sats', {exact: true})).toBeVisible()
  await expect(frame.getByText('2,000 sats', {exact: true})).toBeVisible()
  // On narrow screens the real history table scrolls horizontally. Prefer its
  // accounting columns in the capture; no table cells or UI styles are changed.
  await frame.locator('.periods-dialog .q-table__middle').evaluate(table => { table.scrollLeft = table.scrollWidth })
  await screenshot(frame, 'history', '.periods-dialog')
  await frame.getByRole('button', {name: 'Close', exact: true}).click()
  await row.getByRole('button', {name: 'Archive goal', exact: true}).click()
  await expect(frame.getByText(/Existing payment and accounting records are retained/)).toBeVisible()
  await expect(frame.getByRole('button', {name: 'Archive', exact: true})).toBeVisible()
  await screenshot(frame, 'archive', '.confirm-dialog')
  // This screenshot verifies the actual disclosure without submitting even a
  // fixture DELETE. All unmocked bridge mutations fail closed.
  await frame.getByRole('button', {name: 'Cancel', exact: true}).click()
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.apiCalls.some(call => call.method === 'DELETE' || /sweep/.test(call.pathname)))).toBe(false)
})

test('manual sweep requires confirmation and reports an empty allocation without transferring', async ({harness}) => {
  const frame = await harness.mount('index')
  const row = frame.getByRole('row').filter({hasText: recurringGoal.title})
  await row.getByRole('button', {name: 'Sweep to target wallet', exact: true}).click()
  // The confirmation states that real funds move and that repeats are safe.
  await expect(frame.locator('.confirm-dialog').getByText('Sweep to target wallet', {exact: true})).toBeVisible()
  await expect(frame.getByText(/moves real funds now/i)).toBeVisible()
  await expect(frame.getByText(/same allocation cannot be transferred twice/i)).toBeVisible()
  await screenshot(frame, 'sweep-confirm', '.confirm-dialog')
  await frame.getByRole('button', {name: 'Transfer', exact: true}).click()
  // The fixture sweep is a no-op: a warning toast, the dialog closes, and the
  // goal list reloads. No invoice or payment API is ever touched.
  await expect(frame.locator('.confirm-dialog')).toHaveCount(0)
  await expect.poll(() => frame.evaluate(() => window.__invoiceOnlyTest.notifications.some(item => item.type === 'warning' && /Nothing available/i.test(item.message)))).toBe(true)
  const sweeps = await frame.evaluate(() => window.__invoiceOnlyTest.sweeps)
  expect(sweeps).toHaveLength(1)
  expect(sweeps[0].pathname).toBe(`${API}/goals/${recurringGoal.id}/sweep`)
  expect(await frame.evaluate(() => window.__invoiceOnlyTest.invoiceRequests)).toHaveLength(0)
})

test('only literal boolean true is a verified receiver receipt', async ({harness}) => {
  const frame = await harness.mount()
  const id = await openInvoice(frame)
  for (const unverified of ['true', 1, null]) {
    await frame.evaluate(value => { window.__invoiceOnlyTest.paid = value }, unverified)
    await emit(frame, id, {paid: true, status: 'success', pending: false})
    await expectInvoice(frame)
  }
  await frame.evaluate(() => { window.__invoiceOnlyTest.paid = true })
  await emit(frame, id)
  await expectPaid(frame)
})

test('mobile invoice stays readable without any wallet connection UI', async ({harness}) => {
  await harness.page.setViewportSize({width: 390, height: 844})
  const frame = await harness.mount()
  await openInvoice(frame)
  const box = await frame.locator('.invoice-dialog').boundingBox()
  expect(box.width).toBeLessThanOrEqual(390)
  await expect(frame.getByRole('button', {name: 'Copy invoice', exact: true})).toBeVisible()
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await screenshot(frame, 'mobile-invoice', '.invoice-dialog')
})

test('new-goal save includes creation rules but never read-only accounting metadata', async ({harness}) => {
  const frame = await harness.mount('index')
  await frame.getByRole('button', {name: 'New goal', exact: true}).click()
  await frame.getByLabel('Title *', {exact: true}).fill('Offline demo — newly configured goal')
  await frame.getByLabel('Target date *', {exact: true}).fill('2026-11-01T00:00')
  await frame.evaluate(() => Object.assign(window.ZapGoalsApp.formDialog.data, {
    accountingVersion: 999, accountingTotals: {offlineTamper: true}, totals: {offlineTamper: true}, accountingOnly: true, legacyOpeningUnverified: true
  }))
  await frame.getByRole('button', {name: 'Save goal', exact: true}).click()
  await expect(frame.locator('.goal-dialog')).toHaveCount(0)
  const saves = await frame.evaluate(() => window.__invoiceOnlyTest.saves)
  expect(saves).toHaveLength(1)
  expect(saves[0]).toMatchObject({method: 'POST', pathname: `${API}/goals`, body: {
    title: 'Offline demo — newly configured goal', walletId: goal.walletId,
    recurring: false, goalAmount: 10000, targetDate: '2026-11-01T00:00:00.000Z'
  }})
  for (const name of ['currentAmount', 'accountingVersion', 'accountingTotals', 'totals', 'accountingOnly', 'legacyOpeningUnverified']) expect(saves[0].body).not.toHaveProperty(name)
})
