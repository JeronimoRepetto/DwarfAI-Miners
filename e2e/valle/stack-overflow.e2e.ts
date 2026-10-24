import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  anyWindowVisible,
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
import {
  ASK_MARKER,
  asksOf,
  createClaudeStreamWorld,
  launchClaude,
  stubOnlyPath,
  uuidv7
} from '../cut-3a/claudeStreamWorld.ts'
import { showValle, valleSettled } from '../support/valle.ts'
import { declareMine } from '../support/veta.ts'

/**
 * L9 (Valle QA VQA-01, VQA-11; a Valle package gap resolved in development, EPIC-20; US-VALLE-007.AC08): the Control
 * room's pinned chat stack with many pins, fourteen stub Claude dwarfs pinned, the way two dives pin two whole crews, in
 * the Valle window at the CI size of 1024 × 768. The design draws the stack with three pins and is silent on more
 * (`DS` organisms/chat-stack). REWORKED for the owner check of 2026-10-24, which rejected the separate scroll regions
 * above and below the open chat (three scrollbars): the lines and the open chat are one list that scrolls as one,
 * carrying the open chat with it, so the pinned column shows two scrollbars, the list's and the open chat's log; opening
 * a chat brings it into view; the open chat is never covered, nothing in the pinned column draws over the needs-you bar,
 * and every line stays reachable and clickable by scrolling. The focused chat carries no line of its own above its
 * MessagePanel (`DS/prototype/organisms/chat-stack/chat-stack.js` render). Every check reads the laid-out page: what the
 * pointer would hit (`elementFromPoint`) and the boxes it draws.
 */

test.describe.configure({ timeout: 600_000 })

const PINS = 14
/** The pin in focus while the overflow is checked: one in the middle, so lines lie both above and below it. */
const MIDDLE = 6

/** The stub dwarf asks for its Write tool (`claudeStreamStub.mjs` ASK_MARKER), so its chat shows a question card. */
async function startAsking(window: Page, dwarfId: string): Promise<void> {
  const sent = (await window.evaluate(
    `window.api.sendDwarfText(${JSON.stringify({
      dwarfId,
      text: `Please write the ${ASK_MARKER}.`,
      attachments: [],
      requestId: uuidv7()
    })})`
  )) as { ok: boolean; value?: { ok: boolean } }
  expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })
  await expect
    .poll(
      async () =>
        (await asksOf(window)).some((ask) => ask.dwarfId === dwarfId && ask.state === 'open'),
      { timeout: 60_000, message: 'the stub’s permission request opens an ask' }
    )
    .toBe(true)
}

/** What the laid-out stack shows: each check is a fact of the page, read in it. */
interface StackFacts {
  /** The open chat's pin. */
  open: string | null
  /**
   * Whether a point at the centre of the open chat's foot hits it (or something inside it): its composer, or the
   * question card that stands in the composer's place while its dwarf asks.
   */
  footHit: boolean
  card: boolean
  /** Collapsed line elements inside the open chat, the focused one's own line included (VQA-11). */
  linesInOpen: number
  /** The stack's lowest drawn edge, and the needs-you bar's top. */
  stackBottom: number
  barTop: number
  /** Whether a point just inside the needs-you bar's top, under the chat column, hits the bar. */
  barHit: boolean
  /** The open chat's box, and every visible collapsed line's box clipped by its scroll region. */
  overlaps: string[]
  /** Whether the open chat lies inside the list's view: wholly, or from its head down when it is taller. */
  openInView: boolean
  /** What shows a scrollbar in the pinned column (overflowing, overflow-y auto or scroll), by its class. */
  scrollers: string[]
}

function stackFacts(valle: Page): Promise<StackFacts> {
  return valle.evaluate(`(() => {
    const hits = (el) => {
      if (el === null) return null
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return at !== null && (at === el || el.contains(at))
    }
    const stack = document.querySelector('.dm-cstack')
    const open = document.querySelector('.dm-cstack__open')
    const bar = document.querySelector('[data-needs-queue]').getBoundingClientRect()
    const column = document.querySelector('.dm-valle__chats').getBoundingClientRect()
    const atBar = document.elementFromPoint(column.left + column.width / 2, bar.top + 3)
    let bottom = stack.getBoundingClientRect().bottom
    for (const el of stack.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // A part drawn but clipped by a scroll region is not drawn past it.
      let clipped = r.bottom
      for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY
        if (o !== 'visible') clipped = Math.min(clipped, p.getBoundingClientRect().bottom)
      }
      bottom = Math.max(bottom, clipped)
    }
    const overlaps = []
    if (open !== null) {
      const o = open.getBoundingClientRect()
      for (const line of stack.querySelectorAll('.dm-cstack__row[data-pin]')) {
        const r = line.getBoundingClientRect()
        const region = line.parentElement.getBoundingClientRect()
        const top = Math.max(r.top, region.top)
        const end = Math.min(r.bottom, region.bottom)
        if (end <= top) continue
        if (top < o.bottom && end > o.top) overlaps.push(line.getAttribute('data-pin'))
      }
    }
    const list = stack.querySelector('.dm-cstack__list').getBoundingClientRect()
    let openInView = false
    if (open !== null) {
      const o = open.getBoundingClientRect()
      openInView = o.top >= list.top - 1 && (o.bottom <= list.bottom + 1 || Math.abs(o.top - list.top) <= 1)
    }
    const scrollers = []
    for (const el of document.querySelectorAll('.dm-valle__chats *')) {
      if (el.closest('.dm-vghosts') !== null) continue
      const o = getComputedStyle(el).overflowY
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        scrollers.push(el.classList.contains('dm-cstack__list') ? 'list' : el.classList.contains('dm-msg__log') ? 'log' : el.className || el.tagName)
      }
    }
    return {
      openInView,
      scrollers,
      open: open === null ? null : open.getAttribute('data-pin'),
      footHit: hits(open === null ? null : open.querySelector('.dm-qcard, .dm-composer')) === true,
      card: open !== null && open.querySelector('.dm-qcard') !== null,
      linesInOpen: open === null ? 0 : open.querySelectorAll('.dm-cstack__row').length,
      stackBottom: Math.round(bottom),
      barTop: Math.round(bar.top),
      barHit: atBar !== null && atBar.closest('[data-needs-queue]') !== null,
      overlaps
    }
  })()`) as Promise<StackFacts>
}

/**
 * Waits until the stack's opening has played (`--dur-panel`): its scripted animations, never the CSS loops a portrait or
 * an activity line runs inside it.
 */
async function stackStill(valle: Page): Promise<void> {
  await expect
    .poll(
      () =>
        valle.evaluate(
          `document.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === 'running' && a.effect?.target?.closest?.('.dm-cstack')).length`
        ),
      { timeout: 5_000, message: 'the stack settles' }
    )
    .toBe(0)
}

/**
 * Every fact of the rule at once, so one failure names all that broke. Only the list and the open chat's log ever show a
 * scrollbar: the list always does with fourteen pins, the log when its conversation overflows. `opened`: the chat was
 * just opened by a click, so it is in the list's view.
 */
async function expectStackHolds(
  valle: Page,
  open: string,
  card: boolean,
  opened: boolean
): Promise<StackFacts> {
  await stackStill(valle)
  const facts = await stackFacts(valle)
  expect(
    {
      open: facts.open,
      openInView: opened ? facts.openInView : true,
      footHit: facts.footHit,
      card: facts.card,
      linesInOpen: facts.linesInOpen,
      stackAboveBar: facts.stackBottom <= facts.barTop,
      barHit: facts.barHit,
      overlaps: facts.overlaps,
      scrollers: facts.scrollers
    },
    JSON.stringify(facts)
  ).toEqual({
    open,
    openInView: true,
    footHit: true,
    card,
    linesInOpen: 0,
    stackAboveBar: true,
    barHit: true,
    overlaps: [],
    scrollers: facts.scrollers.includes('log') ? ['list', 'log'] : ['list']
  })
  return facts
}

test.describe("the Control room's pinned chat stack with many pins (VQA-01, VQA-11)", () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true }).catch(() => undefined)
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[US-VALLE-007.AC08] with fourteen pins at 1024 × 768 one list scrolls the lines and the open chat together, opening a chat brings it into view, the open chat is never covered, every line opens on a click, and the stack stays above the needs-you bar', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createClaudeStreamWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: stubOnlyPath(world),
      pathOnly: true,
      trayProbe: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { app, window } = launched
    await waitForHostAttached(owned)
    await chooseTrayItem(app, TRAY_ITEMS.open)
    await answerFirstRunStep(window)
    await expect.poll(() => anyWindowVisible(app), { timeout: 30_000 }).toBe(true)

    const folder = path.join(owned.root, 'moria')
    mkdirSync(folder, { recursive: true })
    const mineId = await declareMine(app, window, folder)
    const dwarfIds: string[] = []
    for (let i = 0; i < PINS; i += 1) dwarfIds.push((await launchClaude(window, mineId)).dwarfId)
    const written = (await window.evaluate(
      `window.api.setUiPreference(${JSON.stringify({
        key: 'pins',
        value: dwarfIds.map((dwarfId, order) => ({ dwarfId, mineId, order }))
      })})`
    )) as unknown
    expect(written, 'A-N21 takes the pins').toBeTruthy()
    // The middle dwarf asks, so its open chat holds a question card above its composer.
    const asking = dwarfIds[MIDDLE]!
    await startAsking(window, asking)

    const valle = await showValle(app, window)
    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('mode=valle')
      )!
      const area = screen.getDisplayMatching(window.getBounds()).workArea
      window.setContentBounds({ x: area.x, y: area.y, width: 1024, height: 768 })
      window.webContents.setZoomFactor(1)
    })
    await valleSettled(valle)
    const stack = valle.locator('.dm-valle__body .dm-cstack')
    await expect(stack.locator('[data-pin]')).toHaveCount(PINS, { timeout: 30_000 })
    const open = stack.locator('.dm-cstack__open')
    await expect(open).toHaveCount(1)

    // As Valle opens: the stack holds before anything is pressed.
    await valle.screenshot({ path: test.info().outputPath('stack-1024x768-14-pins-opened.png') })
    const restored = (await open.getAttribute('data-pin'))!
    await expectStackHolds(valle, restored, restored === asking, false)

    // The middle line opens on a click: lines lie above and below the open chat, its question card shown. Two
    // scrollbars, the list's and the open chat's log, never one per side of it.
    const middle = stack.locator(`.dm-cstack__row[data-pin="${asking}"]`)
    await middle.scrollIntoViewIfNeeded()
    await middle.click()
    await expect(open).toHaveAttribute('data-pin', asking)
    await expect(open.locator('.dm-qcard')).toBeVisible({ timeout: 30_000 })
    await valleSettled(valle)
    await valle.screenshot({ path: test.info().outputPath('stack-1024x768-14-pins.png') })
    const middleFacts = await expectStackHolds(valle, asking, true, true)
    expect(middleFacts.scrollers, 'two scrollbars: the list and the open chat log').toEqual([
      'list',
      'log'
    ])

    // One scroll: scrolling the list carries the open chat with it, by as much as the list moved.
    const carried = (await valle.evaluate(`(() => {
      const list = document.querySelector('.dm-valle__body .dm-cstack__list')
      const open = list.querySelector('.dm-cstack__open')
      const top = open.getBoundingClientRect().top
      const from = list.scrollTop
      list.scrollTop = from + 120
      const moved = list.scrollTop - from
      const shift = top - open.getBoundingClientRect().top
      list.scrollTop = from
      return { moved, shift }
    })()`)) as { moved: number; shift: number }
    expect(carried.moved, JSON.stringify(carried)).toBeGreaterThan(0)
    expect(carried.shift, JSON.stringify(carried)).toBe(carried.moved)

    // The last line, under the open chat, scrolls into reach and opens on a real click: Playwright's click fails when
    // anything else would take the pointer at that point.
    const last = dwarfIds[PINS - 1]!
    const lastLine = stack.locator(`.dm-cstack__row[data-pin="${last}"]`)
    await lastLine.scrollIntoViewIfNeeded()
    await lastLine.click()
    await expect(open).toHaveAttribute('data-pin', last)
    await valleSettled(valle)
    await expectStackHolds(valle, last, false, true)

    // And the first line, now with every other line above the open chat.
    const first = dwarfIds[0]!
    const firstLine = stack.locator(`.dm-cstack__row[data-pin="${first}"]`)
    await firstLine.scrollIntoViewIfNeeded()
    await firstLine.click()
    await expect(open).toHaveAttribute('data-pin', first)
    await valleSettled(valle)
    await expectStackHolds(valle, first, false, true)
  })
})
