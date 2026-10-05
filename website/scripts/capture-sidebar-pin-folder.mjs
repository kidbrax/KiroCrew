/**
 * Screenshot harness for the folder pin.
 *
 * The claim is a filter bypass, so a still of a quiet sidebar proves nothing:
 * the evidence is a NARROWED list in which the pinned folder's sessions are
 * still there while the plain folder's are not. Three stories, each in dark and
 * light:
 *
 *   1. The Running chip is on. "oncall" is pinned: both of its idle sessions
 *      stay listed and the header carries the pin glyph; "research" keeps only
 *      its running session.
 *   2. The folder header menu, open on the pinned folder: Unpin folder is there
 *      and Hide folder is not.
 *   3. The sort-and-filter menu: the checkbox row for the pinned folder reads
 *      checked and inert, with the pin beside its name.
 *   4. "ops" is unchecked in the filter menu and holds the pinned "oncall": its
 *      block stays, with its own session, and so does the pinned child's; the
 *      sibling "research" is the one the uncheck removes.
 *
 * Runs the REAL built SPA (website/dist) behind the shared loopback static
 * server with every /api/** call answered from fixtures (gateway-free). Only
 * the network and the localStorage seed are stubbed; the client code under test
 * is unmodified. The harness fails loudly when a story's premise does not hold
 * on screen (a narrowed-away row still present, a pinned row missing).
 *
 * Usage: node scripts/capture-sidebar-pin-folder.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/sidebar-pin-folder'
mkdirSync(OUT, { recursive: true })

const now = Math.floor(Date.now() / 1000)
const PINNED = 'oncallF'
const PLAIN = 'researchF'

const folders = [
  { id: PINNED, name: 'oncall', order: 0, collapsed: false, pinned: true, color: 'red' },
  { id: PLAIN, name: 'research', order: 1, collapsed: false },
]

/** Story 4: the pinned folder nested under an unchecked parent. */
const PARENT = 'opsF'
const nestedFolders = [
  { id: PARENT, name: 'ops', order: 0, collapsed: false },
  { id: PINNED, name: 'oncall', order: 0, collapsed: false, parent_id: PARENT, pinned: true, color: 'red' },
  { id: PLAIN, name: 'research', order: 1, collapsed: false },
]

const slot = (key, title, folder_id, running, ago) => ({
  key, title, running, messages: 4, agent: 'kirocrew', folder_id,
  modified: now - ago, last_ts: new Date((now - ago) * 1000).toISOString(),
  last_message: running ? 'Reading the alarm history…' : 'Done. Summary posted.',
})

const slots = [
  slot('chat-1-100', 'Sev-2 bridge notes', PINNED, false, 600),
  slot('chat-2-200', 'Pager runbook refresh', PINNED, false, 3600),
  slot('chat-3-300', 'Compare vector stores', PLAIN, true, 60),
  slot('chat-4-400', 'Read the retry RFC', PLAIN, false, 7200),
  slot('chat-5-500', 'Draft the release notes', '', false, 900),
]
const nestedSlots = [...slots, slot('chat-6-600', 'Rota handover', PARENT, false, 1800)]

/** PATCH on a folder answers the merged row, like the real endpoint. */
const extra = (path, route) => {
  const m = path.match(/^\/api\/chat\/folders\/([^/]+)$/)
  if (m && route.request().method() === 'PATCH') {
    const f = folders.find(x => x.id === m[1])
    return json(route, { ...f, ...JSON.parse(route.request().postData() || '{}') }), true
  }
  return false
}

const rect = async locator => {
  const r = await locator.evaluate(el => {
    const b = el.getBoundingClientRect()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  })
  return r
}

async function main() {
  const { srv, base } = await serveDist()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })

  let page = null
  async function load(theme, entries, fixture = { slots, folders }) {
    if (page) await page.close()
    page = await context.newPage()
    logPageProblems(page)
    await stubDashboardApi(page, {
      slots: fixture.slots, folders: fixture.folders, theme, extra,
      localStorageEntries: {
        'mc-active-slot': 'chat-5-500',
        'mc-privacy-notice-v1': '1',
        'mc-sidebar-pinned': 'true',
        ...entries,
      },
    })
    await page.goto(base + '/chat', { waitUntil: 'domcontentloaded' })
    await page.getByText('Sev-2 bridge notes').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(1200)
  }

  for (const theme of ['dark', 'light']) {
    // 1. Running chip on: the pinned folder keeps its idle rows.
    await load(theme, { 'mc-session-running-only': '1' })
    for (const title of ['Sev-2 bridge notes', 'Pager runbook refresh', 'Compare vector stores']) {
      await page.getByText(title).first().waitFor({ state: 'visible', timeout: 15000 })
    }
    for (const title of ['Read the retry RFC', 'Draft the release notes']) {
      if (await page.getByText(title).count()) throw new Error(`${theme}: "${title}" should be narrowed away by the Running chip`)
    }
    await page.getByTestId(`folder-pinned-${PINNED}`).waitFor({ state: 'visible', timeout: 15000 })
    const sidebar = await rect(page.locator('.sidebar').first())
    await page.screenshot({
      path: `${OUT}/01-running-chip-pinned-folder-${theme}.png`,
      clip: { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: Math.min(sidebar.height, 520) },
    })

    // 2. The folder menu on the pinned folder.
    await page.getByTestId(`folder-menu-${PINNED}`).click()
    await page.getByTestId(`folder-pin-${PINNED}`).waitFor({ state: 'visible', timeout: 15000 })
    if (await page.getByTestId(`folder-visibility-${PINNED}`).count()) {
      throw new Error(`${theme}: Hide folder is offered on a pinned folder`)
    }
    const menu = await rect(page.getByTestId(`folder-pin-${PINNED}`).locator('xpath=ancestor::*[@role="menu"]'))
    await page.screenshot({
      path: `${OUT}/02-folder-menu-unpin-${theme}.png`,
      clip: { x: 0, y: Math.max(0, menu.y - 90), width: Math.min(1400, menu.x + menu.width + 40), height: menu.height + 130 },
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // 3. The filter menu: the pinned folder's checkbox row is inert.
    await page.getByLabel('Sort and filter sessions').click()
    const row = page.getByTestId(`folder-filter-${PINNED}`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    if ((await row.getAttribute('aria-checked')) !== 'true' || (await row.getAttribute('data-disabled')) === null) {
      throw new Error(`${theme}: the pinned folder's filter row is not checked-and-inert`)
    }
    const menu2 = await rect(row.locator('xpath=ancestor::*[@role="menu"]'))
    await page.screenshot({
      path: `${OUT}/03-filter-menu-pinned-row-${theme}.png`,
      clip: { x: Math.max(0, menu2.x - 20), y: Math.max(0, menu2.y - 20), width: menu2.width + 40, height: Math.min(900 - menu2.y + 20, menu2.height + 40) },
    })
    await page.keyboard.press('Escape')

    // 4. An unchecked parent holding the pinned folder: the parent's block stays.
    await load(theme, { 'mc-flat-hidden-folders': JSON.stringify([PARENT, PLAIN]) }, { slots: nestedSlots, folders: nestedFolders })
    for (const title of ['Sev-2 bridge notes', 'Pager runbook refresh', 'Rota handover']) {
      await page.getByText(title).first().waitFor({ state: 'visible', timeout: 15000 })
    }
    for (const title of ['Compare vector stores', 'Read the retry RFC']) {
      if (await page.getByText(title).count()) throw new Error(`${theme}: "${title}" should be hidden by the unchecked research folder`)
    }
    const sidebar4 = await rect(page.locator('.sidebar').first())
    await page.screenshot({
      path: `${OUT}/04-unchecked-parent-keeps-pinned-child-${theme}.png`,
      clip: { x: sidebar4.x, y: sidebar4.y, width: sidebar4.width, height: Math.min(sidebar4.height, 560) },
    })
    console.log(`${theme}: four stories captured`)
  }

  await browser.close()
  srv.close()
}

main().catch(err => { console.error(err); process.exit(1) })
