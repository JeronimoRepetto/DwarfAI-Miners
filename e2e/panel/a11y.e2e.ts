import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
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
import { STUB_MINE_NAME, seedClaudeStubSession } from '../cut-1/claudeStubWorld.ts'

/**
 * L12 end to end (ISSUE-266; 17 §1.12): what only the built app's real layout, focus and accessibility tree can show.
 * The Tab order on both docks (NFR-A11Y-13), the focus an opened chat takes (NFR-A11Y-04), hover and keyboard focus
 * revealing the same things (NFR-A11Y-05), the accessible names and landmarks (NFR-A11Y-09, read through Playwright's
 * ARIA engine), and reduced motion from an emulated OS preference (NFR-A11Y-10).
 *
 * The world is the cut-1 fixture: one observed Claude session in one mine (`claudeStubWorld.ts`), so a mine with a
 * dwarf can be opened from the Map and its chat docked, as a person does it.
 */

test.describe.configure({ timeout: 240_000 })

/** The parts of the shell, in the logical order Tab walks them (screens/shell.md; NFR-A11Y-13). */
type Part = 'window' | 'nav' | 'page' | 'mine'

/** The focused element's stop (its child-index path) and its part of the shell; null while the document has it. */
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
 * Puts the sequential focus starting point at the start of the document, nothing focused: an untabbable marker takes
 * the focus and gives it back (HTML, "sequential focus navigation starting point"; see shell.e2e.ts).
 */
const WALK_FROM_START = `(() => {
  document.querySelector('[data-e2e-walk-start]')?.remove()
  const marker = document.createElement('span')
  marker.tabIndex = -1
  marker.setAttribute('data-e2e-walk-start', '')
  document.body.prepend(marker)
  marker.focus()
  marker.blur()
})()`
const END_WALK = "document.querySelector('[data-e2e-walk-start]')?.remove()"

/** The parts Tab visits from the start of the document, each run of stops in one part counted once. */
async function partsWalked(window: Page): Promise<Part[]> {
  await window.evaluate(WALK_FROM_START)
  const parts: Part[] = []
  let first: string | null = null
  for (let stop = 0; stop < 400; stop++) {
    await window.keyboard.press('Tab')
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

/** Presses Tab from the start of the document until `selector` holds the keyboard focus, as a person reaches it. */
async function tabTo(window: Page, selector: string): Promise<void> {
  await window.evaluate(WALK_FROM_START)
  let reached = false
  for (let stop = 0; stop < 400 && !reached; stop++) {
    await window.keyboard.press('Tab')
    reached = (await window.evaluate(
      `document.activeElement?.matches(${JSON.stringify(selector)}) === true`
    )) as boolean
  }
  await window.evaluate(END_WALK)
  expect(reached, `Tab reaches ${selector}`).toBe(true)
}

/** The window's `getComputedStyle`, typed for this file, which is compiled without the DOM library. */
type ComputedStyleOf = (
  element: unknown,
  pseudo: string | null
) => { opacity: string; animationName: string }

/** Rests the pointer on plain text (the Map legend's first key), off every control that reveals anything. */
async function rest(window: Page): Promise<void> {
  await window.locator('.dm-mappage__key').first().hover()
}

/** The computed opacity of an element, or of one of its pseudo-elements. */
async function opacity(target: Locator, pseudo: '::after' | null = null): Promise<number> {
  return target.evaluate(
    (element, which) =>
      Number(
        (globalThis as unknown as { getComputedStyle: ComputedStyleOf }).getComputedStyle(
          element,
          which
        ).opacity
      ),
    pseudo
  )
}

test.describe('the Panel, L12 accessibility (ISSUE-266)', () => {
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

  /** The mine's one observed dwarf, once it is drawn. */
  async function theDwarf(window: Page): Promise<Locator> {
    const dwarf = window.locator('.shell-mine button.dm-dwarf[data-dwarf]')
    await expect(dwarf, 'the observed dwarf is drawn on its mine').toHaveCount(1, {
      timeout: 60_000
    })
    return dwarf
  }

  /** Opens the dwarf's chat in the window slot. */
  async function openChat(window: Page): Promise<void> {
    if ((await window.locator('.dock-window').count()) === 1) return
    await (await theDwarf(window)).click()
    await expect(window.locator('.dock-window'), 'the chat is in the window slot').toHaveCount(1, {
      timeout: 30_000
    })
  }

  test('[NFR-A11Y-13] Tab order is the same logical order on both docks, whatever the visual order', async () => {
    const window = await openPanel()
    const orders: Record<string, Part[]> = {}
    for (const edge of ['right', 'left'] as const) {
      await dock(window, edge)
      await openMine(window)
      await openChat(window)
      orders[edge] = await partsWalked(window)
    }
    // Docked left, the plate's parts are drawn mirrored; the order Tab walks them is not.
    expect(orders['left']).toEqual(orders['right'])
    expect(orders['right']).toEqual(['window', 'nav', 'page', 'mine'])
  })

  test('[NFR-A11Y-04] an opened chat takes focus one frame after opening and focus never drops to the page', async () => {
    const window = await openPanel()
    await openMine(window)
    const dwarf = await theDwarf(window)
    // Opened from the keyboard, as a person who drives the Panel by keys opens it.
    await tabTo(window, '.shell-mine button.dm-dwarf[data-dwarf]')
    await window.keyboard.press('Enter')
    await expect(window.locator('.dock-window')).toHaveCount(1, { timeout: 30_000 })
    // The composer's field takes the focus; the question card's first option while the dwarf waits on you; and on a
    // session that cannot take text, whose composer is dead (#217), the chat's first live control, the dwarf's name.
    const target =
      (await window.locator('.dock-window .dm-qcard').count()) === 1
        ? '.dock-window .dm-qcard .dm-qopt'
        : (await window.locator('.dock-window .dm-composer textarea').isDisabled())
          ? '.dock-window .dm-msg__rename'
          : '.dock-window .dm-composer textarea'
    await expect(window.locator(target).first()).toBeFocused()
    // Esc closes the chat, and the focus goes back to the dwarf that opened it, never to the page.
    await window.keyboard.press('Escape')
    await expect(window.locator('.dock-window')).toHaveCount(0, { timeout: 30_000 })
    await expect(dwarf).toBeFocused()
    expect(await window.evaluate('document.activeElement === document.body')).toBe(false)
  })

  test('[NFR-A11Y-05] what hover reveals, keyboard focus reveals too', async () => {
    const window = await openPanel()
    await openMine(window)

    // A nav slot's label: on hover after the tooltip delay, on keyboard focus too.
    const slot = window.locator('.dm-nav .dm-slot[data-label="Mines"]')
    expect(await opacity(slot, '::after')).toBe(0)
    await slot.hover()
    await expect.poll(() => opacity(slot, '::after')).toBe(1)
    await rest(window)
    await expect.poll(() => opacity(slot, '::after')).toBe(0)
    await tabTo(window, '.dm-nav .dm-slot[data-label="Mines"]')
    await expect.poll(() => opacity(slot, '::after')).toBe(1)

    // A dwarf's name tag.
    const dwarf = await theDwarf(window)
    const tag = dwarf.locator('.dm-dwarf__tag')
    await rest(window)
    await window.evaluate('document.activeElement?.blur()')
    await expect.poll(() => opacity(tag)).toBe(0)
    await dwarf.hover()
    await expect.poll(() => opacity(tag)).toBe(1)
    await rest(window)
    await expect.poll(() => opacity(tag)).toBe(0)
    await tabTo(window, '.shell-mine button.dm-dwarf[data-dwarf]')
    await expect.poll(() => opacity(tag)).toBe(1)

    // A map marker's tooltip. The focused dwarf shows its own card first; the focus leaves it.
    await rest(window)
    await window.evaluate('document.activeElement?.blur()')
    await expect(window.locator('.dm-tip')).toHaveCount(0, { timeout: 10_000 })
    const marker = window.locator('.dm-marker').first()
    await marker.hover()
    await expect(window.locator('.dm-tip')).toHaveCount(1, { timeout: 10_000 })
    await rest(window)
    await expect(window.locator('.dm-tip')).toHaveCount(0, { timeout: 10_000 })
    await tabTo(window, '.dm-marker')
    await expect(window.locator('.dm-tip')).toHaveCount(1, { timeout: 10_000 })
  })

  test('[NFR-A11Y-09] accessible names and landmarks of the Panel follow the naming table', async () => {
    const window = await openPanel()
    // The nav is the navigation landmark, and the page a named region.
    await expect(window.getByRole('navigation')).toHaveCount(1)
    await expect(window.getByRole('region', { name: 'Map' })).toHaveCount(1)
    // A map marker carries its mine and tier, and "needs you" only while a dwarf there does.
    await expect(
      window.getByRole('button', {
        name: new RegExp(`^${STUB_MINE_NAME}, (Bronze|Copper|Silver|Gold|Uranium)`)
      })
    ).toHaveCount(1, { timeout: 30_000 })

    await openMine(window)
    // Each mine is a region; a dwarf in its scene is "<name>, <state>".
    const mine = window.getByRole('region', { name: `Mine ${STUB_MINE_NAME}` })
    await expect(mine).toHaveCount(1)
    // In the scene the dwarf is the art's one control, whatever the art is drawn as; the crew list names it the same.
    const dwarf = mine
      .getByRole('img', { name: `${STUB_MINE_NAME} interior` })
      .getByRole('button', { name: /^.+, (working|needs you|asleep|Waiting)$/ })
    await expect(dwarf).toHaveCount(1, { timeout: 60_000 })
    const dwarfName = ((await dwarf.getAttribute('aria-label')) ?? '').replace(/, [^,]+$/, '')
    expect(dwarfName.length).toBeGreaterThan(0)

    await openChat(window)
    // The MessagePanel is a dialog "Chat with <name>", its live log "Conversation with <name>".
    await expect(window.getByRole('dialog', { name: `Chat with ${dwarfName}` })).toHaveCount(1)
    await expect(window.getByRole('log', { name: `Conversation with ${dwarfName}` })).toHaveCount(1)
    await expect(window.getByRole('button', { name: `Rename ${dwarfName}` })).toHaveCount(1)
    // Every icon-only button is named by its title.
    const unnamed = await window.evaluate(`(() => [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null && b.textContent.trim() === ''
        && !(b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') || b.getAttribute('title')))
      .map((b) => b.className))()`)
    expect(unnamed).toEqual([])
  })

  test('[NFR-A11Y-10] with the OS reduced-motion preference emulated the stand-ins apply', async () => {
    const window = await openPanel()
    await window.emulateMedia({ reducedMotion: 'reduce' })
    // The preference reaches the window (O-17-04): the app's one query answers it.
    expect(await window.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")).toBe(
      true
    )
    // Every duration token reads 0ms, and an overlay appears in place.
    const tokens = (await window.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement)
      return ['--dur-press', '--dur-fast', '--dur-base', '--dur-panel', '--dur-tip-delay', '--dur-pulse', '--rise', '--frame-ms']
        .map((name) => root.getPropertyValue(name).trim())
    })()`)) as string[]
    expect(tokens).toEqual(['0ms', '0ms', '0ms', '0ms', '0ms', '0ms', '0px', '200ms'])
    // The map marker's pulse becomes a steady halo: stopped, and still drawn.
    const pulse = window.locator('.dm-marker .dm-marker__pulse').first()
    await expect(pulse).toHaveCount(1, { timeout: 30_000 })
    const halo = await pulse.evaluate((element) => {
      const style = (
        globalThis as unknown as { getComputedStyle: ComputedStyleOf }
      ).getComputedStyle(element, null)
      return { animation: style.animationName, opacity: Number(style.opacity) }
    })
    expect(halo.animation).toBe('none')
    expect(halo.opacity).toBeGreaterThan(0)
  })
})
