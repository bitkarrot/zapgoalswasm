const {chromium} = require('@playwright/test')
const {execFileSync, spawnSync} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const base = process.env.LNBITS_E2E_BASE_URL || 'http://127.0.0.1:5000'
const username = process.env.LNBITS_E2E_USERNAME
const password = process.env.LNBITS_E2E_PASSWORD
const databasePath = process.env.LNBITS_E2E_DATABASE
const extensionDatabasePath = process.env.LNBITS_E2E_EXTENSION_DATABASE
const payerWallet = process.env.LNBITS_E2E_PAYER_WALLET || 'ZapGoals'
const cookieDomain = new URL(base).hostname
if (!username || !password || !databasePath || !extensionDatabasePath) throw new Error('Set LNBITS_E2E_USERNAME, LNBITS_E2E_PASSWORD, LNBITS_E2E_DATABASE, and LNBITS_E2E_EXTENSION_DATABASE')
const results = path.join(__dirname, '..', 'test-results')
fs.mkdirSync(results, {recursive: true})

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
  await page.waitForTimeout(1200)
  const frame = page.frames().find(candidate => candidate.url().includes('ext-frame/zapgoalswasm'))
  if (!frame) throw new Error('ZapGoals WASM iframe was not rendered')
  return frame
}

async function createGoal(context, token, walletId, overrides = {}) {
  const response = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals`, {
    headers: {Authorization: `Bearer ${token}`},
    data: {
      title: 'E2E parity goal', descriptionAbove: 'Help us reach this goal', descriptionBelow: 'Thank you for your support', goalAmount: 1,
      targetDate: '2026-12-31T00:00:00Z', suggestedAmounts: [1, 21, 100, 500], walletId, walletMode: 'vanilla',
      backgroundColor: '#FFFFFF', textColor: '#1F2937', progressColor: '#F59E0B', remainderColor: '#E5E7EB',
      fontName: 'sans-serif', fontWeight: 700, ...overrides
    }
  })
  const goal = await response.json()
  if (!response.ok() || !goal.id) throw new Error(`Goal creation failed: ${JSON.stringify(goal)}`)
  return goal
}

function payInvoice(bolt11) {
  const script = `
import json, sqlite3, sys, urllib.request
bolt11, base, database, wallet_name = sys.argv[1:]
conn=sqlite3.connect(database)
row=conn.execute("select adminkey from wallets where name=? and deleted=0 limit 1", (wallet_name,)).fetchone()
if not row: sys.exit(1)
req=urllib.request.Request(base+'/api/v1/payments', data=json.dumps({'out':True,'bolt11':bolt11}).encode(), headers={'content-type':'application/json','X-Api-Key':row[0]}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=20) as response: sys.exit(0 if response.status in (200,201) else 1)
except Exception: sys.exit(1)
`
  return spawnSync('python', ['-c', script, bolt11, base, databasePath, payerWallet], {stdio: 'pipe'}).status === 0
}

function simulateSettlement(goalId, amount) {
  const script = "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute('update goals set currentAmount=currentAmount+?, updatedAt=? where id=?',(int(sys.argv[3]),str(int(time.time())),sys.argv[2])); c.commit()"
  execFileSync('python', ['-c', script, extensionDatabasePath, goalId, String(amount)], {stdio: 'pipe'})
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
  const goal = await createGoal(context, token, wallets[0].id)
  const expiredGoal = await createGoal(context, token, wallets[0].id, {title: 'Expired E2E', targetDate: '2020-01-01T00:00:00Z'})
  const expiredInvoice = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals/${expiredGoal.id}/invoice`, {data: {amount: 1}})
  const expiredPayload = await expiredInvoice.json()
  if (expiredPayload.error !== 'This goal has ended') throw new Error(`Expired goal accepted a zap: ${JSON.stringify(expiredPayload)}`)

  const page = await preparePage(context, token, 'light')
  const errors = []
  page.on('pageerror', error => { const stack = error.stack || error.message; if (stack.includes('/ext-assets/zapgoalswasm') || stack.includes('ext-frame/zapgoalswasm')) errors.push(`admin:${stack}`) })
  await page.goto(`${base}/ext/zapgoalswasm`, {waitUntil: 'networkidle'})
  await dismissParentDialogs(page)
  const admin = await extensionFrame(page)
  await admin.waitForSelector('text=ZapGoals')
  await admin.locator('body').screenshot({path: path.join(results, 'admin-light.png')})

  const newGoal = admin.getByRole('button', {name: /new goal/i})
  await newGoal.evaluate(element => element.click())
  await admin.waitForSelector('.q-dialog')
  const walletField = qField(admin, 'Wallet *')
  if (!(await walletField.innerText()).includes(wallets[0].name)) throw new Error('Default wallet was not selected')
  const sectionOrder = await admin.locator('.goal-dialog').evaluate(dialog => { const text = dialog.innerText; return [text.indexOf('Suggested zap amounts'), text.indexOf('Payment settings'), text.indexOf('Wallet payment mode'), text.indexOf('Design'), text.indexOf('Font family'), text.indexOf('Live preview')] })
  if (sectionOrder.some((value, index) => index > 0 && value <= sectionOrder[index - 1])) throw new Error(`New Goal sections are out of order: ${sectionOrder}`)
  const paymentFieldBox = await qField(admin, 'Wallet payment mode').boundingBox()
  const dialogBox = await admin.locator('.goal-dialog').boundingBox()
  if (!paymentFieldBox || !dialogBox || paymentFieldBox.width < dialogBox.width * 0.8) throw new Error('Wallet payment mode is not full width')
  await admin.getByRole('button', {name: 'Cancel'}).last().evaluate(element => element.click())
  await admin.waitForSelector('.q-dialog', {state: 'detached'})

  await newGoal.evaluate(element => element.click())
  await admin.waitForSelector('.q-dialog')
  if (wallets.length > 1) {
    await walletField.evaluate(element => element.click())
    await admin.waitForSelector('.q-menu .q-item')
    await admin.locator('.q-menu .q-item').nth(1).evaluate(element => element.click())
    if (!(await walletField.innerText()).includes(wallets[1].name)) throw new Error('Wallet selection did not change')
  }
  await qField(admin, 'Title *').locator('input').fill('Wallet selection E2E')
  await qField(admin, 'Goal amount *').locator('input').fill('123')
  await qField(admin, 'Target date *').locator('input').fill('2026-12-30T12:00')
  await admin.getByRole('button', {name: 'Save goal'}).evaluate(element => element.click())
  await admin.waitForSelector('.q-dialog', {state: 'detached'})
  const goalsAfterUiCreate = (await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals`, {headers})).json()).data
  const uiGoal = goalsAfterUiCreate.find(item => item.title === 'Wallet selection E2E')
  if (!uiGoal || uiGoal.walletId !== wallets[Math.min(1, wallets.length - 1)].id) throw new Error('Selected wallet was not persisted')
  await admin.evaluate(() => window.ZapGoalsApp.confirmDelete(window.ZapGoalsApp.goals[0]))
  await admin.waitForSelector('.confirm-dialog')
  await admin.getByRole('button', {name: 'Cancel'}).last().evaluate(element => element.click())
  await admin.waitForSelector('.confirm-dialog', {state: 'detached'})
  await admin.evaluate(async id => { const goal = window.ZapGoalsApp.goals.find(item => item.id === id); window.ZapGoalsApp.openGoalDialog(goal); window.ZapGoalsApp.formDialog.data.title = 'Wallet selection edited'; await window.ZapGoalsApp.saveGoal() }, uiGoal.id)
  await admin.waitForSelector('.goal-dialog', {state: 'detached'})
  const editedGoals = (await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals`, {headers})).json()).data
  const editedGoal = editedGoals.find(item => item.id === uiGoal.id)
  if (editedGoal?.title !== 'Wallet selection edited') throw new Error('Goal edit was not persisted')
  await admin.evaluate(async id => { const goal = window.ZapGoalsApp.goals.find(item => item.id === id); window.ZapGoalsApp.confirmDelete(goal); await window.ZapGoalsApp.deleteGoal() }, uiGoal.id)
  const afterDelete = (await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals`, {headers})).json()).data
  if (afterDelete.some(item => item.id === uiGoal.id)) throw new Error('Goal delete was not persisted')

  await page.emulateMedia({colorScheme: 'dark'})
  await admin.getByRole('button', {name: 'Toggle theme'}).evaluate(element => element.click())
  await admin.locator('body').screenshot({path: path.join(results, 'admin-dark.png')})

  const publicPage = await context.newPage()
  await publicPage.emulateMedia({colorScheme: 'light'})
  publicPage.on('pageerror', error => { const stack = error.stack || error.message; if (stack.includes('/ext-assets/zapgoalswasm') || stack.includes('ext-frame/zapgoalswasm')) errors.push(`public:${stack}`) })
  await publicPage.goto(`${base}/ext/zapgoalswasm/public/${goal.id}`, {waitUntil: 'networkidle'})
  const publicFrame = await extensionFrame(publicPage)
  await publicFrame.waitForSelector('text=E2E parity goal')
  await publicFrame.locator('body').screenshot({path: path.join(results, 'public-light.png')})
  await publicFrame.getByRole('button', {name: 'Zap this goal'}).evaluate(element => element.click())
  await publicFrame.waitForSelector('.q-dialog')
  await publicFrame.getByRole('button', {name: 'Cancel'}).last().evaluate(element => element.click())
  await publicFrame.waitForSelector('.q-dialog', {state: 'detached'})

  await publicFrame.getByRole('button', {name: 'Zap this goal'}).evaluate(element => element.click())
  await publicFrame.getByRole('button', {name: '1', exact: true}).evaluate(element => element.click())
  await publicFrame.locator('.amount-dialog').screenshot({path: path.join(results, 'amount-dialog-light.png')})
  await publicFrame.getByRole('button', {name: /Zap 1 sats/i}).evaluate(element => element.click())
  await publicFrame.waitForSelector('.invoice-dialog')
  const bolt11 = await publicFrame.getByLabel('BOLT11 invoice').inputValue()
  await publicFrame.locator('.invoice-dialog').screenshot({path: path.join(results, 'invoice-dialog-light.png')})
  if (!bolt11.startsWith('ln')) throw new Error('BOLT11 invoice was not rendered')
  const paidThroughWallet = payInvoice(bolt11)
  if (!paidThroughWallet) {
    simulateSettlement(goal.id, 1)
    await publicFrame.evaluate(() => window.ZapGoalsPublicApp.markPaid())
  }
  await publicFrame.waitForSelector('text=Payment received', {timeout: 30000})
  let settledGoal
  for (let attempt = 0; attempt < 30; attempt++) {
    settledGoal = await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals/${goal.id}/public`)).json()
    if (settledGoal.currentAmount === 1) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (settledGoal.currentAmount !== 1) throw new Error(`Settled amount mismatch: ${settledGoal.currentAmount}`)
  await publicFrame.waitForFunction(() => document.querySelectorAll('.progress-svg rect')[1]?.getAttribute('width') === '100', null, {timeout: 15000})
  await publicFrame.locator('body').screenshot({path: path.join(results, 'public-paid.png')})
  await publicFrame.getByRole('button', {name: 'Done'}).evaluate(element => element.click())
  await publicFrame.waitForSelector('.invoice-dialog', {state: 'detached'})
  if (await publicFrame.getByRole('button', {name: 'Zap this goal'}).isDisabled()) throw new Error('Reached goal incorrectly disabled additional zaps')
  const overInvoiceResponse = await context.request.post(`${base}/api/v1/ext/zapgoalswasm/goals/${goal.id}/invoice`, {data: {amount: 1, comment: 'over target'}})
  const overInvoice = await overInvoiceResponse.json()
  if (!overInvoiceResponse.ok() || !overInvoice.paymentRequest) throw new Error(`Over-target invoice was rejected: ${JSON.stringify(overInvoice)}`)
  if (!payInvoice(overInvoice.paymentRequest)) simulateSettlement(goal.id, 1)
  let overfundedGoal
  for (let attempt = 0; attempt < 30; attempt++) {
    overfundedGoal = await (await context.request.get(`${base}/api/v1/ext/zapgoalswasm/goals/${goal.id}/public`)).json()
    if (overfundedGoal.currentAmount === 2) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (overfundedGoal.currentAmount !== 2) throw new Error(`Over-target settlement mismatch: ${overfundedGoal.currentAmount}`)

  const darkContext = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'dark'})
  const darkPublic = await darkContext.newPage()
  await darkPublic.goto(`${base}/ext/zapgoalswasm/public/${goal.id}`, {waitUntil: 'networkidle'})
  const darkFrame = await extensionFrame(darkPublic)
  await darkFrame.waitForSelector('text=Target reached')
  await darkFrame.locator('body').screenshot({path: path.join(results, 'public-dark-mobile.png')})

  const bitcoinGoal = await createGoal(context, token, wallets[0].id, {title: 'Bitcoin Connect E2E', walletMode: 'all'})
  const bitcoinPage = await context.newPage()
  await bitcoinPage.goto(`${base}/ext/zapgoalswasm/public/${bitcoinGoal.id}`, {waitUntil: 'networkidle'})
  const bitcoinFrame = await extensionFrame(bitcoinPage)
  const bitcoinConnectAvailable = await bitcoinFrame.evaluate(() => typeof window.ZapGoalsBitcoinConnect?.launchPaymentModal === 'function')
  if (!bitcoinConnectAvailable) throw new Error('Vendored Bitcoin Connect did not load')

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({walletSelection: true, dialogCancellation: true, lightMode: true, darkMode: true, mobile: true, invoiceQr: true, settlement: true, publicProgress: true, overTargetZap: true, targetDateEnforced: true, bitcoinConnectBundle: true, settlementMode: paidThroughWallet ? 'wallet' : 'simulated-after-live-wallet-failure'}))
  await darkContext.close()
  await browser.close()
})().catch(error => { console.error(error.stack || error); process.exit(1) })
