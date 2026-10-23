import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chooseTrayItem, TRAY_ITEMS } from '../../e2e/_harness/launchApp.ts'
import { asksOf, poll, setPreference, showMode } from './app.mjs'

/**
 * `pnpm demo:shots` (docs/demo.md "Shots"): once the scenario reached its interesting moment (a question and a
 * permission open, the late dwarf started), captures the page of each mode as a PNG into `out` (default a fresh
 * `dwarfai-demo-shots-*` folder in the OS temp folder). Page captures only: no OS title bar, no desktop behind. The same
 * app state is shown in every mode, so the shots also show the data carrying from one mode to the next.
 *
 * Panel: the Map, a mine column with its dwarf's question card, Settings. Veta: the strip with its crews, a risen chat.
 * Valle: the Control room with every tier and the needs-you counter, the Work front with its split and the history
 * drawer. A shot that cannot be reached is logged and skipped; the others are still taken.
 */

/** The Valle window's content size for the shots, kept inside the display's work area. */
const VALLE_SIZE = { width: 1600, height: 960 }

/** Lets a move, a dive or an opened drawer settle before a capture. */
const SETTLE_MS = 1_500

export async function captureShots({ app, window, scenario, ids, mineIds, out, log, stopped }) {
  const folder = out ?? mkdtempSync(path.join(tmpdir(), 'dwarfai-demo-shots-'))
  mkdirSync(folder, { recursive: true })
  const taken = []
  const shoot = async (name, page, take) => {
    if (stopped()) return
    try {
      await take?.()
      await sleep(SETTLE_MS)
      const file = path.join(folder, `${name}.png`)
      await page.screenshot({ path: file })
      taken.push(file)
      log(`shot ${name}.png`)
    } catch (error) {
      log(
        `shot ${name} skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      )
    }
  }

  // The moment worth showing: both asks open and the late dwarf at work.
  log('waiting for the question and the permission to open')
  await poll(
    async () => (await asksOf(window)).filter((ask) => ask.state === 'open').map((ask) => ask.kind),
    (kinds) => stopped() || (kinds.includes('question') && kinds.includes('permission')),
    'both asks open',
    240_000
  ).catch((error) => log(error.message))
  const lateKey = scenario.late[0]?.key
  if (lateKey !== undefined) {
    await poll(
      async () => ids[lateKey],
      (id) => stopped() || id !== undefined,
      'the late dwarf started',
      240_000
    ).catch((error) => log(error.message))
  }

  // Panel: shown first through the tray's Open item, as a person brings it back, since a hidden window paints nothing.
  await chooseTrayItem(app, TRAY_ITEMS.open).catch(() => undefined)
  await poll(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => !w.isDestroyed() && w.isVisible() && !w.webContents.getURL().includes('mode=')
        )
      ),
    (shown) => shown,
    'the Panel shows',
    15_000
  ).catch((error) => log(error.message))
  const nav = (label) =>
    window.locator(`.dm-nav .dm-slot[data-label="${label}"]`).click({ timeout: 15_000 })
  await shoot('panel-map', window, () => nav('Map'))
  const asker = scenario.mines
    .flatMap((mine) => mine.crew)
    .find((d) => d.asks && d.provider === 'codex')
  const askerMine = scenario.mines.find((mine) => mine.crew.includes(asker))
  await shoot('panel-mines', window, () => nav('Mines'))
  await shoot('panel-mine-question', window, async () => {
    // Entered from its card on the Mines page: the docked Panel can be too narrow for every Map marker.
    const card = window.locator(`.dm-card[data-mine="${mineIds[askerMine.key]}"] .dm-card__hit`)
    await card.waitFor({ state: 'attached', timeout: 15_000 })
    await card.dispatchEvent('click')
    await window.locator('.shell-mine').waitFor({ timeout: 30_000 })
    const dwarf = window.locator(`.shell-mine button.dm-dwarf[data-dwarf="${ids[asker.key]}"]`)
    // A crowded column overlaps its sprites: the press goes to this dwarf's own button.
    if ((await dwarf.count()) > 0) await dwarf.first().dispatchEvent('click')
  })
  await shoot('panel-settings', window, () => nav('Settings'))
  await nav('Map').catch(() => undefined)

  // Veta.
  let veta = null
  try {
    veta = await showMode(app, window, 'veta')
  } catch (error) {
    log(`Veta did not open: ${error.message}`)
  }
  if (veta !== null) {
    await shoot('veta-strip', veta)
    await shoot('veta-risen-chat', veta, async () => {
      // The first dwarf the strip draws: a mine past the strip's width sits in its overflow.
      await veta.locator('[data-veta-dwarf]').first().dispatchEvent('click')
      await veta.locator('[data-veta-risen][data-shown="true"]').waitFor({ timeout: 15_000 })
    })
  }

  // Valle: the first mine's first two dwarfs pinned, so the Work front can split.
  const first = scenario.mines[0]
  const pins = first.crew
    .slice(0, 2)
    .map((d, order) => ({ dwarfId: ids[d.key], mineId: mineIds[first.key], order }))
    .filter((pin) => pin.dwarfId !== undefined)
  if (pins.length === 2) await setPreference(window, 'pins', pins)
  let valle = null
  try {
    valle = await showMode(app, veta ?? window, 'valle')
  } catch (error) {
    log(`Valle did not open: ${error.message}`)
  }
  if (valle !== null) {
    await app.evaluate(({ BrowserWindow, screen }, size) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('mode=valle')
      )
      if (win === undefined) return
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      win.setContentBounds({
        x: area.x,
        y: area.y,
        width: Math.min(size.width, area.width),
        height: Math.min(size.height, area.height)
      })
      win.webContents.setZoomFactor(1)
    }, VALLE_SIZE)
    const root = valle.locator('[data-valle-root]')
    const settled = () =>
      root.and(valle.locator('[data-motion="none"]')).waitFor({ timeout: 15_000 })
    await shoot('valle-control-room', valle, async () => {
      await valle
        .locator('[data-preset-tab="control"]')
        .click({ timeout: 15_000 })
        .catch(() => undefined)
      await settled()
      await valle.locator('[data-needs-counter]').waitFor({ timeout: 30_000 })
    })
    await shoot('valle-work-front-split', valle, async () => {
      await valle
        .locator(`[data-valle-column="${mineIds[first.key]}"] button.dm-vz__dive`)
        .click({ timeout: 15_000 })
      await settled()
      const split = valle.locator('button.dm-cdeck__split')
      if ((await split.getAttribute('aria-pressed')) !== 'true')
        await split.click({ timeout: 15_000 })
      await valle.locator('.dm-cdeck__pane').nth(1).waitFor({ timeout: 15_000 })
    })
    await shoot('valle-work-front-history', valle, async () => {
      await valle.locator('button.dm-cdeck__histbar').click({ timeout: 15_000 })
      await valle.locator('.dm-cdeck[data-drawer="open"]').waitFor({ timeout: 15_000 })
    })
    await showMode(app, valle, 'panel').catch(() => undefined)
  }
  log(`${taken.length} shots taken`)
  return folder
}
