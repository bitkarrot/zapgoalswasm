const {chromium} = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

const base = process.env.LNBITS_E2E_BASE_URL || 'http://127.0.0.1:5000'
const username = process.env.LNBITS_E2E_USERNAME || 'e2etest'
const password = process.env.LNBITS_E2E_PASSWORD || 'e2etestpass123'
const cookieDomain = new URL(base).hostname
const results = path.join(__dirname, '..', 'test-results')
fs.mkdirSync(results, {recursive: true})

const testResults = {steps: [], screenshots: [], errors: []}

function log(step, ok, detail = '') {
  const entry = {step, ok, detail}
  testResults.steps.push(entry)
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${step}${detail ? ' — ' + detail : ''}`)
}

async function authenticate(context) {
  const response = await context.request.post(`${base}/api/v1/auth`, {data: {username, password}})
  if (!response.ok()) throw new Error(`Authentication failed: ${response.status()}`)
  return (await response.json()).access_token
}

async function preparePage(context, token, colorScheme) {
  await context.addCookies([
    {name: 'cookie_access_token', value: token, domain: cookieDomain, path: '/'},
    {name: 'is_lnbits_user_authorized', value: 'true', domain: cookieDomain, path: '/'}
  ])
  const page = await context.newPage()
  await page.emulateMedia({colorScheme})
  return page
}

async function dismissParentDialogs(page) {
  const button = page.getByRole('button', {name: /I UNDERSTAND/i})
  if (await button.isVisible().catch(() => false)) await button.click()
}

async function extensionFrame(page) {
  await page.waitForTimeout(1500)
  const frame = page.frames().find(candidate => candidate.url().includes('ext-frame/zapgoalswasm'))
  if (!frame) throw new Error('ZapGoals WASM iframe was not rendered')
  return frame
}

async function createGoal(context, token, walletId, overrides = {}) {
  const response = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals`, {
    headers: {Authorization: `Bearer ${token}`},
    data: {
      title: 'E2E Recurring Test', descriptionAbove: 'Help us reach this goal', descriptionBelow: 'Thank you',
      goalAmount: 100, targetDate: '2026-12-31T00:00:00Z', suggestedAmounts: [1, 21, 100, 500],
      walletId, walletMode: 'vanilla', backgroundColor: '#FFFFFF', textColor: '#1F2937',
      progressColor: '#F59E0B', remainderColor: '#E5E7EB', fontName: 'sans-serif', fontWeight: 700,
      nostrPubkey: '', lightningAddressUsername: '', recurring: false, recurrenceUnit: 'month',
      recurrenceInterval: 1, recurrenceDayOfMonth: 0, targetWalletId: '', rolloverMode: 'counts_as_progress',
      sweepMode: 'target_amount', ...overrides
    }
  })
  const goal = await response.json()
  if (!response.ok() || !goal.id) throw new Error(`Goal creation failed: ${JSON.stringify(goal)}`)
  return goal
}

function qField(frame, label) {
  return frame.locator('.q-field').filter({has: frame.locator(`.q-field__label:text-is("${label}")`)}).first()
}

;(async () => {
  const browser = await chromium.launch({headless: true})
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}})
  const token = await authenticate(context)
  const headers = {Authorization: `Bearer ${token}`}

  const walletResponse = await context.request.get(`${base}/api/v1/ext/zapgoalswasm/wallets`, {headers})
  const wallets = (await walletResponse.json()).data
  if (!wallets.length) throw new Error('No wallets available')
  const walletId = wallets[0].id
  log('setup: get wallets', true, `${wallets.length} wallet(s), using ${wallets[0].name}`)

  // ============================================
  // TEST 1: Admin panel — recurring goal creation, sweep, period history, embed dialog
  // ============================================
  console.log('\n--- TEST 1: Admin panel ---')

  // Create a recurring goal via API
  const recurringGoal = await createGoal(context, token, walletId, {
    title: 'E2E Recurring Monthly', recurring: true, recurrenceUnit: 'month',
    recurrenceInterval: 1, targetWalletId: walletId, sweepMode: 'target_amount',
    rolloverMode: 'counts_as_progress', goalAmount: 100
  })
  log('1a: create recurring goal via API', recurringGoal.recurring === true, `id=${recurringGoal.id}, recurring=${recurringGoal.recurring}, unit=${recurringGoal.recurrenceUnit}`)

  // Create a non-recurring goal for comparison
  const simpleGoal = await createGoal(context, token, walletId, {
    title: 'E2E Simple Goal', recurring: false, goalAmount: 50
  })
  log('1b: create simple goal via API', simpleGoal.recurring === false, `id=${simpleGoal.id}`)

  // Open admin panel
  const adminPage = await preparePage(context, token, 'light')
  const adminErrors = []
  adminPage.on('pageerror', error => { const stack = error.stack || error.message; if (stack.includes('zapgoalswasm')) adminErrors.push(`admin:${stack}`) })
  await adminPage.goto(`${base}/ext/zapgoalswasm`, {waitUntil: 'networkidle'})
  await dismissParentDialogs(adminPage)
  const admin = await extensionFrame(adminPage)
  await admin.waitForSelector('text=ZapGoals')
  await admin.locator('body').screenshot({path: path.join(results, 'admin-light.png')})
  testResults.screenshots.push('admin-light.png')
  log('1c: admin panel loads', true)

  // Verify both goals appear in the table
  await admin.waitForSelector(`text=E2E Recurring Monthly`)
  await admin.waitForSelector(`text=E2E Simple Goal`)
  log('1d: goals visible in admin table', true, 'both recurring and simple goals listed')

  // Test recurring form: open new goal dialog and verify recurring section
  await admin.getByRole('button', {name: /new goal/i}).evaluate(el => el.click())
  await admin.waitForSelector('.q-dialog')
  // Verify recurring toggle exists (q-toggle renders label in a div, not a label element)
  const recurringToggle = admin.locator('.q-toggle').filter({hasText: 'Enable recurring periods'})
  const toggleVisible = await recurringToggle.isVisible().catch(() => false)
  log('1e: recurring toggle visible in form', toggleVisible)

  if (toggleVisible) {
    // Enable recurring and verify unit/mode selectors appear
    await admin.locator('input[type="checkbox"]').first().evaluate(el => el.click()).catch(() => {})
    await admin.waitForTimeout(300)
    // Check recurrence unit selector
    const unitField = qField(admin, 'Recurrence unit')
    const unitVisible = await unitField.isVisible().catch(() => false)
    log('1f: recurrence unit selector appears when toggle enabled', unitVisible)

    // Check sweep mode selector
    const sweepField = qField(admin, 'Sweep mode')
    const sweepVisible = await sweepField.isVisible().catch(() => false)
    log('1g: sweep mode selector appears', sweepVisible)

    // Check rollover mode selector
    const rolloverField = qField(admin, 'Rollover mode')
    const rolloverVisible = await rolloverField.isVisible().catch(() => false)
    log('1h: rollover mode selector appears', rolloverVisible)
  }

  // Close dialog
  await admin.getByRole('button', {name: 'Cancel'}).last().evaluate(el => el.click())
  await admin.waitForSelector('.q-dialog', {state: 'detached'})

  // Test embed dialog
  const embedBtn = admin.locator('button[aria-label="Embed"]').first()
  const embedBtnVisible = await embedBtn.isVisible().catch(() => false)
  log('1i: embed button visible', embedBtnVisible)

  if (embedBtnVisible) {
    await embedBtn.evaluate(el => el.click())
    await admin.waitForSelector('.embed-dialog')
    // Check iframe tab
    const iframeTab = admin.locator('.q-tab:has-text("Iframe")')
    const iframeTabVisible = await iframeTab.isVisible().catch(() => false)
    log('1j: embed dialog iframe tab', iframeTabVisible)

    // Check script tab
    await admin.locator('.q-tab:has-text("Script")').evaluate(el => el.click()).catch(() => {})
    const scriptTextarea = admin.locator('.embed-dialog textarea').last()
    const scriptValue = await scriptTextarea.inputValue().catch(() => '')
    const hasScriptSnippet = scriptValue.includes('embed.js') && scriptValue.includes('data-goal')
    log('1k: embed script snippet contains embed.js and data-goal', hasScriptSnippet, scriptValue.substring(0, 80))

    await admin.locator('.embed-dialog').screenshot({path: path.join(results, 'embed-dialog.png')})
    testResults.screenshots.push('embed-dialog.png')

    // Close embed dialog
    await admin.locator('.embed-dialog button:has-text("Close")').evaluate(el => el.click()).catch(() => {})
    await admin.waitForSelector('.embed-dialog', {state: 'detached'}).catch(() => {})
  }

  // Test sweep button on recurring goal
  const sweepBtn = admin.locator('button[aria-label="Sweep period"]').first()
  const sweepBtnVisible = await sweepBtn.isVisible().catch(() => false)
  log('1l: sweep button visible for recurring goal', sweepBtnVisible)

  if (sweepBtnVisible) {
    await sweepBtn.evaluate(el => el.click())
    await admin.waitForTimeout(2000)
    // Check that the goal was swept via API
    const sweptGoal = await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals`, {headers})).json()
    const updated = sweptGoal.data.find(g => g.id === recurringGoal.id)
    log('1m: sweep advanced period index', updated && updated.periodIndex === 1, `periodIndex=${updated?.periodIndex}`)
  }

  // Test period history dialog
  const historyBtn = admin.locator('button[aria-label="Period history"]').first()
  const historyBtnVisible = await historyBtn.isVisible().catch(() => false)
  log('1n: period history button visible', historyBtnVisible)

  if (historyBtnVisible) {
    await historyBtn.evaluate(el => el.click())
    await admin.waitForSelector('.periods-dialog')
    await admin.waitForTimeout(1000)
    const periodsDialog = admin.locator('.periods-dialog')
    const hasTable = await periodsDialog.locator('table').isVisible().catch(() => false)
    log('1o: period history dialog shows table', hasTable)

    if (hasTable) {
      const rowCount = await periodsDialog.locator('tbody tr').count()
      log('1p: period history has rows', rowCount > 0, `${rowCount} period(s) recorded`)
      await periodsDialog.screenshot({path: path.join(results, 'period-history.png')})
      testResults.screenshots.push('period-history.png')
    }

    await periodsDialog.locator('button:has-text("Close")').evaluate(el => el.click()).catch(() => {})
    await admin.waitForSelector('.periods-dialog', {state: 'detached'}).catch(() => {})
  }

  // ============================================
  // TEST 2: Public page — recurring badge, font weight, payment flow
  // ============================================
  console.log('\n--- TEST 2: Public page ---')

  const publicPage = await context.newPage()
  await publicPage.emulateMedia({colorScheme: 'light'})
  publicPage.on('pageerror', error => { const stack = error.stack || error.message; if (stack.includes('zapgoalswasm')) adminErrors.push(`public:${stack}`) })
  await publicPage.goto(`${base}/ext/zapgoalswasm/public/${recurringGoal.id}`, {waitUntil: 'networkidle'})
  const pubFrame = await extensionFrame(publicPage)
  await pubFrame.waitForSelector('text=E2E Recurring Monthly')
  await pubFrame.locator('body').screenshot({path: path.join(results, 'public-recurring.png')})
  testResults.screenshots.push('public-recurring.png')
  log('2a: public page loads for recurring goal', true)

  // Check recurring badge
  const recurringBadge = pubFrame.locator('.recurring-badge')
  const badgeVisible = await recurringBadge.isVisible().catch(() => false)
  const badgeText = badgeVisible ? await recurringBadge.textContent() : ''
  log('2b: recurring badge visible', badgeVisible, `text="${badgeText?.trim()}"`)

  // Check font weight is applied (fontWeight was set to 700)
  const titleEl = pubFrame.locator('.goal-title')
  const titleFontWeight = await titleEl.evaluate(el => {
    const style = getComputedStyle(el)
    // Check both inline style and computed style
    return {computed: style.fontWeight, inline: el.style.fontWeight}
  }).catch(() => ({}))
  const fontWeightApplied = titleFontWeight.computed === '700' || titleFontWeight.computed === 'bold' || titleFontWeight.inline === '700'
  log('2c: font weight 700 applied to title', fontWeightApplied, `computed=${titleFontWeight.computed}, inline=${titleFontWeight.inline}`)

  // Test amount dialog and invoice creation
  await pubFrame.getByRole('button', {name: 'Zap this goal'}).evaluate(el => el.click())
  await pubFrame.waitForSelector('.q-dialog')
  await pubFrame.getByRole('button', {name: '1', exact: true}).evaluate(el => el.click())
  await pubFrame.locator('.amount-dialog').screenshot({path: path.join(results, 'amount-dialog.png')})
  testResults.screenshots.push('amount-dialog.png')
  await pubFrame.getByRole('button', {name: /Zap 1 sats/i}).evaluate(el => el.click())
  await pubFrame.waitForSelector('.invoice-dialog', {timeout: 15000})
  const bolt11 = await pubFrame.getByLabel('BOLT11 invoice').inputValue()
  await pubFrame.locator('.invoice-dialog').screenshot({path: path.join(results, 'invoice-dialog.png')})
  testResults.screenshots.push('invoice-dialog.png')
  log('2d: invoice created with BOLT11', bolt11.startsWith('ln'), `prefix=${bolt11.substring(0, 6)}`)

  // Close invoice dialog
  await pubFrame.locator('.invoice-dialog button:has-text("Close")').evaluate(el => el.click()).catch(() => {})
  await pubFrame.waitForSelector('.invoice-dialog', {state: 'detached'}).catch(() => {})

  // ============================================
  // TEST 3: Embed system — iframe and JS widget
  // ============================================
  console.log('\n--- TEST 3: Embed system ---')

  // Test 3a: iframe embed page (LNbits wraps UI routes in an extension iframe)
  const embedPage = await context.newPage()
  await embedPage.goto(`${base}/ext/zapgoalswasm/public/${simpleGoal.id}/embed`, {waitUntil: 'networkidle'})
  await embedPage.waitForTimeout(2000)
  // The embed.html content is inside the ext-frame iframe
  const embedFrame = embedPage.frames().find(f => f.url().includes('ext-frame/zapgoalswasm'))
  const embedCardVisible = embedFrame ? await embedFrame.locator('#zapgoals-card').isVisible().catch(() => false) : false
  log('3a: iframe embed page renders card', embedCardVisible)

  if (embedCardVisible) {
    const embedTitle = await embedFrame.locator('.zg-title').textContent().catch(() => '')
    log('3b: iframe embed shows goal title', embedTitle.includes('E2E Simple Goal'), `title="${embedTitle?.trim()}"`)

    const embedZapBtn = embedFrame.locator('.zg-zap-btn')
    const embedZapBtnVisible = await embedZapBtn.isVisible().catch(() => false)
    log('3c: iframe embed shows zap button', embedZapBtnVisible)

    await embedPage.locator('body').screenshot({path: path.join(results, 'embed-iframe.png')})
    testResults.screenshots.push('embed-iframe.png')
  }

  // Test 3d: JS widget embed
  const widgetPage = await context.newPage()
  await widgetPage.setContent(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>Widget Test</title></head>
    <body>
      <h1>External Page</h1>
      <div id="widget-container"></div>
      <script src="${base}/ext-assets/zapgoalswasm/js/embed.js" data-goal="${simpleGoal.id}" async></script>
    </body></html>
  `, {waitUntil: 'networkidle'})
  await widgetPage.waitForTimeout(3000)

  // The widget creates a shadow DOM in a container before the script tag
  const widgetContainer = widgetPage.locator('.zapgoals-widget-container')
  const containerExists = await widgetContainer.count() > 0
  log('3d: JS widget container created', containerExists)

  if (containerExists) {
    // Check shadow DOM content
    const shadowContent = await widgetContainer.evaluate(el => {
      const shadow = el.shadowRoot
      if (!shadow) return null
      const card = shadow.querySelector('.zg-card')
      if (!card) return null
      const title = shadow.querySelector('.zg-title')
      const zapBtn = shadow.querySelector('.zg-zap-btn')
      return {
        cardExists: !!card,
        title: title ? title.textContent : '',
        zapBtnExists: !!zapBtn
      }
    })
    log('3e: JS widget shadow DOM renders card', shadowContent?.cardExists === true)
    log('3f: JS widget shows goal title', shadowContent?.title?.includes('E2E Simple Goal') === true, `title="${shadowContent?.title?.trim()}"`)
    log('3g: JS widget shows zap button', shadowContent?.zapBtnExists === true)

    if (shadowContent?.cardExists) {
      await widgetPage.locator('body').screenshot({path: path.join(results, 'embed-widget.png')})
      testResults.screenshots.push('embed-widget.png')
    }
  }

  // Test 3h: Verify embed.js static asset is served with correct content type
  const embedJsResponse = await context.request.get(`${base}/ext-assets/zapgoalswasm/js/embed.js`)
  const embedJsOk = embedJsResponse.ok()
  const embedJsContentType = embedJsResponse.headers()['content-type'] || ''
  log('3h: embed.js served with JS content type', embedJsOk && embedJsContentType.includes('javascript'), `status=${embedJsResponse.status()}, type=${embedJsContentType}`)

  // Test 3i: Verify embed route returns HTML
  const embedRouteResponse = await context.request.get(`${base}/ext/zapgoalswasm/public/${simpleGoal.id}/embed`)
  const embedRouteOk = embedRouteResponse.ok()
  const embedRouteContentType = embedRouteResponse.headers()['content-type'] || ''
  log('3i: embed page route returns HTML', embedRouteOk && embedRouteContentType.includes('html'), `status=${embedRouteResponse.status()}, type=${embedRouteContentType}`)

  // ============================================
  // TEST 4: API endpoints — sweep and periods
  // ============================================
  console.log('\n--- TEST 4: API endpoints ---')

  // Test 4a: Sweep via API
  const sweepResponse = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals/${recurringGoal.id}/sweep`, {headers})
  const sweepResult = await sweepResponse.json()
  log('4a: POST /goals/{id}/sweep', sweepResponse.ok(), `periodIndex=${sweepResult.newPeriodIndex}, moved=${sweepResult.movedAmount}`)

  // Test 4b: List periods via API
  const periodsResponse = await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals/${recurringGoal.id}/periods`, {headers})
  const periodsResult = await periodsResponse.json()
  const periodsCount = periodsResult.data?.length || 0
  log('4b: GET /goals/{id}/periods', periodsResponse.ok(), `${periodsCount} period(s) returned`)
  if (periodsCount > 0) {
    const lastPeriod = periodsResult.data[0]
    log('4c: period record has expected fields',
      lastPeriod.goalId === recurringGoal.id && lastPeriod.periodIndex !== undefined && lastPeriod.zappedAmount !== undefined,
      `index=${lastPeriod.periodIndex}, zapped=${lastPeriod.zappedAmount}, moved=${lastPeriod.movedAmount}`)
  }

  // Test 4d: Sweep non-recurring goal should return an error in the JSON body
  // (WASM runtime returns HTTP 200 with error JSON, not an HTTP error status)
  const badSweepResponse = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals/${simpleGoal.id}/sweep`, {headers})
  const badSweepResult = await badSweepResponse.json()
  log('4d: sweep non-recurring goal rejected', badSweepResult.error?.includes('not recurring'), `error="${badSweepResult.error}"`)

  // ============================================
  // Summary
  // ============================================
  console.log('\n--- SUMMARY ---')
  const passed = testResults.steps.filter(s => s.ok).length
  const failed = testResults.steps.filter(s => !s.ok).length
  console.log(`Total: ${testResults.steps.length}, Passed: ${passed}, Failed: ${failed}`)
  console.log(`Screenshots: ${testResults.screenshots.join(', ')}`)
  if (adminErrors.length) console.log(`Browser errors: ${adminErrors.join(' | ')}`)

  // Write results JSON
  fs.writeFileSync(path.join(results, 'e2e-recurring-results.json'), JSON.stringify({...testResults, browserErrors: adminErrors}, null, 2))

  await browser.close()

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('\nAll tests passed!')
})().catch(error => { console.error(error.stack || error); process.exit(1) })
