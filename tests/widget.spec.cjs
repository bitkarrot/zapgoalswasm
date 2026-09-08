/*
 * Standalone widget regressions. Every HTTP request is fulfilled/aborted and
 * WebSocket is replaced BEFORE navigation. No running LNbits server, wallet,
 * live invoice, payment, mutation, external CDN, or remote QR service is used.
 * Run: npx playwright test tests/widget.spec.cjs --workers=1
 */
const {test, expect} = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const embedSource = fs.readFileSync(path.join(__dirname, '../static/js/embed.js'), 'utf8')
const qrSource = fs.readFileSync(path.join(__dirname, '../static/js/qr.js'), 'utf8')
const harnesses = new WeakMap()
const firstOrigin = 'https://receiver-one.invalid'
const secondOrigin = 'https://receiver-two.invalid'
const merchantOrigin = 'https://widget-test.invalid'
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
// Intentionally invalid checksum: this is NOT a payable Lightning invoice.
const invoiceA = 'lnbc1testonlydonotpayaaaa'
const invoiceB = 'lnbc1testonlydonotpaybbbb'
const goalFixture = {
  id: 'zg_first', title: 'First fixture goal', descriptionAbove: '', descriptionBelow: '',
  currentAmount: 10, goalAmount: 1000, percent: 1, status: 'active',
  suggestedAmounts: '[21,100,500,1000]', targetDate: '2099-01-01T00:00:00Z',
  walletMode: 'all', recurring: false
}

test.use({serviceWorkers: 'block'})

async function setup(page, context, options = {}) {
  const ids = options.ids || ['zg_first']
  const origins = ids.map((_, index) => index ? secondOrigin : firstOrigin)
  const goals = Object.fromEntries(ids.map((id, index) => [id, {...goalFixture, title: index ? 'Second fixture goal' : goalFixture.title, ...options.goal, id}]))
  const state = {goals, paid: {}, statusChecks: [], statusQueue: [], gets: [], invoices: [], requests: [], unexpected: [], errors: [], invoiceQueue: [], goalQueue: [], qrQueue: [], holdInvoice: false, holdGoal: false, holdQR: false, holdStatus: false, qrFailure: false}
  harnesses.set(page, state)
  page.on('pageerror', error => state.errors.push(error.message))
  const json = (route, data) => route.fulfill({contentType: 'application/json', headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS'}, body: JSON.stringify(data)})
  const scripts = []
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    state.requests.push({url: url.href, method})
    if (url.origin === merchantOrigin && url.pathname === '/' && method === 'GET') {
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><title>Offline widget test</title></head><body>' + ids.map((id, index) => `<section id="slot-${index}"><script async src="${origins[index]}/ext-assets/zapgoalswasm/js/embed.js" data-goal="${id}"></script></section>`).join('') + '</body></html>'})
    }
    if (origins.includes(url.origin) && url.pathname === '/ext-assets/zapgoalswasm/js/embed.js' && method === 'GET') {
      // Force both async tags to have been parsed before either script executes.
      scripts.push(route)
      if (scripts.length === ids.length) await Promise.all(scripts.map(item => item.fulfill({contentType: 'application/javascript', body: embedSource})))
      return
    }
    if (origins.includes(url.origin) && url.pathname === '/ext-assets/zapgoalswasm/js/qr.js' && method === 'GET' && !url.search) {
      if (state.holdQR) await new Promise(resolve => state.qrQueue.push(resolve))
      if (state.qrFailure) return route.abort('blockedbyclient')
      return route.fulfill({contentType: 'application/javascript', body: qrSource})
    }
    const payment = url.pathname.match(/^\/api\/v1\/ext\/zapgoalswasm\/goals\/([\w-]+)\/payments\/([0-9a-f]{64})$/)
    if (payment && origins.includes(url.origin) && method === 'GET') {
      state.statusChecks.push({id: payment[1], hash: payment[2], origin: url.origin})
      const snapshot = {paid: state.paid[payment[2]] === true}
      if (state.holdStatus) await new Promise(resolve => state.statusQueue.push(resolve))
      if (state.statusFailure) return route.abort('blockedbyclient')
      return json(route, state.statusReply || snapshot)
    }
    const match = url.pathname.match(/^\/api\/v1\/ext\/zapgoalswasm\/goals\/([\w-]+)\/(public|invoice)$/)
    if (match && origins.includes(url.origin)) {
      const [, id, operation] = match
      if (method === 'OPTIONS') return json(route, {})
      if (method === 'GET' && operation === 'public') {
        state.gets.push({id, origin: url.origin})
        const snapshot = structuredClone(state.goals[id])
        if (state.holdGoal) await new Promise(resolve => state.goalQueue.push(resolve))
        return json(route, snapshot)
      }
      if (method === 'POST' && operation === 'invoice') {
        const index = state.invoices.length
        state.invoices.push({id, origin: url.origin, body: request.postDataJSON()})
        if (state.holdInvoice) await new Promise(resolve => state.invoiceQueue.push(resolve))
        return json(route, state.invoiceReply || {paymentHash: index ? hashB : hashA, paymentRequest: index ? invoiceB : invoiceA})
      }
    }
    state.unexpected.push(`${method} ${url.href}`)
    // NEVER continue/fallback: unknown requests, on every origin, are blocked.
    return route.abort('blockedbyclient')
  })
  await context.addInitScript(() => {
    window.__widgetTest = {sockets: [], throwInvoice: false, throwGoal: false, clipboard: []}
    window.define = () => { throw new Error('QR must not register with embedding page AMD') }
    window.define.amd = true
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => { window.__widgetTest.clipboard.push(text); if (window.__widgetTest.clipboardFails) throw new Error('Offline clipboard failure') }}})
    window.WebSocket = class {
      constructor(url) {
        const state = window.__widgetTest
        const invoice = /\/[0-9a-f]{64}$/.test(url)
        if (invoice ? state.throwInvoice : state.throwGoal) throw new Error('Offline socket failure')
        this.url = url
        this.readyState = 0
        const record = {url, invoice, socket: this, saved: {}, closed: false}
        for (const name of ['onopen', 'onmessage', 'onclose', 'onerror']) {
          Object.defineProperty(this, name, {get: () => record[name], set: callback => { record[name] = callback; if (callback) record.saved[name] = callback }})
        }
        this.record = record
        state.sockets.push(record)
        queueMicrotask(() => { if (!record.closed && !state.holdOpen) { this.readyState = 1; this.onopen?.({}) } })
      }
      close() { this.record.closed = true; this.readyState = 3; this.onclose?.({}) }
    }
  })
  await page.clock.install({time: new Date('2026-09-08T12:00:00Z')})
  await page.clock.pauseAt(new Date('2026-09-08T12:00:00Z'))
  await page.goto(merchantOrigin)
  for (let i = 0; i < ids.length; i++) await expect(page.locator(`#slot-${i} .zg-title`)).toHaveText(goals[ids[i]].title)
  state.widget = index => page.locator(`#slot-${index || 0} .zapgoals-widget-container`)
  state.check = () => { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }
  return state
}
async function begin(widget, sats = 21) {
  await widget.getByRole('button', {name: '⚡ Zap this goal'}).click()
  await widget.getByRole('spinbutton', {name: 'Amount in sats'}).fill(String(sats))
}
async function create(widget, sats = 21) {
  await begin(widget, sats)
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toBeVisible()
}
async function emit(page, hash, data, stale = false) {
  await page.evaluate(({hash, data, stale}) => {
    const records = window.__widgetTest.sockets.filter(record => record.url.endsWith('/' + hash))
    const record = records[records.length - 1]
    const callback = stale ? record.saved.onmessage : record.socket.onmessage
    callback?.({data: typeof data === 'string' ? data : JSON.stringify(data)})
  }, {hash, data, stale})
}
async function settle(page, hash, data = {pending: false, status: 'success'}) {
  // A receipt is independently supplied by the authoritative mocked server.
  // Merely sending an apparently settled websocket event never creates one.
  harnesses.get(page).paid[hash] = true
  await emit(page, hash, data)
  await page.clock.runFor(5001)
}
async function invoiceSockets(page) {
  return page.evaluate(() => window.__widgetTest.sockets.filter(record => record.invoice && !record.closed).map(record => record.url.split('/').pop()))
}

test('two async widgets capture their executing tags and invoice the intended goal and server', async ({page, context}) => {
  const state = await setup(page, context, {ids: ['zg_first', 'zg_second']})
  await expect(state.widget(0)).toHaveAttribute('data-goal', 'zg_first')
  await expect(state.widget(1)).toHaveAttribute('data-goal', 'zg_second')
  expect(state.gets).toEqual(expect.arrayContaining([{id: 'zg_first', origin: firstOrigin}, {id: 'zg_second', origin: secondOrigin}]))
  await create(state.widget(0), 21)
  await state.widget(0).getByRole('button', {name: 'Close payment dialog'}).click()
  await create(state.widget(1), 100)
  expect(state.invoices).toEqual([
    {id: 'zg_first', origin: firstOrigin, body: {amount: 21, comment: null}},
    {id: 'zg_second', origin: secondOrigin, body: {amount: 100, comment: null}}
  ])
  state.check()
})

test('invoice-only flow snapshots the submitted amount and comment; QR stays entirely local', async ({page, context}) => {
  const state = await setup(page, context)
  const widget = state.widget()
  state.holdInvoice = true
  await begin(widget, 21)
  await widget.getByRole('textbox', {name: 'Comment (optional)'}).fill(' original ')
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await expect.poll(() => state.invoiceQueue.length).toBe(1)
  await expect(widget.getByRole('spinbutton')).toBeDisabled()
  await expect(widget.getByRole('textbox', {name: 'Comment (optional)'})).toBeDisabled()
  // Deliberately bypass disabled controls to simulate queued programmatic events.
  await widget.getByRole('spinbutton').evaluate(input => { input.value = '500'; input.dispatchEvent(new Event('input')) })
  await widget.getByRole('textbox', {name: 'Comment (optional)'}).evaluate(input => { input.value = 'changed' })
  state.invoiceQueue.shift()()
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceA)
  await expect(widget.locator('canvas')).toBeVisible()
  expect(state.invoices[0].body).toEqual({amount: 21, comment: 'original'})
  await widget.getByRole('button', {name: 'Copy invoice'}).click()
  await expect(widget.locator('.zg-copy-status')).toHaveText('Invoice copied.')
  expect(await page.evaluate(() => window.__widgetTest.clipboard)).toEqual([invoiceA])
  const pixels = await widget.locator('canvas').evaluate(canvas => {
    const context = canvas.getContext('2d')
    return {quiet: [...context.getImageData(0, 0, 1, 1).data], finder: [...context.getImageData(16, 16, 1, 1).data], size: canvas.width}
  })
  expect(pixels.quiet).toEqual([255, 255, 255, 255])
  expect(pixels.finder).toEqual([0, 0, 0, 255])
  expect(pixels.size).toBeGreaterThan(100)
  await settle(page, hashA, {pending: false, status: 'success'})
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toContainText('21 sats received')
  await expect(widget.locator('.zg-amounts')).toContainText('Current 10 sats')
  expect(state.requests.every(item => [merchantOrigin, firstOrigin].includes(new URL(item.url).origin))).toBe(true)
  expect(state.requests.some(item => item.url === firstOrigin + '/ext-assets/zapgoalswasm/js/qr.js')).toBe(true)
  state.check()
})

test('monitoring constructor failure never hides the invoice; retry can confirm settlement', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await page.evaluate(() => { window.__widgetTest.throwInvoice = true })
  await create(widget)
  await expect(widget.locator('canvas')).toBeVisible()
  await expect(widget.locator('.zg-monitor')).toContainText('still payable')
  await page.evaluate(() => { window.__widgetTest.throwInvoice = false })
  await page.clock.runFor(1001)
  await expect.poll(() => invoiceSockets(page)).toEqual([hashA])
  await settle(page, hashA, {pending: false, status: 'settled', payment_hash: hashA})
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toBeVisible()
  state.check()
})

test('QR and clipboard failure retain a usable BOLT11 and wallet link', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.qrFailure = true
  await page.evaluate(() => { window.__widgetTest.clipboardFails = true })
  await create(widget)
  await expect(widget.locator('.zg-qr')).toContainText('Local QR unavailable')
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceA)
  await expect(widget.getByRole('link', {name: 'Open in Lightning wallet'})).toHaveAttribute('href', 'lightning:' + invoiceA)
  await widget.getByRole('button', {name: 'Copy invoice'}).click()
  await expect(widget.locator('.zg-copy-status')).toHaveText('Select and copy the invoice text.')
  state.check()
})

test('pending, failed, malformed, mismatched and aggregate events never imply invoice payment', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  for (const data of [null, 'bad JSON', {pending: true, status: 'success'}, {pending: false, status: 'failed'}, {paid: true}, {pending: false}, {pending: 'false', status: 'success'}, {pending: false, status: 'success', payment_hash: hashB}, {pending: false, status: 'success', paymentHash: hashB}]) await emit(page, hashA, data)
  state.goals.zg_first.currentAmount = 900
  await emit(page, 'zg_first', {pending: false, status: 'success'})
  await expect(widget.locator('.zg-amounts')).toContainText('Current 900 sats')
  await expect(widget.getByRole('dialog', {name: 'Pay Lightning invoice'})).toBeVisible()
  expect(await invoiceSockets(page)).toEqual([hashA])
  await settle(page, hashA, {pending: false, status: 'paid', payment_hash: hashA})
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toBeVisible()
  state.check()
})

test('settled A callbacks, delayed goal refresh and old timers cannot detach or hide invoice B', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  await expect(widget.locator('canvas')).toBeVisible()
  state.holdGoal = true
  await settle(page, hashA, {pending: false, status: 'success'})
  await expect.poll(() => state.goalQueue.length).toBe(1)
  await widget.getByRole('button', {name: 'Done', exact: true}).click()
  await create(widget, 100)
  await page.evaluate(() => {
    const old = window.__widgetTest.sockets.find(record => record.url.endsWith('/' + 'a'.repeat(64)))
    old.saved.onmessage({data: JSON.stringify({pending: false, status: 'success'})})
    old.saved.onclose({}); old.saved.onerror({}); old.saved.onopen({})
  })
  state.holdGoal = false
  state.goalQueue.shift()()
  await page.clock.runFor(31000)
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  expect(await invoiceSockets(page)).toEqual([hashB])
  await settle(page, hashB, {pending: false, status: 'success'})
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toContainText('100 sats received')
  state.check()
})

test('closing during creation invalidates the old response without replacing a newer invoice', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.holdInvoice = true
  await begin(widget, 21)
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await expect.poll(() => state.invoiceQueue.length).toBe(1)
  await widget.getByRole('button', {name: 'Close payment dialog'}).click()
  await begin(widget, 100)
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await expect.poll(() => state.invoiceQueue.length).toBe(2)
  state.invoiceQueue.pop()()
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  state.invoiceQueue.pop()()
  await page.clock.runFor(1000)
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  expect(await invoiceSockets(page)).toEqual([hashB])
  state.check()
})

test('socket disconnect reconnects once, ignores retired socket events and cleans up on close', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  await page.evaluate(() => {
    const record = window.__widgetTest.sockets.find(record => record.invoice)
    record.socket.onerror({})
    record.saved.onclose({})
  })
  await expect(widget.locator('.zg-monitor')).toContainText('reconnecting')
  await page.clock.runFor(1001)
  expect(await invoiceSockets(page)).toEqual([hashA])
  expect(await page.evaluate(() => window.__widgetTest.sockets.filter(record => record.invoice).length)).toBe(2)
  await page.evaluate(() => {
    const old = window.__widgetTest.sockets.find(record => record.invoice)
    old.saved.onmessage({data: JSON.stringify({pending: false, status: 'success'})})
    old.saved.onclose({})
  })
  await expect(widget.getByRole('dialog', {name: 'Pay Lightning invoice'})).toBeVisible()
  await widget.getByRole('button', {name: 'Close payment dialog'}).click()
  await emit(page, hashA, {pending: false, status: 'success'}, true)
  await page.clock.runFor(31000)
  expect(await invoiceSockets(page)).toEqual([])
  await expect(widget.locator('.zg-overlay')).not.toHaveClass(/show/)
  state.check()
})

test('widget removal cancels sockets, polling and queued reconnects', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  await expect(widget.locator('canvas')).toBeVisible()
  await page.evaluate(() => window.__widgetTest.sockets.forEach(record => record.socket.onerror?.({})))
  const count = state.requests.length
  await widget.evaluate(node => node.remove())
  await page.clock.runFor(65000)
  expect(state.requests.length).toBe(count)
  expect(await page.evaluate(() => window.__widgetTest.sockets.every(record => record.closed))).toBe(true)
  state.check()
})

test('goal socket reconnects once and stale callbacks do not start extra connections', async ({page, context}) => {
  const state = await setup(page, context)
  await page.evaluate(() => {
    const old = window.__widgetTest.sockets[0]
    old.socket.onerror({}); old.saved.onclose({})
  })
  await page.clock.runFor(1001)
  await page.evaluate(() => { window.__widgetTest.sockets[0].saved.onclose({}) })
  await page.clock.runFor(5000)
  expect(await page.evaluate(() => window.__widgetTest.sockets.filter(record => !record.invoice).length)).toBe(2)
  expect(await page.evaluate(() => window.__widgetTest.sockets.filter(record => !record.closed).length)).toBe(1)
  state.check()
})

test('whole-satoshi limits apply even to programmatic submit and tampered suggestions', async ({page, context}) => {
  const state = await setup(page, context, {goal: {suggestedAmounts: '[0,0.5,-1,2100000001,"21\"><img src=x onerror=alert(1)>"]'}}), widget = state.widget()
  await begin(widget)
  await expect(widget.locator('.zg-amt-btn')).toHaveCount(4)
  for (const value of ['0', '-1', '0.5', '21.5', '2100000001', '1e100', '']) {
    await widget.getByRole('spinbutton').fill(value)
    await expect(widget.getByRole('button', {name: 'Create Lightning invoice'})).toBeDisabled()
    await widget.locator('.zg-submit').evaluate(node => node.dispatchEvent(new MouseEvent('click')))
  }
  expect(state.invoices).toEqual([])
  await widget.getByRole('spinbutton').fill('2100000000')
  await expect(widget.getByRole('button', {name: 'Create Lightning invoice'})).toBeEnabled()
  await widget.getByRole('spinbutton').fill('1')
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toBeVisible()
  expect(state.invoices[0].body.amount).toBe(1)
  state.check()
})

for (const [label, goal] of Object.entries({archived: {archived: true}, ended: {targetDate: '2020-01-01T00:00:00Z'}, disabled: {disabled: true}, status: {status: 'disabled'}, invalidDate: {targetDate: 'not-a-date'}})) {
  test(`${label} goal cannot open an amount form or create an invoice`, async ({page, context}) => {
    const state = await setup(page, context, {goal}), widget = state.widget()
    await expect(widget.locator('.zg-zap-btn')).toBeDisabled()
    await widget.locator('.zg-zap-btn').evaluate(node => node.dispatchEvent(new MouseEvent('click')))
    await expect(widget.locator('.zg-overlay')).not.toHaveClass(/show/)
    expect(state.invoices).toEqual([])
    state.check()
  })
}

test('a goal ending while the amount dialog is open disables payment immediately', async ({page, context}) => {
  const state = await setup(page, context, {goal: {targetDate: '2026-09-08T12:00:02Z'}}), widget = state.widget()
  await begin(widget)
  await expect(widget.locator('.zg-submit')).toBeEnabled()
  await page.clock.runFor(2100)
  await expect(widget.locator('.zg-submit')).toBeDisabled()
  await widget.locator('.zg-submit').evaluate(node => node.dispatchEvent(new MouseEvent('click')))
  expect(state.invoices).toEqual([])
  state.check()
})

test('server text and colors are never interpreted as markup or resource-bearing CSS', async ({page, context}) => {
  const text = '<img src="https://evil.invalid/steal" onerror="alert(1)"> & "quotes"'
  const state = await setup(page, context, {goal: {
    title: text, descriptionAbove: text, descriptionBelow: text,
    progressColor: '#fff\"><img src=https://evil.invalid/x>', remainderColor: 'url(https://evil.invalid/css)',
    backgroundColor: 'url(https://evil.invalid/bg)', textColor: 'red;--x:1',
    fontName: 'Arial; background:url(https://evil.invalid/font)', fontWeight: '400\"><img src=x>',
    suggestedAmounts: '["<img src=x>",21,21,0.1]'
  }}), widget = state.widget()
  await expect(widget.locator('.zg-desc')).toHaveText([text, text])
  await expect(widget.locator('img,iframe,script')).toHaveCount(0)
  await expect(widget.locator('.zg-card')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(widget.locator('.zg-progress-fill')).toHaveCSS('background-color', 'rgb(245, 158, 11)')
  await begin(widget)
  await expect(widget.locator('.zg-amt-btn')).toHaveCount(1)
  await expect(widget.locator('.zg-amt-btn')).toHaveText('21 sats')
  await expect(widget.locator('img,iframe,script')).toHaveCount(0)
  state.check()
})

test('QR timeout and retired QR callbacks do not hide an invoice or affect its replacement', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.holdQR = true
  await create(widget)
  await expect.poll(() => state.qrQueue.length).toBe(1)
  await page.clock.runFor(10001)
  await expect(widget.locator('.zg-qr')).toContainText('Local QR unavailable')
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceA)
  await widget.getByRole('button', {name: 'Close payment dialog'}).click()
  await create(widget, 100)
  // Browsers may coalesce the new script with the same in-flight resource.
  // Releasing the old load must not revive A's timeout/DOM callbacks.
  state.holdQR = false
  state.qrQueue.splice(0).forEach(resolve => resolve())
  await expect(widget.locator('canvas')).toBeVisible()
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  expect(await invoiceSockets(page)).toEqual([hashB])
  state.check()
})

test('stalled connection watchdog retries without dropping the invoice', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await page.evaluate(() => { window.__widgetTest.holdOpen = true })
  await create(widget)
  await page.clock.runFor(10001)
  await expect(widget.locator('.zg-monitor')).toContainText('reconnecting')
  await page.evaluate(() => { window.__widgetTest.holdOpen = false })
  await page.clock.runFor(1001)
  await expect(widget.locator('.zg-monitor')).toContainText('Waiting for confirmed payment')
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceA)
  expect(await invoiceSockets(page)).toEqual([hashA])
  state.check()
})

test('invalid invoice responses fail safely and double submits issue only one request', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.holdInvoice = true
  state.invoiceReply = {paymentHash: hashA, paymentRequest: '<img src=https://evil.invalid/invoice onerror=alert(1)>'}
  await begin(widget)
  await widget.getByRole('button', {name: 'Create Lightning invoice'}).click()
  await widget.locator('.zg-submit').evaluate(node => node.dispatchEvent(new MouseEvent('click')))
  await expect.poll(() => state.invoiceQueue.length).toBe(1)
  state.invoiceQueue.shift()()
  await expect(widget.locator('.zg-form-error')).toContainText('Could not create an invoice')
  await expect(widget.locator('.zg-submit')).toBeEnabled()
  await expect(widget.locator('img')).toHaveCount(0)
  expect(state.invoices).toHaveLength(1)
  expect(await invoiceSockets(page)).toEqual([])
  state.check()
})

test('pagehide tears down timers and sockets; bfcache restoration resumes only goal monitoring', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  await expect(widget.locator('canvas')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})))
  const before = state.gets.length
  await page.clock.runFor(65000)
  expect(state.gets.length).toBe(before)
  expect(await page.evaluate(() => window.__widgetTest.sockets.every(record => record.closed))).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})))
  await expect.poll(() => state.gets.length).toBe(before + 1)
  expect(await invoiceSockets(page)).toEqual([])
  await expect(widget.locator('.zg-overlay')).not.toHaveClass(/show/)
  await create(widget, 100)
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false})))
  const ended = state.gets.length
  await page.clock.runFor(65000)
  expect(state.gets.length).toBe(ended)
  expect(await page.evaluate(() => window.__widgetTest.sockets.every(record => record.closed))).toBe(true)
  state.check()
})

test('forged settled socket messages and truthy non-boolean receipt fields cannot show a receipt', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  await create(widget)
  await emit(page, hashA, {pending: false, status: 'success'})
  await page.clock.runFor(5001)
  await expect(widget.getByRole('dialog', {name: 'Pay Lightning invoice'})).toBeVisible()
  expect(state.statusChecks.length).toBeGreaterThan(1)
  state.statusReply = {paid: 'true'}
  await emit(page, hashA, {pending: false, status: 'settled'})
  await page.clock.runFor(5001)
  await expect(widget.getByRole('dialog', {name: 'Pay Lightning invoice'})).toBeVisible()
  expect(state.statusChecks.every(check => check.id === 'zg_first' && check.hash === hashA && check.origin === firstOrigin)).toBe(true)
  state.check()
})

test('receipt polling recovers a missed socket settlement; API monitoring failures retain the invoice', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.statusFailure = true
  await page.evaluate(() => { window.__widgetTest.throwInvoice = true })
  await create(widget)
  await expect(widget.locator('canvas')).toBeVisible()
  await expect(widget.locator('.zg-monitor')).toContainText('still payable')
  state.statusFailure = false
  state.paid[hashA] = true
  await page.clock.runFor(5001)
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toContainText('21 sats received')
  expect(await invoiceSockets(page)).toEqual([])
  state.check()
})

test('a late verified receipt for closed A cannot mark pending B paid', async ({page, context}) => {
  const state = await setup(page, context), widget = state.widget()
  state.holdStatus = true
  state.paid[hashA] = true
  await create(widget)
  await expect.poll(() => state.statusQueue.length).toBe(1)
  await widget.getByRole('button', {name: 'Close payment dialog'}).click()
  state.holdStatus = false
  await create(widget, 100)
  state.statusQueue.shift()()
  await page.clock.runFor(5001)
  await expect(widget.getByRole('textbox', {name: 'Lightning invoice', exact: true})).toHaveValue(invoiceB)
  expect(await invoiceSockets(page)).toEqual([hashB])
  await settle(page, hashB)
  await expect(widget.getByRole('dialog', {name: 'Payment received'})).toContainText('100 sats received')
  state.check()
})

test('vendored local QR retains exact upstream implementation and isolates AMD/CommonJS globals', () => {
  const start = '// BEGIN unmodified qrcode-generator 1.4.4\n'
  const end = '// END unmodified qrcode-generator 1.4.4\n'
  const original = qrSource.split(start)[1].split(end)[0]
  expect(crypto.createHash('sha256').update(original).digest('hex')).toBe('18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780')
  expect(qrSource).toContain('Copyright (c) 2009 Kazuhiko Arase')
  expect(qrSource).toContain('Permission is hereby granted, free of charge')
  const context = {window: {}, exports: {}, module: {exports: 'untouched'}, define() { throw new Error('Do not register with AMD') }}
  context.define.amd = true
  vm.runInNewContext(qrSource, context)
  expect(context.module.exports).toBe('untouched')
  expect(context.qrcode).toBeUndefined()
  const qr = context.window.ZapGoalsQR.create(0, 'M')
  qr.addData('LIGHTNING:' + invoiceA.toUpperCase(), 'Alphanumeric')
  qr.make()
  expect(qr.getModuleCount()).toBe(25)
  expect(qr.isDark(0, 0)).toBe(true)
})
