import type { DwarfId, UiSessionPatch } from '@dwarfai/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, shallowRef, type EffectScope } from 'vue'
import { NO_PINS, pinViews, stepPins, type PinInput, type PinSet } from '../lib/valle/pins'
import { pinFacts } from '../lib/valle/testing/pinHarness'
import { BORIN, DAIN, EREBOR, MORIA, NALI } from '../lib/veta/testing/vetaFixtures'
import { useValleSplit, type ValleSplitDeps } from './useValleSplit'
import { VALLE_STORE_DEFAULTS, type ValleStores } from './useValleStores'

/*
 * The Work front's split wired to the window (ISSUE-303; 07 machine 30; UC-056; NFR-PERF-09; 17 §1.11): the room is
 * measured by a `ResizeObserver` on Valle's body and recomputed on its events alone, never on a timer; the wish goes
 * through A-N21 with the Work front layout, the second pane through A-N18. The observer is a hand-written fake that
 * delivers the body's width when the test resizes it; the pin set is stepped by machine 29 itself.
 * TC-303-02: a resize crossing 640 px suspends or restores the split on that event alone, with no timer.
 */

/** A body width whose room is exactly 640 px with no portrait and the list unfolded (07 machine 30). */
const WIDE = 640 + 56 + 12 + 18 + 232 + 6 + 300

let scope: EffectScope | undefined
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  scope?.stop()
  scope = undefined
  vi.useRealTimers()
})

function setOf(...inputs: PinInput[]): PinSet {
  let set = NO_PINS
  for (const input of inputs) {
    const step = stepPins(set, input)
    if (!step.ok) throw new Error(JSON.stringify(input))
    set = step.set
  }
  return set
}

/** BORIN, DAIN (asking), NALI pinned; BORIN in focus. */
const three = (): PinSet =>
  setOf(
    { kind: 'click', dwarfId: BORIN, mineId: MORIA },
    { kind: 'click', dwarfId: DAIN, mineId: EREBOR },
    { kind: 'click', dwarfId: NALI, mineId: MORIA },
    { kind: 'select', key: BORIN }
  )

function harness(options: { wish?: boolean; remembered?: DwarfId | null; initial?: PinSet } = {}) {
  const set = shallowRef(options.initial ?? three())
  const facts = pinFacts({
    [BORIN]: { name: 'borin', status: 'working' },
    [DAIN]: { name: 'dain', status: 'asking', ask: 'question' },
    [NALI]: { name: 'nali', status: 'idle' }
  })
  const pins = {
    set,
    views: computed(() => pinViews(set.value, facts)),
    send(input: PinInput): boolean {
      const step = stepPins(set.value, input)
      if (!step.ok) return false
      set.value = step.set
      return true
    }
  }
  const patches: UiSessionPatch[] = []
  const wishes: boolean[] = []
  let wish = options.wish ?? false
  let resized: ((width: number) => void) | null = null
  let observed = 0
  const stores = shallowRef<ValleStores>({
    ...VALLE_STORE_DEFAULTS,
    session: {
      ...VALLE_STORE_DEFAULTS.session,
      valle: { secondPaneDwarfId: options.remembered ?? null }
    }
  })
  const factsRead = shallowRef(true)
  const body = shallowRef<HTMLElement | null>({} as HTMLElement)
  const deps: ValleSplitDeps = {
    bridge: { patchUiSession: (patch) => patches.push(patch) },
    pins,
    stores,
    factsRead,
    body,
    wish: () => wish,
    writeWish: (split) => {
      wish = split
      wishes.push(split)
    },
    foldedList: () => false,
    portraits: () => 0,
    observe: (_target, callback) => {
      observed += 1
      resized = callback
      return () => {
        resized = null
      }
    }
  }
  scope = effectScope()
  const split = scope.run(() => useValleSplit(deps))!
  return {
    split,
    pins,
    patches,
    wishes,
    stores,
    observed: () => observed,
    async resize(width: number): Promise<void> {
      if (resized === null) throw new Error('no observer')
      resized(width)
      await nextTick()
    }
  }
}

describe('the Work front split in use (ISSUE-303)', () => {
  it('[NFR-PERF-09] split availability is recomputed on a resize event and never by polling', async () => {
    const h = harness()
    await nextTick()
    expect(h.observed()).toBe(1)
    await h.resize(WIDE)
    expect(h.split.button.value).toEqual({
      disabled: false,
      pressed: false,
      title: 'Split · two chats side by side'
    })
    h.split.press()
    await nextTick()
    expect(h.split.panes.value).toEqual([BORIN, DAIN])
    // No timer is ever armed: the room changes only when the observer reports a new width.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(h.split.panes.value).toEqual([BORIN, DAIN])

    await h.resize(WIDE - 1)
    expect(h.split.set.value.state).toBe('suspended')
    expect(h.split.panes.value).toEqual([BORIN])
    expect(h.split.button.value).toEqual({
      disabled: true,
      pressed: true,
      title: 'Split · needs a wider window'
    })
    vi.advanceTimersByTime(60_000)
    expect(h.split.set.value.state).toBe('suspended')

    await h.resize(WIDE)
    expect(h.split.set.value.state).toBe('on')
    expect(h.split.panes.value).toEqual([BORIN, DAIN])
    expect(vi.getTimerCount()).toBe(0)
    // The wish was written once, on the press; the session heard the second pane once.
    expect(h.wishes).toEqual([true])
    expect(h.patches).toEqual([{ kind: 'valle', patch: { secondPaneDwarfId: DAIN } }])
  })

  it('[S30.13, S30.08, S30.09, S30.10, S30.12] the wish restores against the first measured room, tabs and panes move focus, an unpin refills, Reset metrics turns it off', async () => {
    const h = harness({ wish: true, remembered: NALI })
    await nextTick()
    // Nothing is shown split before the body was measured.
    expect(h.split.panes.value).toEqual([BORIN])
    await h.resize(WIDE)
    expect(h.split.panes.value).toEqual([BORIN, NALI])

    // S30.09: the other pane's tab selected: focus moves there, both chats kept.
    h.split.sendPin({ kind: 'select', key: NALI })
    expect(h.split.panes.value).toEqual([BORIN, NALI])
    expect(h.split.set.value.pane).toBe(1)
    // S30.08: a tab not shown replaces the focused pane.
    h.split.sendPin({ kind: 'select', key: DAIN })
    expect(h.split.panes.value).toEqual([BORIN, DAIN])
    expect(h.patches.at(-1)).toEqual({ kind: 'valle', patch: { secondPaneDwarfId: DAIN } })

    // S30.10: the unfocused pane's chat unpinned: the next tab after the focused one takes it.
    h.split.sendPin({ kind: 'unpin', key: BORIN })
    expect(h.pins.set.value.pins.map((pin) => pin.key)).toEqual([DAIN, NALI])
    expect(h.split.panes.value).toEqual([NALI, DAIN])
    // Fewer than two left: off, and the wish written off.
    h.split.sendPin({ kind: 'unpin', key: NALI })
    expect(h.split.set.value.state).toBe('off')
    expect(h.wishes).toEqual([false])

    // S30.12: after Reset metrics the split is off whatever it was.
    h.pins.send({ kind: 'click', dwarfId: BORIN, mineId: MORIA })
    h.split.press()
    expect(h.split.set.value.state).toBe('on')
    h.stores.value = { ...h.stores.value }
    await nextTick()
    expect(h.split.set.value.state).toBe('off')
  })
})
