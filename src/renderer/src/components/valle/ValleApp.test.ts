// @vitest-environment jsdom
import type { MoveToModeParams, UiPreferenceWrite, UiSessionPatch } from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
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
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
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
  bodyObserver: ValleBodyObserver = () => () => {}
) {
  const writes: UiPreferenceWrite[] = []
  const moves: MoveToModeParams[] = []
  const patches: UiSessionPatch[] = []
  const clock = manualClock()
  const api = createFakeWindowApi({
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
    }
  })
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
  return { root, writes, moves, patches, clock }
}

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
    expect(writes).toEqual([{ key: 'vallePreset', value: 'control' }])
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
    expect(writes).toEqual([
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
    expect(writes).toEqual([split(true), split(false)])
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
