// @vitest-environment jsdom
import { VALLE_ON_SCREEN_RATIO, type MineId, type ZoneContent } from '@dwarfai/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import {
  VALLE_PRESENCE_DEBOUNCE_MS,
  useVallePresence,
  type ValleObserver
} from './useVallePresence'

/**
 * Valle's on-screen report (07 S39.04, S39.05; 14 A-44 `reportVisibleMines`; ADR-024 item 7; INV-119): the mines whose
 * zone shows the mine and lies at least `VALLE_ON_SCREEN_RATIO` inside the Valle viewport, nothing while hidden or with
 * a page over the main zone. The IntersectionObserver is a hand-written fake the test drives.
 */
const A = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a0a' as MineId
const B = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a0b' as MineId
const C = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a0c' as MineId

class FakeObserver implements ValleObserver {
  static last: FakeObserver | null = null
  readonly observed = new Set<Element>()
  constructor(
    readonly callback: (entries: { target: Element; intersectionRatio: number }[]) => void,
    readonly options: { threshold: number[] }
  ) {
    FakeObserver.last = this
  }
  observe(element: Element): void {
    this.observed.add(element)
  }
  unobserve(element: Element): void {
    this.observed.delete(element)
  }
  disconnect(): void {
    this.observed.clear()
  }
  /** The share of each element inside the viewport, as the browser would report it. */
  fire(ratios: [Element, number][]): void {
    this.callback(ratios.map(([target, intersectionRatio]) => ({ target, intersectionRatio })))
  }
}

function world() {
  const reports: MineId[][] = []
  const facts = reactive({ shown: true, pageOverMain: false })
  const scope = effectScope()
  const presence = scope.run(() =>
    useVallePresence({
      bridge: { reportVisibleMines: (r) => reports.push(r.mineIds) },
      facts: () => facts,
      observer: (callback, options) => new FakeObserver(callback, options)
    })
  )!
  const zone = (mineId: MineId, content: ZoneContent) => {
    const element = document.createElement('section')
    const state = reactive({ mineId, content })
    presence.track(element, () => state)
    return { element, state }
  }
  const settle = async (): Promise<void> => {
    await nextTick()
    vi.advanceTimersByTime(VALLE_PRESENCE_DEBOUNCE_MS)
  }
  return { reports, facts, presence, zone, settle, scope, observer: () => FakeObserver.last! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Valle on screen (07 S39.04, S39.05; ISSUE-299)', () => {
  it('[S39.05, INV-119, ADR-024] only zones showing their mine and at least half inside the viewport are reported; 49 % is not on screen and 50 % is', async () => {
    const w = world()
    expect(VALLE_ON_SCREEN_RATIO).toBe(0.5)
    expect(w.observer().options.threshold).toContain(VALLE_ON_SCREEN_RATIO)
    const a = w.zone(A, 'mine')
    const b = w.zone(B, 'mine')
    const c = w.zone(C, 'map')
    // A whole, B 49 % inside, C whole but showing the map: only A.
    w.observer().fire([
      [a.element, 1],
      [b.element, 0.49],
      [c.element, 1]
    ])
    await w.settle()
    expect(w.reports.at(-1)).toEqual([A])
    // B scrolled to exactly half inside: on screen.
    w.observer().fire([[b.element, 0.5]])
    await w.settle()
    expect(w.reports.at(-1)).toEqual([A, B])
    // C's zone swapped back to its mine (a zone content swap is a viewport change, S39.05).
    c.state.content = 'mine'
    await w.settle()
    expect(w.reports.at(-1)).toEqual([A, B, C])
    // A run of changes sends once, the last; an unchanged set is not sent again.
    const sent = w.reports.length
    w.observer().fire([[a.element, 0.2]])
    w.observer().fire([[a.element, 0.9]])
    await w.settle()
    expect(w.reports).toHaveLength(sent)
    w.scope.stop()
  })

  it('[S39.04, S39.05] hidden, or with a page over the main zone, Valle reports no mine', async () => {
    const w = world()
    const a = w.zone(A, 'mine')
    w.observer().fire([[a.element, 1]])
    await w.settle()
    expect(w.reports.at(-1)).toEqual([A])
    // A nav page over the main zone hides every mine (§24 I-36).
    w.facts.pageOverMain = true
    await w.settle()
    expect(w.reports.at(-1)).toEqual([])
    w.facts.pageOverMain = false
    await w.settle()
    expect(w.reports.at(-1)).toEqual([A])
    // Hidden (S39.04): the PresenceTracker unions only the shown window, and this one says so.
    w.facts.shown = false
    await w.settle()
    expect(w.reports.at(-1)).toEqual([])
    w.scope.stop()
  })
})
