// @vitest-environment jsdom
import type {
  HostFrame,
  ModeTransition,
  MoveToModeParams,
  UiPreferenceWrite,
  UiSessionPatch
} from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { modeTransitionPart } from '../../composables/useModeTransition'
import type { ValleBodyObserver } from '../../composables/useValleSplit'
import { VALLE_STORE_DEFAULTS, type ValleStores } from '../../composables/useValleStores'
import type { ValleClock } from '../../lib/valle/flip'
import { defaultValleLayouts } from '../../lib/valle/preset'
import {
  BORIN,
  DAIN,
  EREBOR,
  KHAZAD,
  MORIA,
  NALI,
  dwarfWire,
  frame,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import { AMBIENCE_SRC, UI_SFX_SRC } from '../../lib/audio/audioAssets'
import { createFakeAudioPlayer, type FakeAudioPlayer } from '../../lib/audio/fakeAudioPlayer'
import { DEFAULT_AUDIO_PREFERENCES, type ProjectSummary } from '../../types'
import HistoryPanel from '../history/HistoryPanel.vue'
import AddPanel from '../launch/AddPanel.vue'
import DwarfMessagePanel from '../message/DwarfMessagePanel.vue'
import markSource from './CurrentMineMark.vue?raw'
import counterSource from './NeedsYouCounter.vue?raw'
import ValleApp from './ValleApp.vue'
import { valleBridgeOf } from './valleEntry'

/*
 * The Valle root wired to its preset (ISSUE-300; 07 machine 28, S29.02, S32.02; UC-053, UC-069) over the generated fake
 * `window.api`: the inputs reach machine 28, each change is written through A-N21, and the restored pins and mosaic
 * order are drawn once the Host's facts are read.
 */

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

/**
 * The clock a dive or a climb runs on, driven by hand (AMENDED for ISSUE-301: the root runs each dive and climb for
 * about 330 ms, input waiting meanwhile): frames and timers fire as `advance` moves time on.
 */
function manualClock() {
  let now = 0
  let id = 0
  const frames = new Map<number, (at: number) => void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: ValleClock & { advance(ms: number): void } = {
    frame(run) {
      frames.set((id += 1), run)
      return id
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number)
    },
    now: () => now,
    set(run, ms) {
      timers.set((id += 1), { at: now + ms, run })
      return id
    },
    clear: (handle) => {
      timers.delete(handle as number)
    },
    advance(ms) {
      const until = now + ms
      while (now < until) {
        now = Math.min(now + 10, until)
        for (const [key, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(key)
          timer.run()
        }
        const due = [...frames.values()]
        frames.clear()
        for (const run of due) run(now)
      }
    }
  }
  return clock
}

function mountValle(
  stores: Partial<ValleStores>,
  bodyObserver: ValleBodyObserver = () => () => {},
  // AMENDED for ISSUE-304: members a case answers itself (the Settings page's reads and writes).
  overrides: Partial<Window['api']> = {}
) {
  const writes: UiPreferenceWrite[] = []
  const moves: MoveToModeParams[] = []
  const patches: UiSessionPatch[] = []
  const clock = manualClock()
  // AMENDED for ISSUE-304: the pages a zone or a nav page hosts (the Map, the Mines list, a mine's history) read the
  // page's own `window.api` through their composables (ADR-033 item 2), as the Panel's do; the Host's frames reach
  // every listener, and the projects and the history answer.
  const hostListeners: ((frames: unknown) => void)[] = []
  const api = createFakeWindowApi({
    onHostEvent: (listener) => {
      hostListeners.push(listener as (frames: unknown) => void)
      return () => {}
    },
    queryProjects: () => Promise.resolve({ answered: true, projects: PROJECTS }) as never,
    getMineHistory: (mineId) =>
      Promise.resolve({ ok: true, value: { mineId, speakers: [] } }) as never,
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA)]
        })
      ) as never,
    setUiPreference: (write) => {
      writes.push(write as UiPreferenceWrite)
      return Promise.resolve(write) as never
    },
    patchUiSession: (patch) => {
      patches.push(patch as UiSessionPatch)
    },
    moveToMode: (params) => {
      moves.push(params as MoveToModeParams)
      return Promise.resolve({ ok: true }) as never
    },
    ...overrides
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  // AMENDED for ISSUE-307: the window's sound engine (US-VALLE-016) plays through the transplanted fake player, never
  // through an `Audio` element.
  const player = createFakeAudioPlayer()
  root = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: { ...VALLE_STORE_DEFAULTS, ...stores },
      observer: () => new InertObserver(),
      // jsdom has no ResizeObserver: unless a test measures the body, it never is, and the split stays off.
      bodyObserver,
      clock,
      audioPlayer: player
    }
  })
  /** A-N02: one batch of Host frames, to every listener. */
  const push = (frames: HostFrame[]): void => hostListeners.forEach((listener) => listener(frames))
  return { root, writes, moves, patches, clock, push, player }
}

/** The projects the Mines page reads (A-34): both fixture mines, remembered. */
const PROJECTS: ProjectSummary[] = [MORIA, EREBOR].map((id, at) => ({
  id,
  path: mineWire(id).path,
  name: mineWire(id).name,
  declared: true,
  addedAt: at,
  live: true
}))

const esc = (): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

describe('the Valle root and its presets (ISSUE-300)', () => {
  it('[S28.19, S28.20, US-VALLE-001.AC02] Esc leaves a nav page first, then the Work front, the top bar and the chat zone staying in place', async () => {
    const { root, writes } = mountValle({ preset: 'front' })
    await flushPromises()
    const valle = root.get('[data-valle-root]')
    const bar = root.get('header.dm-vbar').element
    const chats = root.get('aside[aria-label="Pinned chats"]').element

    await root.get('[data-slot="map"]').trigger('click')
    expect(valle.attributes('data-page')).toBe('map')
    expect(root.find('[data-valle-page="map"]').exists()).toBe(true)
    esc()
    await flushPromises()
    expect(valle.attributes('data-page')).toBe('mines')
    expect(valle.attributes('data-preset')).toBe('front')
    esc()
    await flushPromises()
    expect(valle.attributes('data-preset')).toBe('control')
    // The top bar and the chat zone are the same elements throughout (VA3).
    expect(root.get('header.dm-vbar').element).toBe(bar)
    expect(root.get('aside[aria-label="Pinned chats"]').element).toBe(chats)
    // AMENDED for ISSUE-304 (was: the preset alone): the first open with no stored order writes the first mosaic, every
    // mine with a crew (07 S32.01), before any change of this case.
    expect(writes).toEqual([
      { key: 'valleMosaicOrder', value: [MORIA] },
      { key: 'vallePreset', value: 'control' }
    ])
  })

  it("[US-VALLE-001.AC04, US-VALLE-001.AC07, S28.16, S28.17] the Work front's list folds to the MINES strip and back, each change written through A-N21", async () => {
    const { root, writes } = mountValle({ preset: 'front' })
    await flushPromises()
    await root.get('button[aria-label="Fold the list"]').trigger('click')
    const strip = root.get('button[aria-label="Show the mines list"]')
    expect(strip.text()).toBe('MINES')
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 44px')
    await strip.trigger('click')
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 232px')
    const folded = defaultValleLayouts()
    folded.front.foldedList = true
    // AMENDED for ISSUE-304 (was: the two layouts alone): the first open with no stored order writes the first mosaic,
    // every mine with a crew (07 S32.01), before any change of this case.
    expect(writes).toEqual([
      { key: 'valleMosaicOrder', value: [MORIA] },
      { key: 'valleLayout', value: folded },
      { key: 'valleLayout', value: defaultValleLayouts() }
    ])
  })

  it("[US-VALLE-001.AC09, S29.02, S32.02] the restored pins and mosaic order are drawn once the Host's facts are read, a dwarf ended meanwhile gone", async () => {
    const { root } = mountValle({
      preset: 'control',
      pins: [
        { dwarfId: DAIN, mineId: EREBOR, order: 1 },
        { dwarfId: BORIN, mineId: MORIA, order: 0 }
      ],
      mosaicOrder: [EREBOR, KHAZAD, MORIA]
    })
    await flushPromises()
    expect(
      root
        .findAll('[data-pin]')
        .map((pin) => [pin.attributes('data-pin'), pin.attributes('data-pin-state')])
    ).toEqual([
      [BORIN, 'live'],
      [DAIN, 'gone']
    ])
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([EREBOR, MORIA])
  })
})

// APPENDED for ISSUE-302: the pinned chats in the Valle root (07 machine 29; TC-302-01).
describe('the pinned chats in the Valle root (ISSUE-302)', () => {
  // TC-302-01: every pin action is persisted at once, chat pins only.
  it('[S29.02, S29.10] the restored pins are the Control room’s stack and the Work front’s tabs, and an unpin is written through A-N21 at once', async () => {
    const { root, writes, clock } = mountValle({
      preset: 'control',
      pins: [
        { dwarfId: BORIN, mineId: MORIA, order: 0 },
        { dwarfId: DAIN, mineId: EREBOR, order: 1 }
      ]
    })
    await flushPromises()
    const chats = root.get('aside[aria-label="Pinned chats"]')
    expect(chats.find('section.dm-cstack').exists()).toBe(true)
    expect(chats.get('.dm-cstack__count').text()).toBe('2')
    expect(chats.get('[data-expanded="true"]').attributes('data-pin')).toBe(BORIN)

    await root.get('[data-preset-tab="front"]').trigger('click')
    // AMENDED for ISSUE-301: the Work front tab dives into the most recent mine, Moria (07 S28.06), whose tab order
    // (S29.12) keeps BORIN first; input waits until the dive settles.
    clock.advance(330)
    await flushPromises()
    expect(chats.find('section.dm-cstack').exists()).toBe(false)
    expect(chats.findAll('[role="tab"]').map((tab) => tab.attributes('data-pin'))).toEqual([
      BORIN,
      DAIN
    ])
    await chats.get(`[role="tab"][data-pin="${DAIN}"] .dm-ctab__x`).trigger('click')
    expect(chats.findAll('[role="tab"]').map((tab) => tab.attributes('data-pin'))).toEqual([BORIN])
    expect(writes.filter((write) => write.key === 'pins')).toEqual([
      { key: 'pins', value: [{ dwarfId: BORIN, mineId: MORIA, order: 0 }] }
    ])
  })

  it('[US-VALLE-008.AC01, US-VALLE-008.AC02, S30.01, S30.02] ⫽ in the Work front shows two chats side by side and back, the wish written with the Work front layout through A-N21', async () => {
    // The body measured once, wide enough for 640 px of room beside the mine (07 machine 30).
    const { root, writes } = mountValle(
      {
        preset: 'front',
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: DAIN, mineId: EREBOR, order: 1 }
        ]
      },
      (_target, callback) => {
        callback(1600)
        return () => {}
      }
    )
    await flushPromises()
    const panes = () => root.findAll('.dm-cdeck__pane').map((p) => p.attributes('data-pane'))
    expect(panes()).toEqual([BORIN])
    const press = root.get('button.dm-cdeck__split')
    expect(press.attributes('disabled')).toBeUndefined()
    await press.trigger('click')
    expect(panes()).toEqual([BORIN, DAIN])
    await press.trigger('click')
    expect(panes()).toEqual([BORIN])
    const split = (on: boolean) => {
      const layouts = defaultValleLayouts()
      layouts.front.split = on
      return { key: 'valleLayout', value: layouts }
    }
    // AMENDED for ISSUE-304 (was: the two wishes alone): the first open with no stored order writes the first mosaic,
    // every mine with a crew (07 S32.01), before any change of this case.
    expect(writes).toEqual([{ key: 'valleMosaicOrder', value: [MORIA] }, split(true), split(false)])
  })
})

// APPENDED for ISSUE-301: the dive into a mine and the climb out in the Valle root (07 machine 28; UC-054).
describe('the dive and the climb in the Valle root (ISSUE-301)', () => {
  it('[US-VALLE-002.AC01, US-VALLE-002.AC11, US-VALLE-003.AC02, S28.03, S28.12] ⤢ dives into that mine, input waiting meanwhile, and the climb returns the mosaic to its saved scroll', async () => {
    // jsdom keeps no scroll: each element keeps the one it is given.
    const scrolls = new WeakMap<Element, number>()
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get(this: Element) {
        return scrolls.get(this) ?? 0
      },
      set(this: Element, left: number) {
        scrolls.set(this, left)
      }
    })
    try {
      const { root, writes, patches, clock } = mountValle({
        preset: 'control',
        mosaicOrder: [MORIA, EREBOR]
      })
      await flushPromises()
      const valle = root.get('[data-valle-root]')
      root.get('[data-valle-mosaic]').element.scrollLeft = 240

      await root.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).trigger('click')
      expect(valle.attributes('data-preset')).toBe('front')
      expect(valle.attributes('data-motion')).toBe('diving')
      expect(writes).toEqual([
        { key: 'vallePreset', value: 'front' },
        { key: 'valleLastFrontMineId', value: EREBOR }
      ])
      expect(patches).toContainEqual({
        kind: 'valle',
        patch: { mosaicScrollLeft: 240, diveForDwarfId: null }
      })
      // Mid-dive, a press on the list's fold is dropped, never run after.
      await root.get('button[aria-label="Fold the list"]').trigger('click')
      clock.advance(320)
      expect(valle.attributes('data-motion')).toBe('diving')
      clock.advance(10)
      await flushPromises()
      expect(valle.attributes('data-motion')).toBe('none')
      // AMENDED for ISSUE-307 (US-VALLE-013.AC05, .AC09): the Work front's one mine is the current mine, so its name ends
      // with ", current".
      expect(root.get(`[data-valle-front-mine="${EREBOR}"]`).attributes('aria-label')).toBe(
        'Mine erebor, current'
      )
      expect(writes.filter((write) => write.key === 'valleLayout')).toEqual([])

      // Esc climbs out: the mosaic back at the scroll it had before the dive.
      esc()
      await flushPromises()
      expect(valle.attributes('data-preset')).toBe('control')
      expect(valle.attributes('data-motion')).toBe('climbing')
      expect(root.get('[data-valle-mosaic]').element.scrollLeft).toBe(240)
      clock.advance(330)
      await flushPromises()
      expect(valle.attributes('data-motion')).toBe('none')
      expect(writes.at(-1)).toEqual({ key: 'vallePreset', value: 'control' })
    } finally {
      if (descriptor !== undefined)
        Object.defineProperty(Element.prototype, 'scrollLeft', descriptor)
    }
  })
})

// APPENDED for ISSUE-304: the zone menu, "Close this column" and "Add a mine here" in the Valle root (07 machines 31,
// 32; UC-058).
describe('the Valle zones and the mosaic in the root (ISSUE-304)', () => {
  /** A menu row as it reads: its label, its far-end hint ("✓", a tier) after a space, and "(disabled)" when it is. */
  const rowText = (item: ReturnType<VueWrapper['get']>): string => {
    const hint = item.find('.dm-menu__hint')
    const label = hint.exists() ? item.text().slice(0, -hint.text().length) : item.text()
    const disabled = item.attributes('disabled') !== undefined ? ' (disabled)' : ''
    return `${label}${hint.exists() ? ` ${hint.text()}` : ''}${disabled}`
  }
  const menuTexts = (root: VueWrapper, menu = '[data-zone-menu]'): string[] =>
    root
      .findAll(`${menu} [role="menuitem"], ${menu} [role="separator"]`)
      .map((item) => (item.attributes('role') === 'separator' ? '—' : rowText(item)))
  /** The menu row that reads `label`. */
  const row = (root: VueWrapper, label: string, menu = '[data-zone-menu]') => {
    const found = root
      .findAll(`${menu} [role="menuitem"]`)
      .find((item) => rowText(item).startsWith(label))
    if (found === undefined) throw new Error(`no menu row "${label}"`)
    return found
  }

  it('[US-VALLE-009.AC01, US-VALLE-009.AC05, S31.01, S31.04] a column’s ⋯ opens its zone menu, and Show here swaps it in its slot with the header noting it', async () => {
    const { root, writes } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${EREBOR}"] [data-zone-more]`).trigger('click')
    expect(menuTexts(root)).toEqual([
      'Dive in · Work front',
      '—',
      'Show here: the mine ✓ (disabled)',
      'Show here: the map',
      'Show here: the mines list',
      'Show here: history',
      '—',
      'Mute mine ambience',
      '—',
      'Close this column'
    ])
    await row(root, 'Show here: the mines list').trigger('click')
    await flushPromises()
    const column = root.get(`[data-valle-column="${EREBOR}"]`)
    expect(column.attributes('data-content')).toBe('mineslist')
    expect(column.get('[data-zone-suffix]').text()).toBe('· Mines')
    // Its slot is kept: the same place in the mosaic, and the menu closed.
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([MORIA, EREBOR])
    expect(root.find('[data-zone-menu]').exists()).toBe(false)
    expect(writes.filter((write) => write.key === 'valleLayout').at(-1)).toMatchObject({
      value: { control: { zones: { [EREBOR]: { content: 'mineslist' } } } }
    })
  })

  it('[US-VALLE-009.AC04, US-VALLE-009.AC06, NFR-A11Y-02] the Work front’s zone menu has no mines list and no Close this column, and Esc or an outside click closes it, nothing else', async () => {
    const { root, writes } = mountValle({ preset: 'front', lastFrontMineId: MORIA })
    await flushPromises()
    const before = writes.length
    await root.get('[data-valle-front-mine] [data-zone-more]').trigger('click')
    expect(menuTexts(root)).toEqual([
      'Show here: the mine ✓ (disabled)',
      'Show here: the map',
      'Show here: history',
      '—',
      'Mute mine ambience'
    ])
    // Esc closes the menu, the topmost layer, never the Work front beneath (NFR-A11Y-02).
    esc()
    await flushPromises()
    expect(root.find('[data-zone-menu]').exists()).toBe(false)
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('front')
    await root.get('[data-valle-front-mine] [data-zone-more]').trigger('click')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(root.find('[data-zone-menu]').exists()).toBe(false)
    expect(writes.slice(before)).toEqual([])
  })

  it('[US-VALLE-009.AC03, BR-23, S32.03] Close this column takes the column out with its toast', async () => {
    const { root, writes, moves } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${MORIA}"] [data-zone-more]`).trigger('click')
    await row(root, 'Close this column').trigger('click')
    await flushPromises()
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([EREBOR])
    expect(root.get('.dm-toasts').text()).toContain(
      'moria left the Control room · its dwarfs keep working'
    )
    expect(writes.at(-1)).toEqual({ key: 'valleMosaicOrder', value: [EREBOR] })
    expect(moves).toEqual([])
  })

  it('[US-VALLE-006.AC01, US-VALLE-006.AC02, S32.04, S32.05] the add slot after the last column lists the mines not shown, then A new project…, and a picked mine joins the end', async () => {
    const { root, writes } = mountValle({ preset: 'control', mosaicOrder: [MORIA] })
    await flushPromises()
    const slot = root.get('[data-valle-add]')
    expect(slot.text()).toContain('Add a mine here')
    await slot.trigger('click')
    expect(menuTexts(root, '[data-valle-add-menu]')).toEqual([
      'erebor Silver',
      '—',
      'A new project…'
    ])
    await row(root, 'erebor', '[data-valle-add-menu]').trigger('click')
    await flushPromises()
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([MORIA, EREBOR])
    expect(root.find('[data-valle-add-menu]').exists()).toBe(false)
    expect(writes.at(-1)).toEqual({ key: 'valleMosaicOrder', value: [MORIA, EREBOR] })
  })

  it('[S31.07, S28.03] Dive in · Work front in a column’s menu dives into its mine', async () => {
    const { root, clock } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${EREBOR}"] [data-zone-more]`).trigger('click')
    await row(root, 'Dive in · Work front').trigger('click')
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('front')
    clock.advance(330)
    await flushPromises()
    expect(root.find(`[data-valle-front-mine="${EREBOR}"]`).exists()).toBe(true)
  })
})

// APPENDED for ISSUE-304: each zone registers with the on-screen report; only a zone showing its mine counts (07 S39.05,
// machine 31; UC-058 A-44).
describe('the Valle zones in the on-screen report (ISSUE-304)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[S39.05, US-VALLE-009.AC01] a column swapped to the map leaves the on-screen report, and comes back showing its mine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reports: string[][] = []
    let seen: ((entries: { target: Element; intersectionRatio: number }[]) => void) | null = null
    const observed: Element[] = []
    const api = createFakeWindowApi({
      getHostSnapshot: () =>
        Promise.resolve(
          snapshotPage(10, {
            minesEverKnown: true,
            mines: [mineWire(MORIA), mineWire(EREBOR)],
            dwarfs: [dwarfWire(BORIN, MORIA)]
          })
        ) as never,
      setUiPreference: (write) => Promise.resolve(write) as never,
      reportVisibleMines: (request) => {
        reports.push(request.mineIds.map(String))
      }
    })
    Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
    root = mount(ValleApp, {
      attachTo: document.body,
      props: {
        bridge: valleBridgeOf(api),
        stores: { ...VALLE_STORE_DEFAULTS, preset: 'control', mosaicOrder: [MORIA, EREBOR] },
        observer: (callback) => {
          seen = callback
          return {
            observe: (element: Element) => void observed.push(element),
            unobserve: () => {},
            disconnect: () => {}
          }
        },
        bodyObserver: () => () => {}
      }
    })
    await flushPromises()
    // Both columns fully inside the viewport.
    seen!(observed.map((target) => ({ target, intersectionRatio: 1 })))
    await flushPromises()
    vi.advanceTimersByTime(150)
    expect(reports.at(-1)).toEqual([MORIA, EREBOR])

    await root.get(`[data-valle-column="${EREBOR}"] [data-zone-more]`).trigger('click')
    const map = root
      .findAll('[data-zone-menu] [role="menuitem"]')
      .find((item) => item.text().startsWith('Show here: the map'))!
    await map.trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(150)
    expect(reports.at(-1)).toEqual([MORIA])

    await root.get(`[data-valle-column="${EREBOR}"] [data-zone-more]`).trigger('click')
    const mine = root
      .findAll('[data-zone-menu] [role="menuitem"]')
      .find((item) => item.text().startsWith('Show here: the mine'))!
    await mine.trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(150)
    expect(reports.at(-1)).toEqual([MORIA, EREBOR])
  })
})

// APPENDED for ISSUE-304: a zone, or a nav page over the main zone, shows the Panel's own Map, Mines list or a mine's
// history (US-VALLE-009.AC01; 07 S31.03…S31.06, S28.19), fed from the same composables as the Panel.
describe('the pages a Valle zone or nav page shows (ISSUE-304)', () => {
  /** Picks "Show here: …" in a column's zone menu. */
  async function showHere(root: VueWrapper, mineId: string, item: string): Promise<void> {
    await root.get(`[data-valle-column="${mineId}"] [data-zone-more]`).trigger('click')
    const found = root
      .findAll('[data-zone-menu] [role="menuitem"]')
      .find((row) => row.text().startsWith(item))
    if (found === undefined) throw new Error(`no menu row "${item}"`)
    await found.trigger('click')
    await flushPromises()
  }

  it('[US-VALLE-009.AC01, S31.03] a zone shown the map draws the Map page in its slot, the header noting it', async () => {
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await showHere(root, EREBOR, 'Show here: the map')
    const column = root.get(`[data-valle-column="${EREBOR}"]`)
    expect(column.find('[data-zone-content="map"] .dm-mappage').exists()).toBe(true)
    expect(column.get('[data-zone-suffix]').text()).toBe('· Map')
    // The other column still shows its mine.
    expect(root.get(`[data-valle-column="${MORIA}"]`).find('.dm-mappage').exists()).toBe(false)
  })

  it('[US-VALLE-009.AC01, S31.04] a zone shown the mines list draws the Mines page in its slot, with the remembered mines', async () => {
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await showHere(root, MORIA, 'Show here: the mines list')
    const list = root.find(
      `[data-valle-column="${MORIA}"] [data-zone-content="mineslist"] .dm-mines`
    )
    expect(list.exists()).toBe(true)
    expect(list.text()).toContain('erebor')
  })

  it("[US-VALLE-009.AC01, S31.05, S31.06] a zone shown history draws that mine's history, and its own close shows the mine again", async () => {
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await showHere(root, MORIA, 'Show here: history')
    const column = root.get(`[data-valle-column="${MORIA}"]`)
    const history = column.find('[data-zone-content="history"] .dm-hist')
    expect(history.exists()).toBe(true)
    expect(history.attributes('aria-label')).toBe('Mine history, moria')
    await history.get('button[title="Close history"]').trigger('click')
    await flushPromises()
    expect(column.attributes('data-content')).toBe('mine')
    expect(column.find('.dm-hist').exists()).toBe(false)
  })

  it("[S28.19] the nav's Map and Mines pages draw the Panel's Map and Mines list over the main zone", async () => {
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA] })
    await flushPromises()
    await root.get('[data-slot="map"]').trigger('click')
    await flushPromises()
    expect(root.find('[data-valle-page="map"] .dm-mappage').exists()).toBe(true)
    // From a page only Esc is listed (S28.20): back to the preset, then the Mines page.
    esc()
    await flushPromises()
    await root.get('[data-slot="mines"]').trigger('click')
    await flushPromises()
    expect(root.find('[data-valle-page="mines"] .dm-mines').exists()).toBe(true)
  })

  it('[S32.14, S28.20, US-VALLE-006.AC02] opening a mine from the nav Mines page returns to the Control room with its column added', async () => {
    const { root, writes } = mountValle({ preset: 'control', mosaicOrder: [MORIA] })
    await flushPromises()
    await root.get('[data-slot="mines"]').trigger('click')
    await flushPromises()
    const card = root
      .findAll('[data-valle-page="mines"] .dm-mines button[aria-label]')
      .find((item) => item.attributes('aria-label')?.startsWith('Open erebor'))
    expect(card).toBeDefined()
    await card!.trigger('click')
    await flushPromises()
    expect(root.find('[data-valle-page]').exists()).toBe(false)
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([MORIA, EREBOR])
    expect(writes.at(-1)).toEqual({ key: 'valleMosaicOrder', value: [MORIA, EREBOR] })
  })

  it('[US-OBS-002.AC07, S39.11] an announced arrival is said once in Valle, not twice', async () => {
    const { root, push } = mountValle({ preset: 'control', mosaicOrder: [MORIA] })
    await flushPromises()
    // AMENDED for TVC (was: every "started in" toast on screen): the window's toast queue is a module singleton that
    // outlives a mount, and CI shuffles the cases (ci.yml), so an earlier case's arrival can still be showing. Only
    // what this arrival adds is counted; it must still be exactly one.
    const startedIn = (): number =>
      root.findAll('.dm-toasts > *').filter((toast) => toast.text().includes('started in')).length
    const before = startedIn()
    push([frame(11, 'dwarf.arrived', { dwarf: dwarfWire(DAIN, EREBOR), announce: true })])
    await flushPromises()
    expect(startedIn() - before).toBe(1)
  })
})

// APPENDED for ISSUE-304 (owner decision 2026-10-22): Settings over Valle's main zone (S28.19) is the Panel's own page
// without the rows that act on the Panel window, and its Sound rows only change the stored volumes: no playback and no
// audio engine in the Valle window until US-VALLE-016.
describe('the Settings page over Valle (ISSUE-304)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Every sound the app makes goes through an `Audio` element (lib/audio/player.ts): counted, never played. */
  function countAudio(): { made: number } {
    const count = { made: 0 }
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          count.made += 1
        }
        play(): Promise<void> {
          return Promise.resolve()
        }
        pause(): void {}
      }
    )
    return count
  }

  it("[S28.19, US-SET-002.AC05, US-SET-002.AC08, US-SET-011.AC02] Valle's Settings page draws the app-wide rows without Position, Always on top or Hide panel", async () => {
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA] })
    await flushPromises()
    await root.get('[data-slot="settings"]').trigger('click')
    await flushPromises()
    const page = root.find('[data-valle-page="settings"] .dm-settings')
    expect(page.exists()).toBe(true)
    expect(page.text()).toContain('Panel shortcut')
    expect(page.find('.position-right').exists()).toBe(false)
    expect(page.find('.pin').exists()).toBe(false)
    await page.get('[role="tab"][data-s="About"]').trigger('click')
    expect(page.find('.hide-panel').exists()).toBe(false)
  })

  // Owner decision 2026-10-22: no playback and no audio engine in the Valle window until US-VALLE-016.
  // AMENDED for ISSUE-307 (US-VALLE-016: the Valle window now has its one engine, for the current mine): the Settings
  // rows still only write the preference; the change itself opens no clip, and the page builds no engine of its own.
  it('[S28.19, US-SET-004.AC03] a volume changed in Valle’s Settings is written as a preference and starts no playback', async () => {
    const audio = countAudio()
    const written: unknown[] = []
    const { root, player } = mountValle({ preset: 'control', mosaicOrder: [MORIA] }, undefined, {
      getAudioPreferences: () => Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES }) as never,
      setAudioPreferences: (preferences) => {
        written.push(preferences)
        return Promise.resolve(preferences) as never
      }
    })
    await flushPromises()
    await root.get('[data-slot="settings"]').trigger('click')
    await flushPromises()
    await root.get('[role="tab"][data-s="Sound"]').trigger('click')
    const opened = player.clips.length
    const music = root.get('input[aria-label="Music volume"]')
    await music.setValue('30')
    await flushPromises()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ musicVolume: 0.3 })
    // The window's one engine plays through its injected player: not one Audio element was made, and the change
    // itself opened no clip, music included.
    expect(audio.made).toBe(0)
    expect(player.clips.length).toBe(opened)
  })
})

// APPENDED for ISSUE-305: the splitter in the Valle root (07 machine 33; UC-057).
describe('the splitter in the Valle root (ISSUE-305)', () => {
  it('[US-VALLE-005.AC07, US-VALLE-005.AC04, S33.08] the root sizes its chat zone from the body, the split and the splitter, writing each commit through A-N21', async () => {
    const { root, writes } = mountValle(
      {
        preset: 'front',
        pins: [
          { dwarfId: BORIN, mineId: MORIA, order: 0 },
          { dwarfId: DAIN, mineId: EREBOR, order: 1 }
        ]
      },
      (_target, callback) => {
        callback(1600)
        return () => {}
      }
    )
    await flushPromises()
    expect(root.findAll('[role="separator"][aria-label="Resize the chats"]')).toHaveLength(1)
    const bar = root.get('[role="separator"][aria-label="Resize the chats"]')
    const aria = () => [
      bar.attributes('aria-valuenow'),
      bar.attributes('aria-valuemin'),
      bar.attributes('aria-valuemax')
    ]
    const chatWidth = () => root.get('.dm-valle__body').attributes('style')
    // No mine shown yet, so the mine's minimum is 300 px: 1600 − 56 − 12 − 18 − 232 − 6 − max(300, 400) by default.
    expect(aria()).toEqual(['876', '340', '976'])
    expect(chatWidth()).toContain('--chat-w: 876px')

    // Two chats side by side: the chat zone's minimum becomes the split's 640 px.
    await root.get('button.dm-cdeck__split').trigger('click')
    expect(aria()).toEqual(['876', '640', '976'])

    await bar.trigger('keydown', { key: 'End' })
    expect(chatWidth()).toContain('--chat-w: 976px')
    const layouts = defaultValleLayouts()
    layouts.front.split = true
    expect(writes.at(-1)).toEqual({
      key: 'valleLayout',
      value: { ...layouts, front: { ...layouts.front, chatWidth: 976 } }
    })

    // A double click puts the Work front's default back, its stored width cleared.
    await bar.trigger('dblclick')
    expect(chatWidth()).toContain('--chat-w: 876px')
    expect(writes.at(-1)).toEqual({ key: 'valleLayout', value: layouts })
  })
})

// APPENDED for TVC (a Valle package gap resolved in development, EPIC-20): the chats inside the pins and panes, the
// Panel's own MessagePanel and Add panel fed by the window's one message dock (BR-21; ADR-033 item 5).
describe("the chats inside Valle's pins and panes (TVC)", () => {
  /** Borin in Moria and Dain in Erebor, both present; `asks` adds the Host's asks section. */
  function twoDwarfs(asks?: unknown): Partial<Window['api']> {
    return {
      getHostSnapshot: () => {
        const page = snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
        })
        if (asks !== undefined && page.ok) {
          page.value.chunks.push({ section: 'asks', data: asks } as never)
        }
        return Promise.resolve(page) as never
      }
    }
  }
  const BOTH = [
    { dwarfId: BORIN, mineId: MORIA, order: 0 },
    { dwarfId: DAIN, mineId: EREBOR, order: 1 }
  ]
  const wide: ValleBodyObserver = (_target, callback) => {
    callback(1600)
    return () => {}
  }
  /** The MessagePanels on screen, by the dwarf each one shows. */
  const panels = (root: VueWrapper) =>
    root
      .findAllComponents(DwarfMessagePanel)
      .map((panel) => (panel.props('dwarf') as { id: string }).id)
  const composer = (root: VueWrapper, dwarfId: string) =>
    root.get(`[data-valle-chat="${dwarfId}"] .dm-composer textarea`)
  const typed = (root: VueWrapper, dwarfId: string): string =>
    (composer(root, dwarfId).element as HTMLTextAreaElement).value
  const line = (root: VueWrapper, key: string) => root.get(`.dm-cstack [data-pin="${key}"]`)

  it("[US-VALLE-007.AC08, US-VALLE-007.AC09, BR-21] the expanded line and the Work front's pane hold the Panel's own MessagePanel on the pinned dwarf", async () => {
    const { root, clock } = mountValle({ preset: 'control', pins: BOTH }, undefined, twoDwarfs())
    await flushPromises()
    // The expanded line holds Borin's chat, the host's direct child (its rule reaches it, ISSUE-305).
    const open = root.get('.dm-cstack__open')
    expect(open.attributes('data-pin')).toBe(BORIN)
    expect(open.find(':scope > .dm-msg').exists()).toBe(true)
    expect(panels(root)).toEqual([BORIN])
    expect(root.getComponent(DwarfMessagePanel).props('hostedIn')).toBe('valle')

    await line(root, DAIN).trigger('click')
    await flushPromises()
    expect(panels(root)).toEqual([DAIN])

    await root.get('[data-preset-tab="front"]').trigger('click')
    clock.advance(330)
    await flushPromises()
    const pane = root.get('.dm-cdeck__pane')
    expect(pane.find(':scope > .dm-msg').exists()).toBe(true)
    expect(panels(root)).toEqual([pane.attributes('data-pane')])
  })

  it('[US-VALLE-008.AC01, US-MSG-009.AC03] a split shows two conversations side by side, each its own dwarf and its own draft', async () => {
    const { root, clock } = mountValle({ preset: 'front', pins: BOTH }, wide, twoDwarfs())
    await flushPromises()
    clock.advance(330)
    await flushPromises()
    await root.get('button.dm-cdeck__split').trigger('click')
    await flushPromises()
    const panes = root.findAll('.dm-cdeck__pane').map((pane) => pane.attributes('data-pane')!)
    expect(panes).toHaveLength(2)
    expect(panels(root)).toEqual(panes)

    await composer(root, panes[0]!).setValue('first pane words')
    await composer(root, panes[1]!).setValue('second pane words')
    await flushPromises()
    expect(typed(root, panes[0]!)).toBe('first pane words')
    expect(typed(root, panes[1]!)).toBe('second pane words')
    // Back to one pane and to two again: each pane's chat takes its own draft back.
    await root.get('button.dm-cdeck__split').trigger('click')
    await root.get('button.dm-cdeck__split').trigger('click')
    await flushPromises()
    expect(typed(root, panes[0]!)).toBe('first pane words')
    expect(typed(root, panes[1]!)).toBe('second pane words')
  })

  it("[US-MSG-009.AC01, ADR-024] a pin's draft comes back after a fold, a focus move and a preset switch", async () => {
    const { root, clock } = mountValle({ preset: 'control', pins: BOTH }, undefined, twoDwarfs())
    await flushPromises()
    await composer(root, BORIN).setValue('half a thought')
    // Borin's line folds as Dain's opens: Dain's composer is empty.
    await line(root, DAIN).trigger('click')
    await flushPromises()
    expect(typed(root, DAIN)).toBe('')
    await line(root, BORIN).trigger('click')
    await flushPromises()
    expect(typed(root, BORIN)).toBe('half a thought')

    // Into the Work front (Moria, Borin's tab first) and back: the draft is still Borin's.
    await root.get('[data-preset-tab="front"]').trigger('click')
    clock.advance(330)
    await flushPromises()
    expect(typed(root, BORIN)).toBe('half a thought')
    await root.get('[data-preset-tab="control"]').trigger('click')
    clock.advance(330)
    await flushPromises()
    expect(typed(root, BORIN)).toBe('half a thought')
  })

  it('[S18.02, S29.13, US-VALLE-007.AC07] a pin whose dwarf left keeps its conversation, read-only', async () => {
    const sendDwarfText = vi.fn(() => Promise.resolve({ ok: true, value: {} }))
    const { root, push } = mountValle({ preset: 'control', pins: BOTH }, undefined, {
      ...twoDwarfs(),
      sendDwarfText: sendDwarfText as never
    })
    await flushPromises()
    push([frame(11, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'stopped' })])
    await flushPromises()
    expect(line(root, BORIN).attributes('data-pin-state')).toBe('gone')
    expect(root.get('.dm-cstack__open').attributes('data-read-only')).toBe('true')
    expect(panels(root)).toEqual([BORIN])
    expect(composer(root, BORIN).attributes('disabled')).toBeDefined()
    // Nothing it would send leaves.
    root.getComponent(DwarfMessagePanel).vm.$emit('send', { text: 'hello?', pressEnter: true })
    await flushPromises()
    expect(sendDwarfText).not.toHaveBeenCalled()
  })

  it("[S29.16, S29.17, US-VALLE-007.AC15] an Add pin holds the Panel's own Add panel aimed at its mine, its prompt kept through a fold, and its launch becomes that dwarf's chat", async () => {
    const LAUNCH = '01920000-0000-7000-8000-0000000003c1'
    const { root, push } = mountValle(
      {
        preset: 'control',
        pins: [{ dwarfId: DAIN, mineId: EREBOR, order: 0 }],
        session: {
          ...VALLE_STORE_DEFAULTS.session,
          valle: { addPins: [{ mineId: MORIA, order: 1 }] }
        }
      },
      undefined,
      {
        ...twoDwarfs(),
        listAgentProviders: () =>
          Promise.resolve({
            ok: true,
            value: [
              {
                providerId: 'claude',
                label: 'claude',
                models: [],
                permissionModes: [],
                offeredModes: [],
                installed: true,
                publicLaunch: 'enabled',
                answerChannel: 'available'
              }
            ]
          }) as never,
        launchAgent: () => Promise.resolve({ ok: true, value: { launchId: LAUNCH } }) as never,
        getJevSettings: () => Promise.resolve({ configured: false }) as never
      }
    )
    await flushPromises()
    await line(root, `add:${MORIA}`).trigger('click')
    await flushPromises()
    const open = root.get('.dm-cstack__open')
    expect(open.attributes('data-pin')).toBe(`add:${MORIA}`)
    expect(open.find(':scope > .dm-add').exists()).toBe(true)
    expect(root.getComponent(AddPanel).props('mineName')).toBe('moria')

    await root.get('.dm-add__chips button').trigger('click')
    await root.get('.dm-add__prompt textarea').setValue('dig the east gallery')
    // A fold and back: the prompt is still there.
    await line(root, DAIN).trigger('click')
    await flushPromises()
    await line(root, `add:${MORIA}`).trigger('click')
    await flushPromises()
    expect((root.get('.dm-add__prompt textarea').element as HTMLTextAreaElement).value).toBe(
      'dig the east gallery'
    )

    await root.get('button.dm-add__launch').trigger('click')
    await flushPromises()
    push([
      frame(11, 'launch.changed', {
        launch: {
          launchId: LAUNCH,
          mineId: MORIA,
          state: 'succeeded',
          wayKind: 'supplier',
          requestedAt: 1,
          dwarfId: BORIN
        }
      } as never)
    ])
    await flushPromises()
    expect(root.findAll('.dm-cstack [data-pin]').map((pin) => pin.attributes('data-pin'))).toEqual([
      DAIN,
      BORIN
    ])
    expect(root.get('.dm-cstack__open').attributes('data-pin')).toBe(BORIN)
    expect(panels(root)).toEqual([BORIN])
  })

  it('[US-ASK-003.AC07, ADR-010] a permission answered in a Valle-hosted chat goes to the Host broker once, as the Panel’s does', async () => {
    const ASK = '01920000-0000-7000-8000-0000000a5141'
    const answerDwarfPermission = vi.fn(() =>
      Promise.resolve({ ok: true, value: { kind: 'accepted' } })
    )
    const { root } = mountValle({ preset: 'control', pins: BOTH }, undefined, {
      ...twoDwarfs({
        asks: [
          {
            id: ASK,
            dwarfId: BORIN,
            kind: 'permission',
            channel: 'hook-keystroke',
            providerRequestId: 'toolu_1',
            payload: { toolName: 'Bash', requestText: 'pnpm test' },
            currentStep: 0,
            state: 'open',
            reannounce: true,
            openedAt: 1_000
          }
        ],
        needsYou: []
      }),
      answerDwarfPermission: answerDwarfPermission as never
    })
    await flushPromises()
    const card = root.get(`[data-valle-chat="${BORIN}"] .dm-qcard`)
    const allow = card.findAll('button').find((button) => button.text().includes('Allow'))
    expect(allow).toBeDefined()
    await allow!.trigger('click')
    const submit = card.findAll('button').find((button) => button.text().includes('Submit'))
    await submit!.trigger('click')
    await flushPromises()
    expect(answerDwarfPermission).toHaveBeenCalledTimes(1)
    expect(answerDwarfPermission).toHaveBeenCalledWith(
      expect.objectContaining({ askId: ASK, decision: 'allow' })
    )
  })

  it("[US-MINE-006.AC03, S31.05] a message that failed from a Valle-hosted chat is marked in a zone's history of its mine", async () => {
    const { root } = mountValle(
      { preset: 'control', pins: BOTH, mosaicOrder: [MORIA, EREBOR] },
      undefined,
      { ...twoDwarfs(), sendDwarfText: (() => Promise.reject(new Error('gone'))) as never }
    )
    await flushPromises()
    root
      .getComponent(DwarfMessagePanel)
      .vm.$emit('send', { text: 'are you there?', pressEnter: true })
    await flushPromises()
    await root.get(`[data-valle-column="${MORIA}"] [data-zone-more]`).trigger('click')
    const row = root
      .findAll('[data-zone-menu] [role="menuitem"]')
      .find((item) => item.text().startsWith('Show here: history'))
    await row!.trigger('click')
    await flushPromises()
    const failed = root.getComponent(HistoryPanel).props('failed') as Record<
      string,
      { text: string }[]
    >
    expect(failed[BORIN]?.map((send) => send.text)).toEqual(['are you there?'])
  })

  it('[US-OBS-002.AC07, S39.11] with chats hosted, an announced arrival is still said once in Valle, not twice', async () => {
    const { root, push } = mountValle({ preset: 'control', pins: BOTH }, undefined, twoDwarfs())
    await flushPromises()
    expect(panels(root)).toEqual([BORIN])
    // The window's toast queue outlives a mount: only what this arrival adds is counted.
    const startedIn = (): number =>
      root.findAll('.dm-toasts > *').filter((toast) => toast.text().includes('started in')).length
    const before = startedIn()
    push([frame(11, 'dwarf.arrived', { dwarf: dwarfWire(NALI, EREBOR), announce: true })])
    await flushPromises()
    expect(startedIn() - before).toBe(1)
  })
})

// APPENDED for ISSUE-307: the current mine and its sound in the Valle root (07 machine 35; UC-060; US-VALLE-013,
// US-VALLE-016).
describe('the current mine and its sound in the Valle root (ISSUE-307)', () => {
  const BEDS = new Set<string>(Object.values(AMBIENCE_SRC))
  const beds = (player: FakeAudioPlayer) => player.live().filter((clip) => BEDS.has(clip.src))
  const current = (root: VueWrapper): string[] =>
    root
      .findAll('[data-valle-zone][aria-current="true"]')
      .map((zone) => zone.attributes('aria-label')!)

  it("[US-VALLE-013.AC02, US-VALLE-016.AC02, S35.02] a single click on a column's painting makes its mine current, marked and heard by the window's one engine, the chat in focus unchanged", async () => {
    const { root, patches, player } = mountValle({
      preset: 'control',
      mosaicOrder: [MORIA, EREBOR]
    })
    await flushPromises()
    // Nothing picked: the first column (S35.06), marked, written for the Valle host and heard.
    expect(current(root)).toEqual(['Mine moria, current'])
    expect(patches).toContainEqual({ kind: 'current-mine', host: 'valle', mineId: MORIA })
    expect(beds(player)).toHaveLength(1)
    const before = beds(player)[0]!
    const chats = patches.filter((patch) => patch.kind === 'open-chat').length

    await root.get(`[data-valle-column="${EREBOR}"] .dm-vz__well`).trigger('click')
    expect(current(root)).toEqual(['Mine erebor, current'])
    expect(patches.at(-1)).toEqual({ kind: 'current-mine', host: 'valle', mineId: EREBOR })
    // The previous mine's bed went silent and the new one's started: one bed, so one engine in the window.
    expect(before.stopped).toBe(true)
    expect(beds(player)).toHaveLength(1)
    expect(patches.filter((patch) => patch.kind === 'open-chat')).toHaveLength(chats)
    // A press on a control in the header is that control's, not a click on the painting.
    await root.get(`[data-valle-column="${MORIA}"] [data-zone-more]`).trigger('click')
    expect(current(root)).toEqual(['Mine erebor, current'])
  })

  it('[US-VALLE-013.AC03, US-VALLE-013.AC05, US-VALLE-013.AC06, S35.03, S35.05] a dive makes its mine current, the climb keeps it, and closing its column falls back to the first column', async () => {
    const { root, clock } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).trigger('click')
    clock.advance(330)
    await flushPromises()
    expect(current(root)).toEqual(['Mine erebor, current'])
    esc()
    clock.advance(330)
    await flushPromises()
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('control')
    expect(current(root)).toEqual(['Mine erebor, current'])

    await root.get(`[data-valle-column="${EREBOR}"] [data-zone-more]`).trigger('click')
    const close = root
      .findAll('[data-zone-menu] [role="menuitem"]')
      .find((item) => item.text().startsWith('Close this column'))
    await close!.trigger('click')
    await flushPromises()
    expect(current(root)).toEqual(['Mine moria, current'])
  })

  it('[S35.08, NFR-SND-07] a hidden Valle plays nothing and keeps its current mine for its next show', async () => {
    const { root, player } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${EREBOR}"] .dm-vz__well`).trigger('click')
    expect(beds(player)).toHaveLength(1)
    const visibility = (state: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    try {
      visibility('hidden')
      await flushPromises()
      expect(player.live()).toHaveLength(0)
      visibility('visible')
      await flushPromises()
      expect(beds(player)).toHaveLength(1)
      expect(current(root)).toEqual(['Mine erebor, current'])
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('[US-VALLE-016.AC04, S35.07] a finished turn in a mine that is not current plays its cue in Valle', async () => {
    const { root, push, player } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get(`[data-valle-column="${EREBOR}"] .dm-vz__well`).trigger('click')
    // Borin works in Moria, which is not current.
    push([
      frame(11, 'turn.ended', {
        dwarfId: BORIN,
        turnKey: 't-1',
        kind: 'concluded',
        reliability: 'reliable',
        cancelledFromApp: false
      })
    ])
    await flushPromises()
    expect(player.liveOf(UI_SFX_SRC.finished)).toHaveLength(1)
  })
})

// APPENDED for ISSUE-307: the current mark hides while a dive or a climb plays, and fades back where the zone lands
// (`DS` organisms/mine-zone, `.dm-vz.is-moving > .dm-vz__body::after { opacity: 0 }`).
describe('the current mark during a dive and a climb (ISSUE-307)', () => {
  /** The live zones' current marks; the run's frozen copies in `.dm-vghosts` are read apart. */
  const marks = (root: VueWrapper): string[] =>
    root
      .findAll('.dm-valle__body [data-valle-zone][aria-current="true"] [data-current-mark]')
      .map((mark) => mark.attributes('data-moving')!)
  const ghostMarks = (root: VueWrapper): number =>
    root.findAll('.dm-vghosts [data-current-mark]').length

  it('[US-VALLE-013.AC03, S28.03, S28.12] the current mark hides while a dive or a climb plays and shows again once it settles', async () => {
    const { root, clock } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    expect(marks(root)).toEqual(['false'])
    await root.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).trigger('click')
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('diving')
    expect(marks(root)).toEqual(['true'])
    await flushPromises()
    const seenGhost = ghostMarks(root) > 0
    clock.advance(330)
    await flushPromises()
    expect(marks(root)).toEqual(['false'])
    esc()
    await flushPromises()
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('climbing')
    expect(marks(root)).toEqual(['true'])
    clock.advance(330)
    await flushPromises()
    expect(marks(root)).toEqual(['false'])
    // Hidden by opacity alone, never by moving or resizing the brackets: on the live zone while the run plays, and on
    // the frozen copies the run moves over the stage, which carry the mark as it was before.
    expect(seenGhost).toBe(true)
    const style = markSource.slice(markSource.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const selector of [
      /\.dm-vmark\[data-moving='true'\]::after/,
      /\.dm-vghosts \.dm-vmark::after/
    ]) {
      const hide = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(style)?.[1]
      expect(hide?.replace(/\s+/g, ' ').trim()).toBe('opacity: 0;')
    }
  })
})

// APPENDED for ISSUE-309: "Reset preset" in the top bar's "⋯" menu in the Valle root (07 machine 37; UC-062).
describe('Reset preset in the Valle root (ISSUE-309)', () => {
  /** Both presets changed from their defaults: a width, a split, a folded list, a zone swapped to something else. */
  const CHANGED = (): ValleStores['layout'] => ({
    control: {
      chatWidth: 520,
      split: false,
      foldedList: false,
      zones: { [MORIA]: { content: 'map' } }
    },
    front: { chatWidth: 610, split: true, foldedList: true, zone: { content: 'history' } }
  })
  const PINS = [
    { dwarfId: BORIN, mineId: MORIA, order: 0 },
    { dwarfId: DAIN, mineId: EREBOR, order: 1 }
  ]
  const pinned = (root: VueWrapper) =>
    root.findAll('[data-pin]').map((pin) => pin.attributes('data-pin'))

  /** The "⋯" pressed and Reset preset picked, then the FLIP let to end. */
  async function reset(root: VueWrapper, clock: { advance(ms: number): void }): Promise<void> {
    await root.get('[data-preset-more]').trigger('click')
    await root.get('[data-preset-menu] [role="menuitem"]').trigger('click')
    await flushPromises()
    clock.advance(200)
    await flushPromises()
  }

  it('[US-VALLE-010.AC01, US-VALLE-010.AC02, US-VALLE-010.AC03, US-VALLE-010.AC04, S37.03] resetting the Control room puts it at its defaults alone: the mosaic recomputed, the pins and the Work front as they were', async () => {
    const { root, writes, clock } = mountValle({
      preset: 'control',
      layout: CHANGED(),
      mosaicOrder: [EREBOR, MORIA],
      pins: PINS
    })
    await flushPromises()
    const stack = pinned(root)
    expect(stack).toEqual([BORIN, DAIN])
    expect(root.get('.dm-valle__body').attributes('style')).toContain('--chat-w: 520px')
    expect(writes).toEqual([])

    await reset(root, clock)

    const after = CHANGED()!
    expect(writes).toEqual([
      { key: 'valleLayout', value: { control: defaultValleLayouts().control, front: after.front } },
      // The mine with a crew in data order, not the order the person had left (Erebor first).
      { key: 'valleMosaicOrder', value: [MORIA] }
    ])
    expect(
      root.findAll('[data-valle-column]').map((column) => column.attributes('data-valle-column'))
    ).toEqual([MORIA])
    expect(root.get('.dm-valle__body').attributes('style')).toContain('--chat-w: 440px')
    // Every zone shows its mine again.
    expect(root.find('[data-zone-content]').exists()).toBe(false)
    // Pins: never written, never reordered.
    expect(writes.filter((write) => write.key === 'pins')).toEqual([])
    expect(pinned(root)).toEqual(stack)
    expect(root.get('.dm-toasts').text()).toContain('Control room is back to its preset')
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('none')
    expect(root.find('[data-preset-menu]').exists()).toBe(false)
  })

  it("[US-VALLE-010.AC01, US-VALLE-010.AC02, US-VALLE-010.AC04, S37.04] resetting the Work front unfolds the list, turns the split off and shows the mine, the Control room's layout and the pins as they were", async () => {
    const { root, writes, clock } = mountValle({
      preset: 'front',
      layout: CHANGED(),
      mosaicOrder: [MORIA],
      pins: PINS
    })
    await flushPromises()
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 44px')
    const stack = pinned(root)

    await reset(root, clock)

    const after = CHANGED()!
    expect(writes.filter((write) => write.key === 'valleLayout')).toEqual([
      { key: 'valleLayout', value: { control: after.control, front: defaultValleLayouts().front } }
    ])
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 232px')
    expect(root.find('[data-zone-content]').exists()).toBe(false)
    // The Work front keeps no mosaic: nothing of the Control room's order is written.
    expect(writes.filter((write) => write.key === 'valleMosaicOrder')).toEqual([])
    expect(writes.filter((write) => write.key === 'pins')).toEqual([])
    expect(pinned(root)).toEqual(stack)
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('front')
    expect(root.get('.dm-toasts').text()).toContain('Work front is back to its preset')
  })

  it('[S37.06] a failed layout store write still applies the defaults for the session', async () => {
    const writes: UiPreferenceWrite[] = []
    const { root, clock } = mountValle(
      { preset: 'front', layout: CHANGED(), mosaicOrder: [MORIA] },
      undefined,
      {
        setUiPreference: ((write: UiPreferenceWrite) => {
          writes.push(write)
          return write.key === 'valleLayout'
            ? Promise.reject(new Error('store down'))
            : Promise.resolve(write)
        }) as never
      }
    )
    await flushPromises()
    await reset(root, clock)
    expect(writes.filter((write) => write.key === 'valleLayout')).toHaveLength(1)
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 232px')
    expect(root.get('.dm-toasts').text()).toContain('Work front is back to its preset')
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('none')
  })

  it('[S37.01] Reset preset is not offered while a dive or a climb plays', async () => {
    const { root, clock } = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    const more = () => root.get('[data-preset-more]')
    expect(more().attributes('disabled')).toBeUndefined()
    await root.get(`[data-valle-column="${EREBOR}"] button.dm-vz__dive`).trigger('click')
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('diving')
    expect(more().attributes('disabled')).toBeDefined()
    await more().trigger('click')
    expect(root.find('[data-preset-menu]').exists()).toBe(false)
    clock.advance(330)
    await flushPromises()
    expect(more().attributes('disabled')).toBeUndefined()
    // Climbing: the same.
    esc()
    await flushPromises()
    expect(root.get('[data-valle-root]').attributes('data-motion')).toBe('climbing')
    expect(more().attributes('disabled')).toBeDefined()
  })

  it('[S37.02, NFR-A11Y-02] Esc closes the menu first and the Work front stays; a second Esc climbs out', async () => {
    const { root, writes } = mountValle({ preset: 'front', mosaicOrder: [MORIA] })
    await flushPromises()
    const before = writes.length
    await root.get('[data-preset-more]').trigger('click')
    expect(root.find('[data-preset-menu]').exists()).toBe(true)
    esc()
    await flushPromises()
    expect(root.find('[data-preset-menu]').exists()).toBe(false)
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('front')
    expect(writes.length).toBe(before)
    esc()
    await flushPromises()
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('control')
  })
})

// APPENDED for ISSUE-306: the needs-you counter and queue in the Valle root (07 machine 34; UC-059).
describe('the needs-you counter and queue in the Valle root (ISSUE-306)', () => {
  const ask = (id: string, dwarfId: string, kind: 'question' | 'permission', openedAt: number) => ({
    id,
    dwarfId,
    kind,
    channel: 'driver',
    providerRequestId: `request-${id}`,
    payload:
      kind === 'question'
        ? { steps: [{ text: 'Which one?', options: ['a', 'b'], allowsFreeText: true }] }
        : { toolName: 'Bash', requestText: 'run a command' },
    currentStep: 0,
    state: 'open',
    reannounce: false,
    openedAt
  })
  /** MORIA's BORIN asks for a permission, EREBOR's DAIN has a question; the Host's queue: DAIN first. */
  const snapshot = () => {
    const page = snapshotPage(10, {
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { needsYou: true, status: 'asking', askedAt: 2 }),
        dwarfWire(DAIN, EREBOR, { needsYou: true, status: 'asking', askedAt: 1 })
      ]
    })
    if (!page.ok) throw new Error('fixture')
    return {
      ...page,
      value: {
        ...page.value,
        chunks: [
          ...page.value.chunks,
          {
            section: 'asks',
            data: {
              asks: [
                ask('01920000-0000-7000-8000-00000000e001', DAIN, 'question', 1),
                ask('01920000-0000-7000-8000-00000000e002', BORIN, 'permission', 2)
              ],
              needsYou: [
                { dwarfId: DAIN, mineId: EREBOR, askedAt: 1 },
                { dwarfId: BORIN, mineId: MORIA, askedAt: 2 }
              ]
            }
          }
        ]
      }
    }
  }
  const labels = (root: VueWrapper): string[] =>
    root.findAll('.dm-vq__entry').map((entry) => entry.attributes('aria-label') ?? '')

  it('[US-VALLE-004.AC01, US-VALLE-004.AC06, US-VALLE-012.AC02, S34.05, S34.06, S34.07] in the Valle root the counter and an entry pin and focus the dwarf’s chat, add its column or swap to its mine, and never write the preset', async () => {
    const { root, writes, clock } = mountValle(
      { preset: 'control', mosaicOrder: [MORIA], pins: [], lastFrontMineId: EREBOR },
      undefined,
      { getHostSnapshot: () => Promise.resolve(snapshot()) as never }
    )
    await flushPromises()
    const valle = root.get('[data-valle-root]')
    const counter = root.get('[data-needs-counter]')
    expect(counter.text()).toContain('2 need you')
    expect(counter.attributes('aria-label')).toBe('2 waiting on you. Jump to the next one')
    const both = ['dain has a question in erebor', 'borin asks for a permission in moria']
    expect(labels(root)).toEqual(both)

    // The Control room: the oldest, DAIN, whose mine is not in the mosaic.
    await counter.trigger('click')
    await flushPromises()
    expect(writes).toContainEqual({ key: 'valleMosaicOrder', value: [MORIA, EREBOR] })
    expect(root.get('.dm-cstack__open').attributes('data-pin')).toBe(DAIN)
    const zone = root.get(`[data-valle-column="${EREBOR}"]`)
    expect(zone.attributes('data-current')).toBe('true')
    expect(zone.attributes('data-needs')).toBe('true')
    expect(zone.find('.dm-vz__ring.is-called').exists()).toBe(true)
    expect(root.get(`[data-valle-column="${MORIA}"]`).find('.dm-vz__ring.is-called').exists()).toBe(
      false
    )
    expect(valle.attributes('data-preset')).toBe('control')
    expect(writes.filter((write) => write.key === 'vallePreset')).toEqual([])

    // The Work front, on EREBOR: the same count and the same queue (AC06).
    await root.get('[data-preset-tab="front"]').trigger('click')
    clock.advance(400)
    await flushPromises()
    expect(valle.attributes('data-motion')).toBe('none')
    expect(root.get('[data-needs-counter]').text()).toContain('2 need you')
    expect(labels(root)).toEqual(both)
    const presetWrites = writes.filter((write) => write.key === 'vallePreset').length

    // BORIN's entry: a swap to MORIA, then BORIN's tab; the preset stays the Work front.
    await root.get(`.dm-vq__entry[data-id="${BORIN}"]`).trigger('click')
    clock.advance(400)
    await flushPromises()
    expect(valle.attributes('data-preset')).toBe('front')
    expect(writes).toContainEqual({ key: 'valleLastFrontMineId', value: MORIA })
    expect(root.find(`[data-valle-front-mine="${MORIA}"]`).exists()).toBe(true)
    expect(root.get('.dm-ctab.is-focus-pane').attributes('data-pin')).toBe(BORIN)
    expect(writes.filter((write) => write.key === 'vallePreset')).toHaveLength(presetWrites)
  })
})

// APPENDED for ISSUE-311: Valle's part in a mode run (07 machine 9, S28.21, S29.23), the reveal of a notification click
// (S39.06, S39.07) and the reduced-motion stand-ins (US-SHELL-011).
describe('Valle in the mode lever, the reveal and reduced motion (ISSUE-311)', () => {
  const BOTH = [
    { dwarfId: BORIN, mineId: MORIA, order: 0 },
    { dwarfId: DAIN, mineId: EREBOR, order: 1 }
  ]
  /** Borin in Moria and Dain in Erebor, both present. */
  const twoDwarfs = (): Partial<Window['api']> => ({
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
        })
      ) as never
  })
  const composer = (root: VueWrapper, dwarfId: string) =>
    root.get(`[data-valle-chat="${dwarfId}"] .dm-composer textarea`)

  it("[US-SHELL-001.AC05] in Valle the nav draws no mode lever and no app mark, and Valle's top bar carries ▼ Panel and ▼ Veta", async () => {
    const { root, moves } = mountValle({ preset: 'control' })
    await flushPromises()
    const nav = root.get('nav.dm-valle__nav')
    // The nav holds its page slots alone: no lever, no MODE label, no app mark, not even a disabled one.
    expect(nav.findAll('.dm-slot').map((slot) => slot.attributes('data-label'))).toEqual([
      'Map',
      'Mines',
      'Settings'
    ])
    expect(nav.find('[aria-label="Mode"]').exists()).toBe(false)
    expect(nav.find('.dm-nav__mark').exists()).toBe(false)
    expect(nav.text()).not.toContain('MODE')
    expect(root.findAll('.dm-nav__mark, .dm-nav__lever')).toHaveLength(0)
    // The top bar carries the mode controls: "▼ Panel" and "▼ Veta", each a move through the ModeCoordinator.
    const bar = root.get('header.dm-vbar [aria-label="Mode"]')
    expect(bar.findAll('button').map((button) => button.text())).toEqual(['▼ Panel', '▼ Veta'])
    await bar.get('[data-lever="veta"]').trigger('click')
    await flushPromises()
    expect(moves).toEqual([{ mode: 'veta' }])
  })

  it('[S9.01, S28.21] ▼ Panel from Valle hands the chat in focus over with its draft, never another pin’s', async () => {
    // The Valle window's part of every run, over this case's `window.api`, as main.ts starts it.
    modeTransitionPart().dispose()
    let heard: ((t: ModeTransition) => void) | null = null
    try {
      const { root, moves, patches } = mountValle({ preset: 'control', pins: BOTH }, undefined, {
        ...twoDwarfs(),
        onModeTransition: (h) => {
          heard = h as (t: ModeTransition) => void
          return () => (heard = null)
        }
      })
      modeTransitionPart()
      await flushPromises()
      await composer(root, BORIN).setValue('leaving words')
      await root.get(`.dm-cstack [data-pin="${DAIN}"]`).trigger('click')
      await flushPromises()
      await composer(root, DAIN).setValue('dain words')
      await root.get(`.dm-cstack [data-pin="${BORIN}"]`).trigger('click')
      await flushPromises()

      await root.get('[data-lever="panel"]').trigger('click')
      await flushPromises()
      expect(moves).toEqual([{ mode: 'panel', mineId: MORIA, dwarfId: BORIN }])
      heard!({
        transitionId: 'run-out',
        from: 'valle',
        to: 'panel',
        t0: Date.now(),
        role: 'source',
        chat: { dwarfId: BORIN, mineId: MORIA }
      })
      // The chat in focus hands its draft and its view over before t0 (S9.01); Dain's, folded in the stack, does not.
      expect(patches.filter((patch) => patch.kind === 'draft')).toEqual([
        { kind: 'draft', dwarfId: BORIN, text: 'leaving words' }
      ])
      expect(patches.filter((patch) => patch.kind === 'chat-view').map((p) => p.dwarfId)).toEqual([
        BORIN
      ])
    } finally {
      modeTransitionPart().dispose()
    }
  })
})

// APPENDED for ISSUE-311: the reveal wired to the Valle root (A-N16; 07 S39.06, S39.07, S10.10).
describe('the reveal of a notification click in the Valle root (ISSUE-311)', () => {
  it('[S39.06, S10.10] a notification click while Valle is shown pins the dwarf’s chat with its column added, its mine current, and changes neither the preset nor the mode', async () => {
    let reveal: ((t: { mineId: string; dwarfId: string | null }) => void) | null = null
    const { root, writes, moves } = mountValle(
      { preset: 'control', mosaicOrder: [MORIA], pins: [] },
      undefined,
      {
        getHostSnapshot: () =>
          Promise.resolve(
            snapshotPage(10, {
              minesEverKnown: true,
              mines: [mineWire(MORIA), mineWire(EREBOR)],
              dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
            })
          ) as never,
        onRevealDwarfChat: (listener) => {
          reveal = listener as typeof reveal
          return () => (reveal = null)
        }
      }
    )
    await flushPromises()
    // A page over the main zone gives way to the mines first (S28.20).
    await root.get('[data-slot="settings"]').trigger('click')
    expect(reveal, 'the Valle window hears A-N16').not.toBeNull()
    reveal!({ mineId: EREBOR, dwarfId: DAIN })
    await flushPromises()
    const valle = root.get('[data-valle-root]')
    expect(valle.attributes('data-page')).toBe('mines')
    expect(writes).toContainEqual({ key: 'valleMosaicOrder', value: [MORIA, EREBOR] })
    expect(root.get('.dm-cstack__open').attributes('data-pin')).toBe(DAIN)
    expect(root.get(`[data-valle-column="${EREBOR}"]`).attributes('data-current')).toBe('true')
    // Never the preset, never the mode (S10.10; ADR-025 item 8).
    expect(valle.attributes('data-preset')).toBe('control')
    expect(writes.filter((write) => write.key === 'vallePreset')).toEqual([])
    expect(moves).toEqual([])

    // A dwarf that left: the mine alone, no chat (S39.07).
    reveal!({ mineId: MORIA, dwarfId: null })
    await flushPromises()
    expect(root.get('.dm-cstack__open').attributes('data-pin')).toBe(DAIN)
    expect(root.get(`[data-valle-column="${MORIA}"]`).attributes('data-current')).toBe('true')
  })
})

// APPENDED for ISSUE-311: the reduced-motion stand-ins in Valle (US-SHELL-011 rows 5 and 6; NFR-A11Y-10; `DS/docs/
// motion.md` Reduced motion), read from a fake `matchMedia` (17 §1.12).
describe('the reduced-motion stand-ins in the Valle root (ISSUE-311)', () => {
  const realMatchMedia = window.matchMedia
  const reduceMotion = (): void => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    })) as unknown as typeof window.matchMedia
  }
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })
  /** MORIA's BORIN and EREBOR's DAIN both wait on the person; the Host's queue: DAIN first. */
  const waiting = () => {
    const page = snapshotPage(10, {
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { needsYou: true, status: 'asking', askedAt: 2 }),
        dwarfWire(DAIN, EREBOR, { needsYou: true, status: 'asking', askedAt: 1 })
      ]
    })
    if (!page.ok) throw new Error('fixture')
    page.value.chunks.push({
      section: 'asks',
      data: {
        asks: [],
        needsYou: [
          { dwarfId: DAIN, mineId: EREBOR, askedAt: 1 },
          { dwarfId: BORIN, mineId: MORIA, askedAt: 2 }
        ]
      }
    } as never)
    return page
  }

  it("[US-SHELL-011.AC05, NFR-A11Y-10] the need-you mark stops moving and a called zone's ring is not drawn", async () => {
    reduceMotion()
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA], pins: [] }, undefined, {
      getHostSnapshot: () => Promise.resolve(waiting()) as never
    })
    await flushPromises()
    const counter = root.get('[data-needs-counter]')
    // The "?" is still drawn, and held still: the bob is off (`.dm-vbar__q`'s animation, as the design's own rule).
    expect(counter.find('.dm-vbar__q').exists()).toBe(true)
    expect(counter.attributes('data-still')).toBe('true')
    expect(counterSource).toMatch(
      /\.dm-vbar__needs\[data-still='true'\] \.dm-vbar__q \{\s*animation: none;\s*\}/
    )
    // A jump calls EREBOR's zone: its needs-you outline stays, the call ring is not drawn at all.
    await counter.trigger('click')
    await flushPromises()
    const zone = root.get(`[data-valle-column="${EREBOR}"]`)
    expect(zone.attributes('data-needs')).toBe('true')
    expect(zone.find('.dm-vz__ring').exists()).toBe(true)
    expect(root.findAll('.dm-vz__ring.is-called')).toHaveLength(0)
  })

  it('[US-SHELL-011.AC06, NFR-TIM-02] a scroll to a zone jumps instead of animating', async () => {
    reduceMotion()
    const scrolls: ScrollToOptions[] = []
    const patches: UiSessionPatch[] = []
    let reveal: ((t: { mineId: string; dwarfId: string | null }) => void) | null = null
    const { root } = mountValle(
      { preset: 'control', mosaicOrder: [MORIA, EREBOR], pins: [] },
      undefined,
      {
        ...{
          getHostSnapshot: () =>
            Promise.resolve(
              snapshotPage(10, {
                minesEverKnown: true,
                mines: [mineWire(MORIA), mineWire(EREBOR)],
                dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
              })
            ) as never
        },
        patchUiSession: (patch) => void patches.push(patch as UiSessionPatch),
        onRevealDwarfChat: (listener) => {
          reveal = listener as typeof reveal
          return () => (reveal = null)
        }
      }
    )
    await flushPromises()
    // jsdom lays nothing out: the mosaic is given a 600 px viewport, EREBOR's zone [600, 900] past its right edge.
    const mosaic = root.get('[data-valle-mosaic]').element as HTMLElement
    Object.defineProperty(mosaic, 'clientWidth', { configurable: true, value: 600 })
    mosaic.getBoundingClientRect = () => ({ left: 0, width: 600 }) as DOMRect
    mosaic.scrollTo = ((options: ScrollToOptions) => void scrolls.push(options)) as never
    const zone = root.get(`[data-valle-column="${EREBOR}"]`).element as HTMLElement
    zone.getBoundingClientRect = () => ({ left: 600, width: 300 }) as DOMRect

    reveal!({ mineId: EREBOR, dwarfId: DAIN })
    await flushPromises()
    // The scroll lands at once: no smooth scroll under reduced motion; the saved scroll follows it.
    expect(scrolls).toEqual([{ left: 300, behavior: 'auto' }])
    expect(patches).toContainEqual({ kind: 'valle', patch: { mosaicScrollLeft: 300 } })
  })
})
