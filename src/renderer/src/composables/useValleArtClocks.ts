/*
 * Each Valle zone's own sprite clock (an EPIC-20 package gap resolved in development; ADR-034 item 5 and Reuse;
 * S-034-1; NFR-PERF-10): every zone showing its mine draws the Panel's interior and crew on a frame clock of its own,
 * and a zone with none of it inside the viewport holds that clock still, its crew on the frame it shows, until any of
 * it is back in view. Every zone stays in the DOM (no virtualization). ISSUE-298 measured this degradation fluid at 16
 * columns.
 *
 * - One observer over the viewport for every zone's art (the window's `IntersectionObserver`, injected as the presence
 *   one is). The platform counts a box that only touches a clipping edge as intersecting with a ratio of 0, so a zone
 *   runs on any ratio above 0, and the second threshold makes a sliver coming into view report.
 * - A hidden window holds every clock still by itself (`frameClock.ts`, the document's visibility).
 */
import { getCurrentScope, onScopeDispose, type InjectionKey } from 'vue'
import {
  browserFrameClockEnv,
  createFrameClock,
  type PausableFrameClock
} from '../lib/sprite/frameClock'
import type { VallePresenceDeps } from './useVallePresence'

/** The two thresholds that report a zone leaving the viewport and any sliver of it coming back. */
export const ART_IN_VIEW_THRESHOLDS: readonly number[] = [0, 0.001]

export interface ValleArtClocksDeps {
  /** Builds the one observer over the Valle viewport (the presence's factory). */
  observer: VallePresenceDeps['observer']
  /** A new clock for one zone; the window's own frames unless a test hands one. */
  clock?: () => PausableFrameClock
}

export interface ValleArtClocks {
  /** A new clock for one zone's art. */
  clock(): PausableFrameClock
  /**
   * Runs `clock` while any of `element` lies in the viewport; `onRun` hears each change. Answers the release, which
   * stops watching (the clock itself is its zone's to dispose).
   */
  watch(element: Element, clock: PausableFrameClock, onRun: (runs: boolean) => void): () => void
}

/** How the zones reach the window's art clocks (`ValleMineArt`): absent, a zone runs a clock of its own. */
export const VALLE_ART_CLOCKS: InjectionKey<ValleArtClocks> = Symbol('valle-art-clocks')

export const browserArtClock = (): PausableFrameClock => createFrameClock(browserFrameClockEnv())

export function useValleArtClocks(deps: ValleArtClocksDeps): ValleArtClocks {
  const zones = new Map<Element, { clock: PausableFrameClock; onRun(runs: boolean): void }>()
  const observer = deps.observer(
    (entries) => {
      for (const { target, intersectionRatio } of entries) {
        const zone = zones.get(target)
        if (zone === undefined) continue
        const runs = intersectionRatio > 0
        if (runs) zone.clock.resume()
        else zone.clock.pause()
        zone.onRun(runs)
      }
    },
    { threshold: [...ART_IN_VIEW_THRESHOLDS] }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => observer.disconnect())
  return {
    clock: deps.clock ?? browserArtClock,
    watch(element, clock, onRun) {
      zones.set(element, { clock, onRun })
      observer.observe(element)
      return () => {
        observer.unobserve(element)
        zones.delete(element)
      }
    }
  }
}
