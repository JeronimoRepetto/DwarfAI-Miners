// @vitest-environment jsdom
import type { DwarfId, MineId, MoveToModeParams } from '@dwarfai/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import ValleControlRoom from '../../components/valle/ValleControlRoom.vue'
import ValleTopBar from '../../components/valle/ValleTopBar.vue'
import ValleWorkFront from '../../components/valle/ValleWorkFront.vue'
import { useVallePreset, type VallePresetBridge } from '../../composables/useVallePreset'
import { VALLE_STORE_DEFAULTS, type ValleStores } from '../../composables/useValleStores'
import {
  VALLE_MOTION,
  createInputGate,
  createValleStage,
  startValleRun,
  valleRunMs,
  type ValleAnimationTiming,
  type ValleBox,
  type ValleClock,
  type ValleFrames,
  type ValleStageMotion
} from './flip'
import {
  defaultValleLayouts,
  stepValle,
  valleChatWidth,
  valleListWidth,
  VALLE_CONTROL_CHAT_WIDTH,
  VALLE_LIST_FOLDED_WIDTH,
  VALLE_LIST_WIDTH,
  type ValleEffect,
  type ValleFacts,
  type ValleInput,
  type ValleLayouts,
  type VallePreset,
  type ValleView
} from './preset'
import { restoreValleView } from './restore'
import { BORIN, EREBOR, IRONHILLS, KHAZAD, MORIA, NALI } from '../veta/testing/vetaFixtures'

/*
 * 07 machine 28 (ISSUE-300; US-VALLE-001; 17 §1.1 diagram-conformance walk): the preset switch, the Work front's folded
 * list, a nav page over the main zone, a resize, Reset metrics and a crash, each an edge of the machine; an input the
 * machine does not list is refused. The dive and climb motion between the presets is ISSUE-301's.
 */

// AMENDED for ISSUE-301 (was: `{ enterableMine: true }`): S28.06 now dives into a mine, so the facts name the mines, the
// mosaic, the last mine worked in, the mosaic's scroll and the chat in focus (07 S28.03, S28.06).
const ENTERABLE: ValleFacts = {
  mines: [{ mineId: MORIA, enterable: true }],
  mosaic: [MORIA],
  lastMine: MORIA,
  scrollLeft: 0,
  focus: null
}

const view = (over: Partial<ValleView> = {}): ValleView => ({
  preset: 'control',
  page: null,
  layouts: defaultValleLayouts(),
  ...over
})

/**
 * Steps each input in turn, refusing none; answers the last view and every effect. AMENDED for ISSUE-301: a switch
 * between the presets is now a dive or a climb (07 S28.03…S28.14), so each run is let settle before the next input, its
 * settling step not listed in `ids` (the dive and climb cases below walk it).
 */
function walk(
  start: ValleView,
  inputs: readonly ValleInput[],
  facts: ValleFacts = ENTERABLE
): { view: ValleView; ids: string[]; effects: ValleEffect[] } {
  let at = start
  const ids: string[] = []
  const effects: ValleEffect[] = []
  for (const input of inputs) {
    const step = stepValle(at, input, facts)
    expect(step.ok, JSON.stringify(input)).toBe(true)
    if (!step.ok) break
    at = step.view
    ids.push(step.id)
    effects.push(...step.effects)
    if (at.motion !== undefined) {
      const settled = stepValle(at, { kind: 'settled' }, facts)
      expect(settled.ok, 'settled').toBe(true)
      if (!settled.ok) break
      at = settled.view
      effects.push(...settled.effects)
    }
  }
  return { view: at, ids, effects }
}

const CHANGED: ValleLayouts = {
  control: { chatWidth: 520, split: false, foldedList: false, zones: {} },
  front: { chatWidth: 610, split: true, foldedList: false, zone: { content: 'mine' } }
}

describe('machine 28 diagram conformance (presets)', () => {
  it("[US-VALLE-001.AC01, S28.06, S28.11] the other preset's tab, or the matching arrow key on a focused tab, switches the preset and the top bar highlights it", async () => {
    const byTab = walk(view(), [{ kind: 'tab', preset: 'front' }])
    expect(byTab.ids).toEqual(['S28.06'])
    expect(byTab.view.preset).toBe('front')
    expect(walk(byTab.view, [{ kind: 'tab', preset: 'control' }]).ids).toEqual(['S28.11'])

    const byKey = walk(view(), [{ kind: 'arrow', key: 'ArrowRight' }])
    expect(byKey.ids).toEqual(['S28.06'])
    expect(byKey.view.preset).toBe('front')
    const back = walk(byKey.view, [{ kind: 'arrow', key: 'ArrowLeft' }])
    expect(back.ids).toEqual(['S28.11'])
    expect(back.view.preset).toBe('control')
    // Each switch is written at once (S28.26).
    expect(byTab.effects).toContainEqual({ kind: 'write-preset', preset: 'front' })
    expect(back.effects).toContainEqual({ kind: 'write-preset', preset: 'control' })
    // The Work front tab needs a mine to dive into (S28.06 guard).
    // AMENDED for ISSUE-301 (was: `{ enterableMine: false }`): no mine the Host lists can be entered.
    const none = { ...ENTERABLE, mines: [{ mineId: MORIA, enterable: false }] }
    expect(stepValle(view(), { kind: 'tab', preset: 'front' }, none)).toEqual({
      ok: false,
      reason: 'not-listed'
    })

    // The top bar highlights the preset shown.
    const bar = mount(ValleTopBar, { props: { preset: 'control', chat: null } })
    const selected = (): string[] =>
      bar.findAll('[role="tab"][aria-selected="true"]').map((tab) => tab.text())
    expect(selected()).toEqual(['Control room'])
    await bar.setProps({ preset: byTab.view.preset })
    expect(selected()).toEqual(['Work front'])
    // The bar hands the click and the arrow key on a focused tab to the machine above.
    await bar.get('[data-preset-tab="control"]').trigger('click')
    await bar.get('[data-preset-tab="front"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(bar.emitted('tab')).toEqual([['control']])
    expect(bar.emitted('arrow')).toEqual([['ArrowLeft']])
    bar.unmount()
  })

  it('[US-VALLE-001.AC02, S28.11] Esc on the Work front with no other layer open returns to the Control room', () => {
    const front = view({ preset: 'front' })
    const step = walk(front, [{ kind: 'escape', layerOpen: false }])
    expect(step.ids).toEqual(['S28.11'])
    expect(step.view.preset).toBe('control')
    // A layer open closes first: Esc does not leave the Work front (NFR-A11Y-02).
    expect(stepValle(front, { kind: 'escape', layerOpen: true }, ENTERABLE).ok).toBe(false)
  })

  it('[US-VALLE-001.AC03] a preset shows the exact layout it held, untouched by changes made in the other preset', () => {
    const start = view({ layouts: CHANGED })
    // Into the Work front, fold its list, back to the Control room: the Control room's layout is as it was.
    const there = walk(start, [{ kind: 'tab', preset: 'front' }, { kind: 'fold' }])
    expect(there.view.layouts.front).toEqual({ ...CHANGED.front, foldedList: true })
    const back = walk(there.view, [{ kind: 'tab', preset: 'control' }])
    expect(back.view.layouts.control).toEqual(CHANGED.control)
    // And the Work front, switched to again, shows exactly what it held.
    const again = walk(back.view, [{ kind: 'tab', preset: 'front' }])
    expect(again.view.layouts.front).toEqual({ ...CHANGED.front, foldedList: true })
    expect(again.view.layouts.control).toEqual(CHANGED.control)
  })

  it('[US-VALLE-001.AC04, US-VALLE-001.AC06, S28.16] folding the Work front list sets the flag on the Work front preset alone and shows a 44 px MINES strip', () => {
    const front = view({ preset: 'front', layouts: CHANGED })
    expect(valleListWidth(front.layouts)).toBe(VALLE_LIST_WIDTH)
    const folded = walk(front, [{ kind: 'fold' }])
    expect(folded.ids).toEqual(['S28.16'])
    expect(folded.view.layouts.front.foldedList).toBe(true)
    expect(folded.view.layouts.control).toEqual(CHANGED.control)
    expect(valleListWidth(folded.view.layouts)).toBe(VALLE_LIST_FOLDED_WIDTH)
    expect(VALLE_LIST_FOLDED_WIDTH).toBe(44)
    // Written at once, the Control room's layout as it was (S28.26).
    expect(folded.effects).toEqual([
      {
        kind: 'write-layouts',
        layouts: { control: CHANGED.control, front: { ...CHANGED.front, foldedList: true } }
      }
    ])
    // The Control room has no compact list to fold, and a folded list cannot fold again.
    expect(stepValle(view({ layouts: CHANGED }), { kind: 'fold' }, ENTERABLE).ok).toBe(false)
    expect(stepValle(folded.view, { kind: 'fold' }, ENTERABLE).ok).toBe(false)
  })

  it('[US-VALLE-001.AC07, S28.17] Show the mines list unfolds it to 232 px and clears the flag for this preset', () => {
    const folded = view({
      preset: 'front',
      layouts: { ...CHANGED, front: { ...CHANGED.front, foldedList: true } }
    })
    const shown = walk(folded, [{ kind: 'unfold' }])
    expect(shown.ids).toEqual(['S28.17'])
    expect(shown.view.layouts.front.foldedList).toBe(false)
    expect(valleListWidth(shown.view.layouts)).toBe(232)
    expect(shown.effects).toEqual([{ kind: 'write-layouts', layouts: CHANGED }])
    expect(stepValle(shown.view, { kind: 'unfold' }, ENTERABLE).ok).toBe(false)
  })

  it('[S28.19, S28.20] a nav page takes the main zone and Esc returns to the preset beneath', () => {
    for (const preset of ['control', 'front'] as const) {
      const start = view({ preset, layouts: CHANGED })
      const paged = walk(start, [{ kind: 'nav', page: 'map' }])
      expect(paged.ids).toEqual(['S28.19'])
      expect(paged.view).toEqual({ ...start, page: 'map' })
      // Nothing is written for a page: the preset beneath and its layout stay as they were.
      expect(paged.effects).toEqual([])
      const back = walk(paged.view, [{ kind: 'escape', layerOpen: false }])
      expect(back.ids).toEqual(['S28.20'])
      expect(back.view).toEqual(start)
      // A layer open over the page closes first.
      expect(stepValle(paged.view, { kind: 'escape', layerOpen: true }, ENTERABLE).ok).toBe(false)
    }
  })

  it('[S28.18, S28.25, S28.26] a resize re-clamps, Reset metrics returns to control, and a crash keeps the persisted preset', () => {
    for (const preset of ['control', 'front'] as const) {
      const start = view({ preset, layouts: CHANGED })
      const resized = walk(start, [{ kind: 'resize' }])
      expect(resized.ids).toEqual(['S28.18'])
      expect(resized.view).toEqual(start)
      expect(resized.effects).toEqual([{ kind: 'reclamp', preset }])
    }

    // Reset metrics from the Work front with a page open: the Control room on its defaults. UI main rewrote the
    // stores (S39.10), so nothing is written back.
    const reset = walk(view({ preset: 'front', page: 'settings', layouts: CHANGED }), [
      { kind: 'reset' }
    ])
    expect(reset.ids).toEqual(['S28.25'])
    expect(reset.view).toEqual({ preset: 'control', page: null, layouts: defaultValleLayouts() })
    expect(reset.effects).toEqual([])

    // A crash after a run of changes: what was written on every change opens again as left (S28.26, then S28.02).
    const run = walk(view(), [
      { kind: 'tab', preset: 'front' },
      { kind: 'fold' },
      { kind: 'nav', page: 'mines' }
    ])
    let stored: { preset: ValleView['preset']; layout: ValleLayouts | null } = {
      preset: 'control',
      layout: null
    }
    for (const effect of run.effects) {
      if (effect.kind === 'write-preset') stored = { ...stored, preset: effect.preset }
      if (effect.kind === 'write-layouts') stored = { ...stored, layout: effect.layouts }
    }
    const reopened = restoreValleView(stored)
    expect(reopened.preset).toBe('front')
    expect(reopened.layouts).toEqual(run.view.layouts)
    // A page is not persisted: the next open shows the preset itself.
    expect(reopened.page).toBeNull()
  })

  it('[ADR-024] a transition not listed in 07 machine 28 is rejected', () => {
    const control = view()
    const front = view({ preset: 'front' })
    const paged = view({ page: 'map' })
    const refused: [ValleView, ValleInput][] = [
      [control, { kind: 'tab', preset: 'control' }],
      [front, { kind: 'tab', preset: 'front' }],
      [control, { kind: 'arrow', key: 'ArrowLeft' }],
      [front, { kind: 'arrow', key: 'ArrowRight' }],
      [control, { kind: 'escape', layerOpen: false }],
      [control, { kind: 'unfold' }],
      [paged, { kind: 'tab', preset: 'front' }],
      [paged, { kind: 'fold' }],
      [paged, { kind: 'nav', page: 'settings' }],
      [paged, { kind: 'resize' }]
    ]
    for (const [at, input] of refused) {
      expect(stepValle(at, input, ENTERABLE), JSON.stringify([at.preset, at.page, input])).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})

describe('the chat zone width of each preset (ISSUE-300)', () => {
  it("[US-VALLE-001.AC03, S28.02] the chat zone shows the preset's own stored width, or the default when none was set", () => {
    const stored = view({ layouts: CHANGED })
    expect(valleChatWidth(stored)).toBe(520)
    expect(valleChatWidth({ ...stored, preset: 'front' })).toBe(610)
    // Never set: the Control room's 440 px default (07 machine 33).
    expect(valleChatWidth(view())).toBe(VALLE_CONTROL_CHAT_WIDTH)
    expect(VALLE_CONTROL_CHAT_WIDTH).toBe(440)
  })
})

// APPENDED for ISSUE-301: the dive into a mine and the climb out (07 machine 28 `diving`, `climbing`, `front-swapping`).
/*
 * TC-301-01: a dive or a climb lasts about 330 ms, animates only `transform` and `opacity`, ignores all input but a mode
 * control (held until it settles), and ends in the Work front or at the saved scroll. TC-301-03: another mine picked,
 * removed or made unenterable swaps, climbs out or stays shown. The motion table is `DS/docs/motion.md` ("Dive in",
 * "Climb out", "Work front, another mine"): M = 270 ms, input waits until M + 60 ms.
 *
 * The stage is driven by hand: the DOM is a fixture with each part's box named by `data-box`, the new layout rendered
 * when the test says so, the animations recorded, and the run's clock fake (frames every 10 ms, timers).
 */

const MOSAIC = [MORIA, EREBOR, IRONHILLS]
const DIVE_FACTS: ValleFacts = {
  mines: [
    { mineId: MORIA, enterable: true },
    { mineId: EREBOR, enterable: true },
    { mineId: IRONHILLS, enterable: false },
    { mineId: KHAZAD, enterable: true }
  ],
  mosaic: MOSAIC,
  lastMine: MORIA,
  scrollLeft: 300,
  focus: null
}

/** Steps one input, which must be taken. */
function take(
  at: ValleView,
  input: ValleInput,
  facts: ValleFacts = DIVE_FACTS
): { id: string; view: ValleView; effects: readonly ValleEffect[] } {
  const step = stepValle(at, input, facts)
  expect(step.ok, `refused: ${JSON.stringify(input)}`).toBe(true)
  if (!step.ok) throw new Error('unreachable')
  return step
}

const BOXES: Record<string, ValleBox> = {
  stage: { left: 0, top: 0, width: 1600, height: 900 },
  mosaic: { left: 50, top: 40, width: 1018, height: 800 },
  [`col-${MORIA}`]: { left: 50, top: 40, width: 250, height: 800 },
  [`col-${EREBOR}`]: { left: 306, top: 40, width: 250, height: 800 },
  [`col-${IRONHILLS}`]: { left: 562, top: 40, width: 250, height: 800 },
  [`title-${EREBOR}`]: { left: 306, top: 40, width: 250, height: 30 },
  [`well-${EREBOR}`]: { left: 306, top: 80, width: 250, height: 700 },
  front: { left: 300, top: 40, width: 1000, height: 800 },
  'front-title': { left: 300, top: 40, width: 1000, height: 30 },
  'front-well': { left: 300, top: 80, width: 1000, height: 700 },
  list: { left: 62, top: 40, width: 232, height: 800 },
  deck: { left: 1312, top: 40, width: 280, height: 800 },
  stack: { left: 1312, top: 40, width: 280, height: 800 }
}

const column = (mineId: MineId): string =>
  `<section class="dm-vz" data-valle-column="${mineId}" data-box="col-${mineId}">` +
  `<div class="dm-vz__bg" data-box="col-${mineId}"></div>` +
  `<header class="dm-vz__title" data-box="title-${mineId}"></header>` +
  `<div class="dm-vz__tools"></div><div class="dm-vz__well" data-box="well-${mineId}"></div></section>`
const CONTROL_HTML =
  `<div class="dm-vmines" data-valle-mosaic data-box="mosaic">${MOSAIC.map(column).join('')}</div>` +
  `<section class="dm-cstack" data-box="stack"></section>`
const frontHtml = (mineId: MineId): string =>
  `<section class="dm-mrows" data-box="list"></section>` +
  `<section class="dm-vz" data-valle-front-mine="${mineId}" data-box="front">` +
  `<div class="dm-vz__bg" data-box="front"></div><header class="dm-vz__title" data-box="front-title"></header>` +
  `<div class="dm-vz__tools"></div><div class="dm-vz__well" data-box="front-well"></div></section>` +
  `<section class="dm-cdeck" data-box="deck"></section>`

interface Played {
  readonly element: Element
  readonly frames: ValleFrames
  readonly timing: ValleAnimationTiming
}

/** The Valle stage over a fixture DOM: `render` swaps the layout, as the root's re-render would. */
function stageOn(html: string, options: { reduced?: boolean } = {}) {
  document.body.innerHTML =
    `<main class="valle" data-box="stage"><div class="dm-vghosts" aria-hidden="true"></div>` +
    `<div class="view">${html}</div></main>`
  const root = document.querySelector<HTMLElement>('main.valle')!
  const played: Played[] = []
  const pending: (() => void)[] = []
  const scrolled: [HTMLElement, number][] = []
  let cancelled = 0
  const stage = createValleStage({
    root: () => root,
    box: (element) =>
      BOXES[element.getAttribute('data-box') ?? ''] ?? { left: 0, top: 0, width: 0, height: 0 },
    animate: (element, frames, timing) => played.push({ element, frames, timing }),
    cancel: () => {
      cancelled += 1
    },
    afterRender: (run) => pending.push(run),
    reduced: () => options.reduced ?? false,
    scroll: (element, left) => scrolled.push([element, left])
  })
  return {
    root,
    stage,
    played,
    scrolled,
    cancelled: () => cancelled,
    /** The new layout rendered: the view swapped, then what waited for it runs. */
    render(next: string) {
      root.querySelector('.view')!.innerHTML = next
      pending.splice(0).forEach((run) => run())
    },
    ghosts: () => [...root.querySelectorAll('.dm-vghosts .is-ghost')],
    of: (selector: string) => played.filter((p) => p.element.matches(selector))
  }
}

/** The play effect of a step. */
function playOf(effects: readonly ValleEffect[]): Extract<ValleEffect, { kind: 'play' }> {
  const play = effects.find((effect) => effect.kind === 'play')
  if (play?.kind !== 'play') throw new Error('no play effect')
  return play
}

/** A fake clock: animation frames every 10 ms (unless frozen, as a hidden or occluded window's), and timers. */
function fakeClock() {
  let now = 0
  let id = 0
  const frames = new Map<number, (at: number) => void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: ValleClock & { frozen: boolean; advance(ms: number): void; at(): number } = {
    frozen: false,
    frame(run) {
      frames.set((id += 1), run)
      return id
    },
    cancelFrame: (handle) => frames.delete(handle as number),
    now: () => now,
    set(run, ms) {
      timers.set((id += 1), { at: now + ms, run })
      return id
    },
    clear: (handle) => timers.delete(handle as number),
    advance(ms) {
      const until = now + ms
      while (now < until) {
        now = Math.min(now + 10, until)
        for (const [key, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(key)
          timer.run()
        }
        if (clock.frozen) continue
        const due = [...frames]
        frames.clear()
        for (const [, run] of due) run(now)
      }
    },
    at: () => now
  }
  return clock
}

/** UI main behind A-N21, A-N18 and A-N13, as the Valle window reaches it. */
function presetBridge() {
  const writes: unknown[] = []
  const patches: unknown[] = []
  const moves: MoveToModeParams[] = []
  const bridge: VallePresetBridge = {
    setUiPreference: (write) => {
      writes.push(write)
      return Promise.resolve(write)
    },
    patchUiSession: (patch) => {
      patches.push(patch)
    },
    moveToMode: (params) => {
      moves.push(params)
      return Promise.resolve({ ok: true })
    }
  }
  return { bridge, writes, patches, moves }
}

/** The preset in use with a fake clock and a recording stage. */
function presetWith(start: Partial<ValleStores>, facts: ValleFacts = DIVE_FACTS) {
  const fake = presetBridge()
  const clock = fakeClock()
  const plays: ValleStageMotion[] = []
  const dived: [MineId, DwarfId | null][] = []
  let ended = 0
  const scope = effectScope()
  const preset = scope.run(() =>
    useVallePreset({
      bridge: fake.bridge,
      stores: shallowRef({ ...VALLE_STORE_DEFAULTS, ...start }),
      facts: () => facts,
      dived: (mineId, forDwarfId) => dived.push([mineId, forDwarfId]),
      motion: {
        clock,
        reduced: () => false,
        stage: {
          play: (motion) => plays.push(motion),
          restoreScroll: () => {},
          end: () => {
            ended += 1
          }
        }
      }
    })
  )!
  return { ...fake, clock, plays, dived, ended: () => ended, preset, scope }
}

/** Every animated property is `transform` or `opacity` (NFR-PERF-01); the origin stays where it is. */
function onlyTransformAndOpacity(played: readonly Played[]): void {
  for (const { frames } of played) {
    for (const frame of frames) {
      const keys = Object.keys(frame).filter((key) => !['offset', 'transformOrigin'].includes(key))
      expect(
        keys.every((key) => key === 'transform' || key === 'opacity'),
        JSON.stringify(frame)
      ).toBe(true)
    }
    const origins = new Set(frames.map((frame) => frame.transformOrigin))
    expect(origins.size).toBe(1)
  }
}

const OUT = VALLE_MOTION.easeOut
const IN = VALLE_MOTION.easeIn

/** The Work front after a settled dive into EREBOR. */
const frontOn = (mineId: MineId = EREBOR): ValleView =>
  take(take(view(), { kind: 'dive', mineId }).view, { kind: 'settled' }).view

describe('machine 28 diagram conformance (dive and climb)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('[US-VALLE-002.AC01, S28.03, S28.08] ⤢ or a double-click on the art dives into that mine, the column growing into the Work front', async () => {
    // The column hands ⤢ and a double-click on its art to the machine above.
    const room = mount(ValleControlRoom, {
      props: { columns: MOSAIC.map((mineId) => ({ mineId, name: mineId, enterable: true })) }
    })
    await room.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).trigger('click')
    await room.get(`[data-valle-column="${MORIA}"] .dm-vz__well`).trigger('dblclick')
    expect(room.emitted('dive')).toEqual([[EREBOR], [MORIA]])
    expect(
      room.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).attributes()
    ).toMatchObject({
      'aria-label': 'Dive in · Work front on this mine',
      title: 'Dive in · Work front on this mine'
    })
    room.unmount()

    // S28.03: the dive starts at once, in the Work front's layout, the motion running on it.
    const dive = take(view(), { kind: 'dive', mineId: EREBOR })
    expect(dive.id).toBe('S28.03')
    expect(dive.view).toMatchObject({ preset: 'front', mineId: EREBOR, savedScroll: 300 })
    expect(dive.view.motion).toEqual({ kind: 'diving', mineId: EREBOR, inMosaic: true, held: null })
    expect(dive.effects).toEqual([
      { kind: 'session', patch: { mosaicScrollLeft: 300, diveForDwarfId: null } },
      { kind: 'dive-pins', mineId: EREBOR, forDwarfId: null },
      { kind: 'write-preset', preset: 'front' },
      { kind: 'write-last-mine', mineId: EREBOR },
      { kind: 'play', motion: dive.view.motion, scrollLeft: 300 }
    ])
    // S28.08: settled, the Work front on that mine; nothing more is written.
    const front = take(dive.view, { kind: 'settled' })
    expect(front.id).toBe('S28.08')
    expect(front.view).toEqual({ ...dive.view, motion: undefined })
    expect(front.effects).toEqual([])

    // The stage: the column's plates grow (translate and scale from the corner), its title travels by its corner and
    // its painting by its centre, keeping its size, into the Work front's place, for M.
    const at = stageOn(CONTROL_HTML)
    at.stage.play(playOf(dive.effects).motion, 300)
    at.render(frontHtml(EREBOR))
    const zone = `[data-valle-front-mine="${EREBOR}"]`
    expect(at.of(`${zone} .dm-vz__bg`)).toEqual([
      {
        element: expect.anything(),
        frames: [
          { transform: 'translate(6px, 0px) scale(0.25, 1)', transformOrigin: '0 0' },
          { transform: 'none', transformOrigin: '0 0' }
        ],
        timing: { duration: 270, easing: OUT, fill: 'backwards' }
      }
    ])
    expect(at.of(`${zone} .dm-vz__title`)[0]?.frames).toEqual([
      { transform: 'translate(6px, 0px)', transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' }
    ])
    expect(at.of(`${zone} .dm-vz__well`)[0]?.frames).toEqual([
      { transform: 'translate(-369px, 0px)', transformOrigin: '50% 50%' },
      { transform: 'none', transformOrigin: '50% 50%' }
    ])
    // Its tools swap at once and fade in late.
    expect(at.of(`${zone} .dm-vz__tools`)[0]?.frames).toEqual([
      { opacity: 0, transformOrigin: '50% 50%' },
      { offset: 0.45, opacity: 0, transformOrigin: '50% 50%' },
      { opacity: 1, transformOrigin: '50% 50%' }
    ])
    // The other columns leave as frozen copies sliding 72 px away from the chosen one; the stack's copy sinks 8 px.
    const slide = (dx: number) => [
      { transform: 'translate(0px, 0px)', opacity: 1, transformOrigin: '50% 50%' },
      { transform: `translate(${dx}px, 0px)`, opacity: 0, transformOrigin: '50% 50%' }
    ]
    expect(at.of(`[data-ghost="${MORIA}"]`)[0]).toMatchObject({
      frames: slide(-72),
      timing: { duration: 270, easing: IN, fill: 'forwards' }
    })
    expect(at.of(`[data-ghost="${IRONHILLS}"]`)[0]?.frames).toEqual(slide(72))
    expect(at.of('.dm-cstack.is-ghost')[0]?.frames).toEqual([
      { transform: 'translate(0px, 0px)', opacity: 1, transformOrigin: '50% 50%' },
      { transform: 'translate(0px, 8px)', opacity: 0, transformOrigin: '50% 50%' }
    ])
    // The copies sit in a box clipped to the mosaic, each at its own place in it.
    const clip = at.root.querySelector<HTMLElement>('.dm-vghosts .dm-vghosts__clip')!
    expect(clip.style.left).toBe('50px')
    expect(clip.style.width).toBe('1018px')
    expect(clip.style.overflow).toBe('hidden')
    expect(at.root.querySelector<HTMLElement>(`[data-ghost="${IRONHILLS}"]`)!.style.left).toBe(
      '512px'
    )
    onlyTransformAndOpacity(at.played)
    // Settled: the copies removed and every animation ended.
    at.stage.end()
    expect(at.ghosts()).toEqual([])
    expect(at.root.querySelector('.dm-vghosts')!.children).toHaveLength(0)
    expect(at.cancelled()).toBe(1)
  })

  it('[US-VALLE-002.AC06, S28.05] a double-click on a dwarf sprite never dives', async () => {
    const room = mount(ValleControlRoom, {
      props: { columns: [{ mineId: MORIA, name: 'Moria', enterable: true }] },
      slots: { art: '<button type="button" class="dm-vdwarf" data-valle-sprite>sprite</button>' }
    })
    await room.get('[data-valle-sprite]').trigger('dblclick')
    expect(room.emitted('dive')).toBeUndefined()
    expect(room.emitted('sprite-double-click')).toHaveLength(1)
    room.unmount()
    const step = take(view(), { kind: 'sprite-double-click' })
    expect(step.id).toBe('S28.05')
    expect(step.view).toEqual(view())
    expect(step.effects).toEqual([])
  })

  it('[US-VALLE-002.AC07, S28.04] ⤢ on a mine that cannot be entered is disabled and does nothing', async () => {
    const room = mount(ValleControlRoom, {
      props: { columns: [{ mineId: IRONHILLS, name: 'Iron Hills', enterable: false }] }
    })
    const tool = room.get('button.dm-vz__dive')
    expect(tool.attributes('disabled')).toBeDefined()
    await tool.trigger('click')
    expect(room.emitted('dive')).toBeUndefined()
    room.unmount()
    const step = take(view(), { kind: 'dive', mineId: IRONHILLS })
    expect(step.id).toBe('S28.04')
    expect(step.view).toEqual(view())
    expect(step.effects).toEqual([])
  })

  it('[US-VALLE-002.AC08, S28.07] a mine not in the mosaic rises from 8 px below into the Work front', () => {
    const dive = take(view(), { kind: 'dive', mineId: KHAZAD })
    expect(dive.id).toBe('S28.07')
    expect(dive.view.motion).toEqual({
      kind: 'diving',
      mineId: KHAZAD,
      inMosaic: false,
      held: null
    })
    const at = stageOn(CONTROL_HTML)
    at.stage.play(playOf(dive.effects).motion, 300)
    at.render(frontHtml(KHAZAD))
    expect(at.of(`[data-valle-front-mine="${KHAZAD}"]`)).toEqual([
      {
        element: expect.anything(),
        frames: [
          { transform: 'translate(0px, 8px)', opacity: 0, transformOrigin: '50% 50%' },
          { transform: 'none', opacity: 1, transformOrigin: '50% 50%' }
        ],
        timing: { duration: 270, easing: OUT, fill: 'backwards' }
      }
    ])
    // No column to grow from: none of its parts travel.
    expect(at.of(`[data-valle-front-mine="${KHAZAD}"] .dm-vz__bg`)).toEqual([])
    // Every mosaic column leaves as a copy; none is the chosen one.
    expect(at.ghosts().filter((g) => g.hasAttribute('data-ghost'))).toHaveLength(3)
    onlyTransformAndOpacity(at.played)
  })

  it('[US-VALLE-002.AC10, S28.10] the chat zone width jumps at once to the Work front width while the deck fades in', () => {
    const layouts: ValleLayouts = {
      control: { chatWidth: 440, split: false, foldedList: false, zones: {} },
      front: { chatWidth: 610, split: false, foldedList: false, zone: { content: 'mine' } }
    }
    const control = view({ layouts })
    expect(valleChatWidth(control)).toBe(440)
    const dive = take(control, { kind: 'dive', mineId: EREBOR })
    // At 0 ms, with no transition of its own.
    expect(valleChatWidth(dive.view)).toBe(610)
    const at = stageOn(CONTROL_HTML)
    at.stage.play(playOf(dive.effects).motion, 300)
    at.render(frontHtml(EREBOR))
    // The deck is held at 0, 8 px below, until eased progress 0.3; the list 24 px left until 0.25.
    expect(at.of('.dm-cdeck:not(.is-ghost)')).toEqual([
      {
        element: expect.anything(),
        frames: [
          { transform: 'translate(0px, 8px)', opacity: 0, transformOrigin: '50% 50%' },
          { offset: 0.3, transform: 'translate(0px, 8px)', opacity: 0, transformOrigin: '50% 50%' },
          { transform: 'none', opacity: 1, transformOrigin: '50% 50%' }
        ],
        timing: { duration: 270, easing: OUT, fill: 'backwards' }
      }
    ])
    expect(at.of('.dm-mrows:not(.is-ghost)')[0]?.frames).toEqual([
      { transform: 'translate(-24px, 0px)', opacity: 0, transformOrigin: '50% 50%' },
      { offset: 0.25, transform: 'translate(-24px, 0px)', opacity: 0, transformOrigin: '50% 50%' },
      { transform: 'none', opacity: 1, transformOrigin: '50% 50%' }
    ])
    // Nothing animates the chat zone itself: no width, no other property, ever.
    expect(at.of('.dm-valle__chats')).toEqual([])
    onlyTransformAndOpacity(at.played)
  })

  it('[US-VALLE-002.AC11, S28.09, NFR-TIM-11] every click, double-click, ⤢ or key other than a mode control during the 330 ms dive is ignored', () => {
    // The machine: each input during the run is S28.09, changing nothing and carrying nothing out.
    const dive = take(view(), { kind: 'dive', mineId: EREBOR })
    const inputs: ValleInput[] = [
      { kind: 'dive', mineId: MORIA },
      { kind: 'sprite-double-click' },
      { kind: 'tab', preset: 'control' },
      { kind: 'arrow', key: 'ArrowLeft' },
      { kind: 'escape', layerOpen: false },
      { kind: 'fold' },
      { kind: 'nav', page: 'map' },
      { kind: 'pick', mineId: MORIA },
      { kind: 'resize' }
    ]
    for (const input of inputs) {
      const step = take(dive.view, input)
      expect(step.id, JSON.stringify(input)).toBe('S28.09')
      expect(step.view).toBe(dive.view)
      expect(step.effects).toEqual([])
    }

    // The run: about 330 ms on the frame clock, every press in between dropped, never queued for after.
    const t = presetWith({ preset: 'control' })
    expect(t.preset.send({ kind: 'dive', mineId: EREBOR })).toBe(true)
    expect(t.plays).toEqual([{ kind: 'diving', mineId: EREBOR, inMosaic: true, held: null }])
    t.clock.advance(100)
    t.preset.send({ kind: 'tab', preset: 'control' })
    t.preset.send({ kind: 'escape', layerOpen: false })
    t.preset.send({ kind: 'dive', mineId: MORIA })
    t.clock.advance(220)
    expect(t.preset.view.value.motion?.kind).toBe('diving')
    t.clock.advance(10)
    expect(t.clock.at()).toBe(330)
    expect(t.preset.view.value).toMatchObject({ preset: 'front', mineId: EREBOR })
    expect(t.preset.view.value.motion).toBeUndefined()
    expect(t.ended()).toBe(1)
    t.clock.advance(1000)
    // Nothing ran after the dive: the Work front on EREBOR, one dive, one preset written.
    expect(t.preset.view.value).toMatchObject({ preset: 'front', mineId: EREBOR })
    expect(t.plays).toHaveLength(1)
    expect(t.writes).toEqual([
      { key: 'vallePreset', value: 'front' },
      { key: 'valleLastFrontMineId', value: EREBOR }
    ])
    t.scope.stop()

    // The window: every press and key inside Valle is stopped while the run lasts, but on a mode control.
    document.body.innerHTML =
      '<main class="valle"><button id="tool">⤢</button><button id="lever" data-lever="panel">▼ Panel</button></main>'
    const root = document.querySelector<HTMLElement>('main.valle')!
    let running = true
    const remove = createInputGate(root, () => running)
    const heard: string[] = []
    for (const id of ['tool', 'lever']) {
      const button = document.getElementById(id)!
      for (const type of ['pointerdown', 'click', 'dblclick', 'keydown']) {
        button.addEventListener(type, () => heard.push(`${id}:${type}`))
      }
    }
    const press = (id: string): void => {
      const button = document.getElementById(id)!
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    }
    press('tool')
    press('lever')
    expect(heard).toEqual(['lever:pointerdown', 'lever:click', 'lever:dblclick', 'lever:keydown'])
    running = false
    press('tool')
    expect(heard.slice(4)).toEqual([
      'tool:pointerdown',
      'tool:click',
      'tool:dblclick',
      'tool:keydown'
    ])
    remove()
  })

  it('[US-VALLE-002.AC11, S28.09, S28.21] a mode control pressed mid-dive is held, the last one wins, and it runs as S28.21 once the dive settles', () => {
    // OQ-78, AMENDMENT-10: the mode can always be changed; the press is held, never dropped, the last one winning.
    const dive = take(view(), { kind: 'dive', mineId: EREBOR })
    const panel = take(dive.view, { kind: 'leave', move: { mode: 'panel', dwarfId: BORIN } })
    expect(panel.id).toBe('S28.09')
    expect(panel.effects).toEqual([])
    const veta = take(panel.view, { kind: 'leave', move: { mode: 'veta' } })
    expect(veta.view.motion?.held).toEqual({ mode: 'veta' })
    const settled = take(veta.view, { kind: 'settled' })
    expect(settled.id).toBe('S28.08')
    expect(settled.effects).toEqual([{ kind: 'move', move: { mode: 'veta' } }])

    // Through the run: the move goes out once, when the dive settles.
    const t = presetWith({ preset: 'control' })
    t.preset.send({ kind: 'dive', mineId: EREBOR })
    t.preset.send({ kind: 'leave', move: { mode: 'panel' } })
    t.preset.send({ kind: 'leave', move: { mode: 'veta' } })
    t.clock.advance(320)
    expect(t.moves).toEqual([])
    t.clock.advance(10)
    expect(t.moves).toEqual([{ mode: 'veta' }])
    t.scope.stop()
  })

  it('[US-VALLE-003.AC01, S28.11, S28.12] Control room or Esc climbs out and the mine shrinks into the column it left', () => {
    const front = frontOn()
    const triggers: ValleInput[] = [
      { kind: 'tab', preset: 'control' },
      { kind: 'escape', layerOpen: false },
      { kind: 'arrow', key: 'ArrowLeft' }
    ]
    for (const input of triggers) {
      const climb = take(front, input)
      expect(climb.id).toBe('S28.11')
      expect(climb.view).toMatchObject({ preset: 'control', mineId: EREBOR })
      expect(climb.view.motion).toEqual({
        kind: 'climbing',
        mineId: EREBOR,
        inMosaic: true,
        held: null
      })
      expect(climb.effects).toEqual([
        { kind: 'write-preset', preset: 'control' },
        { kind: 'play', motion: climb.view.motion, scrollLeft: 300 }
      ])
      const control = take(climb.view, { kind: 'settled' })
      expect(control.id).toBe('S28.12')
      expect(control.view.motion).toBeUndefined()
    }
    // Esc with another layer open closes that layer first.
    expect(stepValle(front, { kind: 'escape', layerOpen: true }, DIVE_FACTS).ok).toBe(false)

    // The stage: the leavers' copies go (the list 24 px left, the deck 8 px down, 189 ms); the mine's parts shrink
    // back into EREBOR's own column, not another.
    const climb = take(front, { kind: 'escape', layerOpen: false })
    const at = stageOn(frontHtml(EREBOR))
    at.stage.play(playOf(climb.effects).motion, 300)
    at.render(CONTROL_HTML)
    const col = `[data-valle-column="${EREBOR}"]`
    expect(at.of(`${col} .dm-vz__bg`)[0]).toMatchObject({
      frames: [
        { transform: 'translate(-6px, 0px) scale(4, 1)', transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' }
      ],
      timing: { duration: 270, easing: OUT, fill: 'backwards' }
    })
    expect(at.of(`${col} .dm-vz__well`)[0]?.frames[0]).toEqual({
      transform: 'translate(369px, 0px)',
      transformOrigin: '50% 50%'
    })
    expect(at.of(`[data-valle-column="${MORIA}"] .dm-vz__bg`)).toEqual([])
    expect(at.of('.dm-mrows.is-ghost')[0]).toMatchObject({
      frames: [
        { transform: 'translate(0px, 0px)', opacity: 1, transformOrigin: '50% 50%' },
        { transform: 'translate(-24px, 0px)', opacity: 0, transformOrigin: '50% 50%' }
      ],
      timing: { duration: 189, easing: IN, fill: 'forwards' }
    })
    expect(at.of('.dm-cdeck.is-ghost')[0]?.frames[1]).toEqual({
      transform: 'translate(0px, 8px)',
      opacity: 0,
      transformOrigin: '50% 50%'
    })
    // The other columns arrive from 72 px away from the mine, held at 0 until eased progress 0.2.
    const arrive = (dx: number) => [
      { transform: `translate(${dx}px, 0px)`, opacity: 0, transformOrigin: '50% 50%' },
      {
        offset: 0.2,
        transform: `translate(${dx}px, 0px)`,
        opacity: 0,
        transformOrigin: '50% 50%'
      },
      { transform: 'none', opacity: 1, transformOrigin: '50% 50%' }
    ]
    expect(at.of(`[data-valle-column="${MORIA}"]`)[0]?.frames).toEqual(arrive(-72))
    expect(at.of(`[data-valle-column="${IRONHILLS}"]`)[0]?.frames).toEqual(arrive(72))
    expect(at.of('.dm-cstack:not(.is-ghost)')[0]?.frames[1]).toEqual({
      offset: 0.3,
      transform: 'translate(0px, 8px)',
      opacity: 0,
      transformOrigin: '50% 50%'
    })
    onlyTransformAndOpacity(at.played)
  })

  it("[US-VALLE-003.AC02, S28.12] the mosaic's sideways scroll before the dive is restored", () => {
    const dive = take(view(), { kind: 'dive', mineId: EREBOR }, { ...DIVE_FACTS, scrollLeft: 412 })
    const front = take(dive.view, { kind: 'settled' }).view
    // Whatever the mosaic would show now, the scroll saved at the dive comes back.
    const climb = take(front, { kind: 'tab', preset: 'control' }, { ...DIVE_FACTS, scrollLeft: 0 })
    expect(playOf(climb.effects).scrollLeft).toBe(412)
    const at = stageOn(frontHtml(EREBOR))
    at.stage.play(playOf(climb.effects).motion, 412)
    at.render(CONTROL_HTML)
    // At 0 ms, before the column is measured.
    expect(at.scrolled).toEqual([[at.root.querySelector('[data-valle-mosaic]'), 412]])
  })

  it('[US-VALLE-003.AC03, S28.13] a mine that was not in the mosaic fades out in place and the scroll still returns', () => {
    const front = frontOn(KHAZAD)
    const climb = take(front, { kind: 'escape', layerOpen: false })
    expect(climb.view.motion).toEqual({
      kind: 'climbing',
      mineId: KHAZAD,
      inMosaic: false,
      held: null
    })
    expect(take(climb.view, { kind: 'settled' }).id).toBe('S28.13')
    const at = stageOn(frontHtml(KHAZAD))
    at.stage.play(playOf(climb.effects).motion, 300)
    at.render(CONTROL_HTML)
    expect(at.of(`.is-ghost[data-valle-front-mine="${KHAZAD}"]`)[0]).toMatchObject({
      frames: [
        { transform: 'translate(0px, 0px)', opacity: 1, transformOrigin: '50% 50%' },
        { transform: 'translate(0px, 8px)', opacity: 0, transformOrigin: '50% 50%' }
      ],
      timing: { duration: 189, easing: IN, fill: 'forwards' }
    })
    // No column shrinks; every column arrives from the right.
    expect(at.played.filter((p) => p.element.matches('.dm-vz__bg'))).toEqual([])
    for (const mineId of MOSAIC) {
      expect(at.of(`[data-valle-column="${mineId}"]`)[0]?.frames[0]?.transform).toBe(
        'translate(72px, 0px)'
      )
    }
    expect(at.scrolled).toEqual([[at.root.querySelector('[data-valle-mosaic]'), 300]])
  })

  it('[US-VALLE-003.AC04, S28.14] input other than a mode control during the climb does nothing until it ends', () => {
    const climb = take(frontOn(), { kind: 'escape', layerOpen: false })
    const inputs: ValleInput[] = [
      { kind: 'dive', mineId: MORIA },
      { kind: 'tab', preset: 'front' },
      { kind: 'arrow', key: 'ArrowRight' },
      { kind: 'nav', page: 'mines' },
      { kind: 'sprite-double-click' }
    ]
    for (const input of inputs) {
      const step = take(climb.view, input)
      expect(step.id, JSON.stringify(input)).toBe('S28.14')
      expect(step.view).toBe(climb.view)
      expect(step.effects).toEqual([])
    }
    const t = presetWith({ preset: 'front', lastFrontMineId: EREBOR })
    t.preset.send({ kind: 'escape', layerOpen: false })
    t.clock.advance(50)
    t.preset.send({ kind: 'dive', mineId: MORIA })
    t.clock.advance(400)
    expect(t.preset.view.value.preset).toBe('control')
    expect(t.plays).toEqual([{ kind: 'climbing', mineId: EREBOR, inMosaic: true, held: null }])
    t.scope.stop()
  })

  it('[US-VALLE-003.AC04, S28.14, S28.21] a mode control pressed mid-climb is held, the last one wins, and it runs as S28.21 once the climb settles', () => {
    // OQ-78, lead decision (review R7B-22): held as during a dive, the last one winning.
    const climb = take(frontOn(), { kind: 'tab', preset: 'control' })
    const veta = take(climb.view, { kind: 'leave', move: { mode: 'veta' } })
    expect(veta.id).toBe('S28.14')
    const panel = take(veta.view, { kind: 'leave', move: { mode: 'panel' } })
    expect(panel.view.motion?.held).toEqual({ mode: 'panel' })
    const settled = take(panel.view, { kind: 'settled' })
    expect(settled.id).toBe('S28.12')
    expect(settled.effects).toEqual([{ kind: 'move', move: { mode: 'panel' } }])
  })

  it('[S28.02, S28.26, ADR-024] after a restart Valle opens the stored preset with the mosaic scroll at its start, and the scroll is restored only within the same run', () => {
    // A dive with the mosaic scrolled: the scroll and the dive target go to the session only, never to a store.
    const dive = take(view(), { kind: 'dive', mineId: EREBOR })
    const writes = dive.effects.filter((e) => e.kind.startsWith('write-'))
    expect(JSON.stringify(writes)).not.toContain('300')
    expect(dive.effects).toContainEqual({
      kind: 'session',
      patch: { mosaicScrollLeft: 300, diveForDwarfId: null }
    })
    let preset: VallePreset = 'control'
    let last: MineId | null = null
    for (const effect of dive.effects) {
      if (effect.kind === 'write-preset') preset = effect.preset
      if (effect.kind === 'write-last-mine') last = effect.mineId
    }
    // The same run (the window opened again, the session kept): the Work front on the last mine, the scroll kept.
    const sameRun = restoreValleView({
      preset,
      layout: null,
      lastFrontMineId: last,
      session: { mosaicScrollLeft: 300, diveForDwarfId: null }
    })
    expect(sameRun).toMatchObject({ preset: 'front', mineId: EREBOR, savedScroll: 300 })
    expect(playOf(take(sameRun, { kind: 'escape', layerOpen: false }).effects).scrollLeft).toBe(300)
    // After a restart the session is empty: the stored preset on the last mine, the mosaic at its start.
    const restarted = restoreValleView({ preset, layout: null, lastFrontMineId: last, session: {} })
    expect(restarted).toMatchObject({ preset: 'front', mineId: EREBOR })
    expect(restarted.savedScroll).toBeUndefined()
    expect(playOf(take(restarted, { kind: 'escape', layerOpen: false }).effects).scrollLeft).toBe(0)
  })

  it('[US-VALLE-003.AC05, S28.12] the width jumps back and pinned chats keep their own layout', () => {
    const layouts: ValleLayouts = {
      control: { chatWidth: 440, split: false, foldedList: false, zones: {} },
      front: { chatWidth: 610, split: true, foldedList: false, zone: { content: 'mine' } }
    }
    const dive = take(view({ layouts }), { kind: 'dive', mineId: EREBOR })
    const front = take(dive.view, { kind: 'settled' }).view
    expect(valleChatWidth(front)).toBe(610)
    const climb = take(front, { kind: 'escape', layerOpen: false })
    expect(valleChatWidth(climb.view)).toBe(440)
    // The climb leaves the pins and both layouts as they were: no tab order, no layout write.
    expect(climb.view.layouts).toEqual(layouts)
    expect(climb.effects.map((e) => e.kind)).toEqual(['write-preset', 'play'])
    const at = stageOn(frontHtml(EREBOR))
    at.stage.play(playOf(climb.effects).motion, 300)
    at.render(CONTROL_HTML)
    expect(at.of('.dm-valle__chats')).toEqual([])
  })

  it('[S28.15, S28.22, S28.23, S28.24] a list pick swaps the mine in place; hiding resolves the motion; a removed mine swaps or climbs out; an unenterable mine stays shown', async () => {
    // The compact list hands a pick to the machine above, the mine shown marked current.
    const list = mount(ValleWorkFront, {
      props: {
        foldedList: false,
        mines: [
          { mineId: MORIA, name: 'Moria' },
          { mineId: EREBOR, name: 'Erebor' }
        ],
        mine: { mineId: EREBOR, name: 'Erebor' }
      }
    })
    expect(list.get(`[data-valle-row="${EREBOR}"]`).attributes('aria-current')).toBe('true')
    // AMENDED for ISSUE-307 (US-VALLE-013.AC05, .AC09): the Work front's one mine is the current mine, so its name
    // ends with ", current".
    expect(list.get(`[data-valle-front-mine="${EREBOR}"]`).attributes('aria-label')).toBe(
      'Mine Erebor, current'
    )
    await list.get(`[data-valle-row="${MORIA}"]`).trigger('click')
    expect(list.emitted('pick')).toEqual([[MORIA]])
    list.unmount()

    const front = frontOn()
    // S28.15: another mine picked, with a dwarf named: it swaps in place for 180 ms, the dwarf first in the tabs.
    const pick = take(front, { kind: 'pick', mineId: MORIA, dwarfId: NALI })
    expect(pick.id).toBe('S28.15')
    expect(pick.view).toMatchObject({ preset: 'front', mineId: MORIA })
    expect(pick.view.motion).toEqual({
      kind: 'front-swapping',
      mineId: MORIA,
      inMosaic: true,
      held: null
    })
    expect(pick.effects).toEqual([
      { kind: 'dive-pins', mineId: MORIA, forDwarfId: NALI },
      { kind: 'write-last-mine', mineId: MORIA },
      { kind: 'play', motion: pick.view.motion, scrollLeft: 300 }
    ])
    expect(take(pick.view, { kind: 'settled' }).id).toBe('S28.15')
    expect(valleRunMs('front-swapping', false)).toBe(180)
    expect(stepValle(front, { kind: 'pick', mineId: EREBOR }, DIVE_FACTS).ok).toBe(false)
    const at = stageOn(frontHtml(EREBOR))
    at.stage.play(playOf(pick.effects).motion, 300)
    at.render(frontHtml(MORIA))
    expect(at.of(`.is-ghost[data-valle-front-mine="${EREBOR}"]`)[0]).toMatchObject({
      frames: [
        { opacity: 1, transformOrigin: '50% 50%' },
        { opacity: 0, transformOrigin: '50% 50%' }
      ],
      timing: { duration: 180, easing: IN, fill: 'forwards' }
    })
    expect(at.of(`[data-valle-front-mine="${MORIA}"]:not(.is-ghost)`)[0]).toMatchObject({
      frames: [
        { transform: 'translate(0px, 6px)', opacity: 0, transformOrigin: '50% 50%' },
        { transform: 'none', opacity: 1, transformOrigin: '50% 50%' }
      ],
      timing: { duration: 180, easing: OUT, fill: 'backwards' }
    })
    onlyTransformAndOpacity(at.played)

    // S28.22: hidden mid-motion, each run resolves at once to its end state, a held mode control still run.
    const diving = take(view(), { kind: 'dive', mineId: EREBOR })
    const held = take(diving.view, { kind: 'leave', move: { mode: 'panel' } })
    const hidden = take(held.view, { kind: 'hidden' })
    expect(hidden.id).toBe('S28.22')
    expect(hidden.view).toMatchObject({ preset: 'front', mineId: EREBOR })
    expect(hidden.view.motion).toBeUndefined()
    expect(hidden.effects).toEqual([{ kind: 'move', move: { mode: 'panel' } }])
    const climbing = take(front, { kind: 'escape', layerOpen: false })
    const climbHidden = take(climbing.view, { kind: 'hidden' })
    expect(climbHidden.view.preset).toBe('control')
    expect(climbHidden.view.motion).toBeUndefined()
    expect(take(pick.view, { kind: 'hidden' }).view.motion).toBeUndefined()
    // Left mid-swap: the swap resolves at once and the move runs.
    const left = take(pick.view, { kind: 'leave', move: { mode: 'veta' } })
    expect(left.id).toBe('S28.22')
    expect(left.view.motion).toBeUndefined()
    expect(left.effects).toEqual([{ kind: 'move', move: { mode: 'veta' } }])

    // S28.23: the shown mine removed: a swap to the first enterable mosaic column's mine, without a climb.
    const removed = take(front, { kind: 'mine-removed', mineId: EREBOR })
    expect(removed.id).toBe('S28.23')
    expect(removed.view.motion).toEqual({
      kind: 'front-swapping',
      mineId: MORIA,
      inMosaic: true,
      held: null
    })
    // With no other mine to show, climbed out at once, the scroll restored, no motion.
    const alone: ValleFacts = {
      ...DIVE_FACTS,
      mines: [{ mineId: EREBOR, enterable: true }],
      mosaic: [EREBOR]
    }
    const out = take(front, { kind: 'mine-removed', mineId: EREBOR }, alone)
    expect(out.id).toBe('S28.23')
    expect(out.view.preset).toBe('control')
    expect(out.view.motion).toBeUndefined()
    expect(out.effects).toEqual([
      { kind: 'write-preset', preset: 'control' },
      { kind: 'restore-scroll', scrollLeft: 300 }
    ])
    // Another mine removed is not this machine's.
    expect(stepValle(front, { kind: 'mine-removed', mineId: MORIA }, DIVE_FACTS).ok).toBe(false)

    // S28.24: the shown mine made unenterable stays shown.
    const unenterable = take(front, { kind: 'mine-unenterable', mineId: EREBOR })
    expect(unenterable.id).toBe('S28.24')
    expect(unenterable.view).toBe(front)
    expect(unenterable.effects).toEqual([])
  })

  it('[NFR-TIM-16, S28.22] a run ends on the first of its own duration, its watchdog or the window going hidden', () => {
    expect(valleRunMs('diving', false)).toBe(330)
    expect(valleRunMs('climbing', false)).toBe(330)
    // Reduced motion: every duration reads 0 ms, so the switch lands in one frame.
    expect(valleRunMs('diving', true)).toBe(0)
    const clock = fakeClock()
    let ended = 0
    startValleRun(clock, 330, () => (ended += 1))
    clock.advance(320)
    expect(ended).toBe(0)
    clock.advance(10)
    expect(ended).toBe(1)
    clock.advance(1000)
    expect(ended).toBe(1)
    // An occluded window's frames stop: the watchdog at its duration + 40 ms ends the run.
    const frozen = fakeClock()
    frozen.frozen = true
    let stuck = 0
    startValleRun(frozen, 330, () => (stuck += 1))
    frozen.advance(360)
    expect(stuck).toBe(0)
    frozen.advance(10)
    expect(stuck).toBe(1)
    // Hidden mid-dive: the machine resolves the run at once and the clock stops for it.
    const t = presetWith({ preset: 'control' })
    t.preset.send({ kind: 'dive', mineId: EREBOR })
    t.clock.advance(50)
    expect(t.preset.send({ kind: 'hidden' })).toBe(true)
    expect(t.preset.view.value.motion).toBeUndefined()
    expect(t.ended()).toBe(1)
    t.clock.advance(1000)
    expect(t.ended()).toBe(1)
    t.scope.stop()
  })

  it('[ADR-024] a transition not listed in 07 machine 28 is rejected (dive and climb)', () => {
    const front = frontOn()
    const swapping = take(front, { kind: 'pick', mineId: MORIA }).view
    const refused: [ValleView, ValleInput][] = [
      [view(), { kind: 'settled' }],
      [view(), { kind: 'hidden' }],
      [view(), { kind: 'pick', mineId: MORIA }],
      [view(), { kind: 'mine-removed', mineId: MORIA }],
      [front, { kind: 'dive', mineId: MORIA }],
      [front, { kind: 'sprite-double-click' }],
      [front, { kind: 'settled' }],
      [view({ page: 'map' }), { kind: 'dive', mineId: MORIA }],
      [swapping, { kind: 'tab', preset: 'control' }],
      [swapping, { kind: 'pick', mineId: EREBOR }]
    ]
    for (const [at, input] of refused) {
      expect(
        stepValle(at, input, DIVE_FACTS),
        JSON.stringify([at.preset, at.motion, input])
      ).toEqual({ ok: false, reason: 'not-listed' })
    }
  })
})
