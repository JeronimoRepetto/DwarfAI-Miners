// @vitest-environment jsdom
import type {
  HostFrame,
  MoveToModeParams,
  UiPreferenceWrite,
  UiSessionPatch
} from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
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
  dwarfWire,
  frame,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import { DEFAULT_AUDIO_PREFERENCES, type ProjectSummary } from '../../types'
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
  root = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: { ...VALLE_STORE_DEFAULTS, ...stores },
      observer: () => new InertObserver(),
      // jsdom has no ResizeObserver: unless a test measures the body, it never is, and the split stays off.
      bodyObserver,
      clock
    }
  })
  /** A-N02: one batch of Host frames, to every listener. */
  const push = (frames: HostFrame[]): void => hostListeners.forEach((listener) => listener(frames))
  return { root, writes, moves, patches, clock, push }
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
      expect(root.get(`[data-valle-front-mine="${EREBOR}"]`).attributes('aria-label')).toBe(
        'Mine erebor'
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
    push([frame(11, 'dwarf.arrived', { dwarf: dwarfWire(DAIN, EREBOR), announce: true })])
    await flushPromises()
    const said = root
      .findAll('.dm-toasts > *')
      .filter((toast) => toast.text().includes('started in'))
    expect(said).toHaveLength(1)
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
  it('[S28.19, US-SET-004.AC03] a volume changed in Valle’s Settings is written as a preference and starts no playback', async () => {
    const audio = countAudio()
    const written: unknown[] = []
    const { root } = mountValle({ preset: 'control', mosaicOrder: [MORIA] }, undefined, {
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
    const music = root.get('input[aria-label="Music volume"]')
    await music.setValue('30')
    await flushPromises()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ musicVolume: 0.3 })
    // No engine in the Valle window: not one Audio element was made, so nothing could play.
    expect(audio.made).toBe(0)
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
