import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { answerFirstRunStep } from '../_harness/firstRunStep.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import { seedClaudeStubSession } from '../cut-1/claudeStubWorld.ts'

/**
 * L9 (ISSUE-262; 17 §1.12): the Panel shell's logical Tab order on either dock, and the narrow-screen rule, measured in
 * the built app's real layout, which jsdom cannot give (`App.test.ts` pins the declarations behind both).
 *
 * The world is the cut-1 fixture: one observed Claude session in one mine (`claudeStubWorld.ts`), so a mine column with
 * a dwarf can be opened from the Map and the dwarf's chat docked in the window slot, as a person does it.
 */

test.describe.configure({ timeout: 240_000 })

/** The parts of the shell, in the logical order Tab walks them (screens/shell.md, Left to right; NFR-A11Y-13). */
type Part = 'window' | 'nav' | 'page' | 'mine'

/**
 * The focused element: a stable identity for the stop (its child-index path), so a walk knows when it has come
 * round, and which part of the shell holds it, `null` for none of them. `null` altogether while the document itself
 * holds the focus. A script string, since this file is compiled without the DOM library.
 */
const FOCUSED_STOP = `(() => {
  const active = document.activeElement
  if (active === null || active === document.body) return null
  const path = []
  for (let node = active; node.parentElement; node = node.parentElement)
    path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node))
  const part = active.closest('.dock-window') ? 'window'
    : active.closest('.dm-nav') ? 'nav'
    : active.closest('.shell-secondary') ? 'page'
    : active.closest('.shell-mine') ? 'mine'
    : null
  return { id: path.join('.'), part }
})()`

/**
 * Moves the sequential focus navigation starting point to the start of the document (`'start'`) or its end
 * (`'end'`), with no element focused, so the next Tab (or Shift+Tab) walks from there.
 *
 * `blur()` alone is not enough: it hands the focus back to the document but leaves the starting point where the focus
 * was (HTML, "sequential focus navigation starting point"), so after a click on a dwarf or a Map marker the next Tab
 * went on from that control instead of from the top. A focusable but untabbable marker at the chosen end takes the
 * focus and gives it back, which puts the starting point there; it is never a Tab stop itself.
 */
const walkFrom = (end: 'start' | 'end'): string => `(() => {
  document.querySelector('[data-e2e-walk-start]')?.remove()
  const marker = document.createElement('span')
  marker.tabIndex = -1
  marker.setAttribute('data-e2e-walk-start', '')
  document.body.${end === 'start' ? 'prepend' : 'append'}(marker)
  marker.focus()
  marker.blur()
})()`

/** Removes the marker `walkFrom` left, once the walk is over. */
const END_WALK = "document.querySelector('[data-e2e-walk-start]')?.remove()"

/**
 * The parts Tab (or Shift+Tab) visits from the start (or the end) of the document, in order, each run of stops inside
 * one part counted once. Walks until the focus comes back to the document itself or to the first stop, with a cap
 * well above the shell's own number of controls so a trap fails the case instead of hanging it.
 */
async function partsWalked(window: Page, key: 'Tab' | 'Shift+Tab'): Promise<Part[]> {
  await window.evaluate(walkFrom(key === 'Tab' ? 'start' : 'end'))
  const parts: Part[] = []
  let first: string | null = null
  for (let stop = 0; stop < 400; stop++) {
    await window.keyboard.press(key)
    const focused = (await window.evaluate(FOCUSED_STOP)) as {
      id: string
      part: Part | null
    } | null
    if (focused === null || focused.id === first) break
    first ??= focused.id
    if (focused.part !== null && parts[parts.length - 1] !== focused.part) parts.push(focused.part)
  }
  await window.evaluate(END_WALK)
  return parts
}

/** One element's box in the window, rounded to whole CSS pixels. */
async function box(
  window: Page,
  selector: string
): Promise<{ left: number; right: number; width: number }> {
  const rect = await window
    .locator(selector)
    .first()
    .evaluate((element) => {
      const { left, right, width } = element.getBoundingClientRect()
      return { left, right, width }
    })
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width)
  }
}

test.describe('the Panel shell: Tab order and the narrow screen (ISSUE-262)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  /** The Panel shown over the fixture world, the first-run step answered, on the Map page. */
  async function openPanel(): Promise<Page> {
    profile = createIsolatedProfile()
    const owned = profile
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    // Seeded once the Host is up, so the session is observed as live (owner decision 2026-10-10, ADR-006 item 8).
    seedClaudeStubSession(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    return window
  }

  /** Docks the Panel on `edge` from Settings, as a person does, and comes back to the Map page. */
  async function dock(window: Page, edge: 'left' | 'right'): Promise<void> {
    if ((await window.locator(`.panel-dock.edge-${edge}`).count()) === 1) return
    await window.locator('.dm-nav .dm-slot[data-label="Settings"]').click()
    await window.locator(`.position-${edge}`).click()
    await expect(window.locator(`.panel-dock.edge-${edge}`), `the Panel docks ${edge}`).toHaveCount(
      1,
      {
        timeout: 30_000
      }
    )
    await window.locator('.dm-nav .dm-slot[data-label="Map"]').click()
  }

  /** Opens the fixture mine from its Map marker. */
  async function openMine(window: Page): Promise<void> {
    if ((await window.locator('.shell-mine').count()) === 1) return
    await window.locator('.dm-marker').first().click({ timeout: 30_000 })
    await expect(window.locator('.shell-mine'), 'the mine column is open').toHaveCount(1, {
      timeout: 30_000
    })
  }

  /** Opens the chat of the mine's one dwarf in the window slot. */
  async function openChat(window: Page): Promise<void> {
    if ((await window.locator('.dock-window').count()) === 1) return
    const dwarf = window.locator('button.dm-dwarf[data-dwarf]')
    await expect(dwarf, 'the observed dwarf is drawn on its mine').toHaveCount(1, {
      timeout: 60_000
    })
    await dwarf.click()
    await expect(window.locator('.dock-window'), 'the chat is in the window slot').toHaveCount(1, {
      timeout: 30_000
    })
  }

  test('[US-SHELL-009.AC01, US-SHELL-009.AC02, NFR-A11Y-13] Tab visits window, nav, page, then the open mine and its dwarfs on either dock', async () => {
    const window = await openPanel()
    for (const edge of ['right', 'left'] as const) {
      await dock(window, edge)
      await openMine(window)
      await openChat(window)
      expect(await partsWalked(window, 'Tab'), `docked ${edge}`).toEqual([
        'window',
        'nav',
        'page',
        'mine'
      ])
      // The dwarfs are reached with the mine, after the page.
      await window.evaluate(walkFrom('start'))
      let reachedDwarf = false
      for (let stop = 0; stop < 400 && !reachedDwarf; stop++) {
        await window.keyboard.press('Tab')
        reachedDwarf = (await window.evaluate(
          "document.activeElement?.matches('.shell-mine button.dm-dwarf[data-dwarf]') === true"
        )) as boolean
      }
      await window.evaluate(END_WALK)
      expect(reachedDwarf, `the dwarf takes the focus, docked ${edge}`).toBe(true)
    }
  })

  test('[US-SHELL-009.AC03, US-SHELL-009.AC04] with no window or no mine Tab skips that step', async () => {
    const window = await openPanel()
    // No mine and no window: the nav, then the page, and the order stops there.
    expect(await partsWalked(window, 'Tab')).toEqual(['nav', 'page'])
    // A mine but no window: Tab starts at the nav.
    await openMine(window)
    expect(await partsWalked(window, 'Tab')).toEqual(['nav', 'page', 'mine'])
  })

  test('[US-SHELL-009.AC05] Shift+Tab walks the same order backward', async () => {
    const window = await openPanel()
    for (const edge of ['right', 'left'] as const) {
      await dock(window, edge)
      await openMine(window)
      await openChat(window)
      expect(await partsWalked(window, 'Shift+Tab'), `docked ${edge}`).toEqual([
        'mine',
        'page',
        'nav',
        'window'
      ])
    }
  })

  test('[US-SHELL-007.AC01, US-SHELL-007.AC02, US-SHELL-007.AC03, US-SHELL-007.AC05, US-SHELL-007.AC06, NFR-PLAT-12] docked parts keep their width, the page shrinks and clips on its inward side, then the farthest part runs off-screen, with no minimum width', async () => {
    const window = await openPanel()
    for (const edge of ['right', 'left'] as const) {
      await dock(window, edge)
      await openMine(window)
      await openChat(window)
      const height = (await window.evaluate('innerHeight')) as number
      // At the ordinary width nothing gives way (AC01).
      const nav = await box(window, '.dm-nav')
      const mine = await box(window, '.shell-mine')
      const slot = await box(window, '.dock-window')
      const page = await box(window, '.shell-secondary')
      expect(page.width, `the page at its full width, docked ${edge}`).toBe(440)

      // What the dock takes, measured to the slot's free-side margin (`--dock-free-room`, 6px).
      const room = (await window.evaluate('innerWidth')) as number
      const dockWidth = edge === 'right' ? room - (slot.left - 6) : slot.right + 6
      // Narrower than the dock: only the page's column gives way, and it is cut on its inward side (AC02, AC06).
      const narrower = dockWidth - 200
      await window.setViewportSize({ width: narrower, height })
      await expect.poll(async () => (await box(window, '.shell-secondary')).width).toBe(240)
      expect((await box(window, '.dm-nav')).width).toBe(nav.width)
      expect((await box(window, '.shell-mine')).width).toBe(mine.width)
      const window1 = await box(window, '.dock-window')
      expect(window1.width).toBe(slot.width)
      expect(window1.left).toBeGreaterThanOrEqual(0)
      expect(window1.right).toBeLessThanOrEqual(narrower)
      const column = await box(window, '.shell-secondary')
      const content = await box(window, '.shell-secondary > .shell-page')
      expect(content.width, 'the page keeps its own width inside the clipping column').toBe(440)
      if (edge === 'right') expect(content.right).toBe(column.right)
      else expect(content.left).toBe(column.left)

      // Narrower than the window, the mine column and the nav together: the docked parts stay whole at the docked
      // edge and the window, the part farthest from it, runs off-screen (AC03).
      const tight = nav.width + mine.width + 120
      await window.setViewportSize({ width: tight, height })
      await expect.poll(async () => (await box(window, '.shell-secondary')).width).toBe(0)
      const nav2 = await box(window, '.dm-nav')
      const mine2 = await box(window, '.shell-mine')
      const window2 = await box(window, '.dock-window')
      expect(nav2.width).toBe(nav.width)
      expect(mine2.width).toBe(mine.width)
      expect(window2.width).toBe(slot.width)
      if (edge === 'right') {
        expect(nav2.right).toBeLessThanOrEqual(tight)
        expect(mine2.left).toBeGreaterThanOrEqual(0)
        expect(window2.left).toBeLessThan(0)
      } else {
        expect(nav2.left).toBeGreaterThanOrEqual(0)
        expect(mine2.right).toBeLessThanOrEqual(tight)
        expect(window2.right).toBeGreaterThan(tight)
      }

      // However small the screen, the Panel still lays out: no floor, the same rule (AC05).
      await window.setViewportSize({ width: 120, height })
      await expect.poll(async () => (await box(window, '.dm-nav')).width).toBe(nav.width)
      expect((await box(window, '.shell-mine')).width).toBe(mine.width)
      await window.setViewportSize({
        width: slot.width + page.width + mine.width + nav.width + 200,
        height
      })
    }
  })
})
