import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chooseTrayItem, TRAY_ITEMS } from '../../e2e/_harness/launchApp.ts'
import { answerQuestion, asksOf, chatOf, poll, setPreference, showMode } from './app.mjs'

/**
 * `pnpm demo:shots` (docs/demo.md "Shots"): page captures of each mode as PNGs into a folder (default a fresh
 * `dwarfai-demo-shots-*` folder in the OS temp folder). Page captures only: no OS title bar, no desktop behind. The same
 * app state is shown in every mode, so the shots also show the data carrying from one mode to the next.
 *
 * - From the start of the timeline, beside it: a dwarf caught walking in on the Panel's open mine column.
 * - Once a question and a permission are open: the Panel's Map, Mines page, a column with its foreman's question card
 *   and Settings; Veta's strip, a dwarf caught walking in, a risen chat; Valle's Control room with every tier and the
 *   needs-you counter, the Work front with its split and the history drawer.
 *
 * A shot that cannot be reached is logged and skipped; the others are still taken.
 */

/** The Valle window's content size for the shots, kept inside the display's work area. */
const VALLE_SIZE = { width: 1600, height: 960 }

/** Lets a move, a dive or an opened drawer settle before a capture. */
const SETTLE_MS = 1_500

/** The shots' folder: `out`, or a fresh `dwarfai-demo-shots-*` folder in the OS temp folder. */
export function shotsFolder(out) {
  const folder = out ?? mkdtempSync(path.join(tmpdir(), 'dwarfai-demo-shots-'))
  mkdirSync(folder, { recursive: true })
  return folder
}

/** A capture function into `folder`: runs `take`, lets the page settle (`settleMs`), saves `<name>.png`. */
export function shooter(folder, log, stopped) {
  const taken = []
  const shoot = async (name, page, take, settleMs = SETTLE_MS) => {
    if (stopped()) return false
    try {
      await take?.()
      await sleep(settleMs)
      const file = path.join(folder, `${name}.png`)
      await page.screenshot({ path: file })
      taken.push(file)
      log(`shot ${name}.png`)
      return true
    } catch (error) {
      const why = error instanceof Error ? error.message.split('\n')[0] : String(error)
      log(`shot ${name} skipped: ${why}`)
      return false
    }
  }
  return { shoot, taken }
}

/** Whether a dwarf of the open mine column walks now: its leg's `--walk-ms` is set (SceneDwarf.vue). */
const PANEL_WALKING = `[...document.querySelectorAll('.shell-mine .dm-dwarf')].some((d) => /--walk-ms:\\s*[1-9]/.test(d.getAttribute('style') ?? ''))`

/**
 * Catches a dwarf walking in on the Panel's open mine column as it arrives (MineColumn.vue walks in a dwarf that turns
 * up after the column opened). Runs beside the timeline from its start, so the first arrivals are seen.
 */
export async function watchPanelWalk({ window, shoot, log, stopped }) {
  try {
    await poll(
      () => window.evaluate(PANEL_WALKING),
      (walking) => walking || stopped(),
      'a dwarf walks in on the Panel',
      120_000
    )
    await shoot('panel-walk-in', window, undefined, 0)
  } catch (error) {
    log(`shot panel-walk-in skipped: ${error.message.split('\n')[0]}`)
  }
}

export async function captureShots({
  app,
  window,
  scenario,
  ids,
  mineIds,
  shoot,
  taken,
  log,
  stopped
}) {
  // The moment worth showing: a question and a permission open.
  log('waiting for a question and a permission to open')
  await poll(
    async () => (await asksOf(window)).filter((ask) => ask.state === 'open').map((ask) => ask.kind),
    (kinds) => stopped() || (kinds.includes('question') && kinds.includes('permission')),
    'both asks open',
    240_000
  ).catch((error) => log(error.message))

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
  await shoot('panel-mines', window, () => nav('Mines'))
  // The question card: a Codex foreman's, since only a launched dwarf's ask reaches the app.
  const asker = scenario.mines
    .map((mine) => mine.foreman)
    .find((d) => d?.asks === true && d.provider === 'codex')
  const askerMine = scenario.mines.find((mine) => mine.foreman === asker)
  if (asker !== undefined) {
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
  }
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
    // A worker walking in: Veta walks each arrival in from its chamber's entrance (VetaChamber.vue, machine 26).
    try {
      await poll(
        () => veta.locator('[data-veta-dwarf][data-walk="in"]').count(),
        (count) => count > 0 || stopped(),
        'a dwarf walks in on Veta',
        120_000
      )
      await shoot('veta-walk-in', veta, undefined, 0)
    } catch (error) {
      log(`shot veta-walk-in skipped: ${error.message.split('\n')[0]}`)
    }
    await shoot('veta-risen-chat', veta, async () => {
      // The first dwarf the strip draws: a mine past the strip's width sits in its overflow.
      await veta.locator('[data-veta-dwarf]').first().dispatchEvent('click')
      await veta.locator('[data-veta-risen][data-shown="true"]').waitFor({ timeout: 15_000 })
    })
  }

  // Valle: the first mine's foreman and first worker pinned, so the Work front can split.
  const first = scenario.mines[0]
  const pins = [first.foreman, first.workers[0]]
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
  // The Codex foreman's question answered as the card does (first option of each step), so a Codex reply exists on both
  // paths (live item and rollout line); then a while for the Host to observe the rollout too.
  if (asker !== undefined && !stopped()) {
    const ask = (await asksOf(window)).find(
      (a) => a.dwarfId === ids[asker.key] && a.kind === 'question' && a.state === 'open'
    )
    const questions = scenario.behaviors[asker.behavior].ask?.questions ?? []
    if (ask !== undefined) {
      const answers = questions.map((q, step) => ({ step, option: q.options[0] }))
      const ok = await answerQuestion(window, ask.id, answers)
      log(`answered ${asker.name ?? asker.key}'s question: ${ok ? 'accepted' : 'refused'}`)
      await poll(
        async () => (await chatOf(window, ids[asker.key])).filter((m) => m.role === 'dwarf').length,
        (replies) => replies > 0 || stopped(),
        `${asker.name ?? asker.key} replies`,
        60_000
      ).catch((error) => log(error.message))
      await sleep(10_000)
    }
  }
  // Each foreman's chat as the Host keeps it: a message stored twice shows twice, so a doubled line is named.
  for (const foreman of scenario.mines.map((mine) => mine.foreman)) {
    const chat = await chatOf(window, ids[foreman.key]).catch(() => [])
    const doubled = chat.filter(
      (m, at) => at > 0 && m.role === chat[at - 1].role && m.text === chat[at - 1].text
    ).length
    log(`chat check ${foreman.name ?? foreman.key}: ${chat.length} messages, ${doubled} doubled`)
  }
  log(`${taken.length} shots taken`)
}
