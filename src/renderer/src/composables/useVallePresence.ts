/*
 * Valle's on-screen report (07 S39.04, S39.05; 14 A-44 `reportVisibleMines`; ADR-024 item 7; INV-119; ISSUE-299): the
 * mines whose zone shows `mine` and lies at least `VALLE_ON_SCREEN_RATIO` inside the Valle viewport, for UI main's
 * `PresenceTracker`, the one place "on screen" is computed. The Work front's one zone is its one mine; a page over the
 * main zone hides every mine (§24 I-36); a hidden Valle reports none (S39.04). A mine scrolled out of view is not on
 * screen, so level 3 may fire for it.
 *
 * Each zone registers its element and what it shows (`track`); one IntersectionObserver over the viewport says how much
 * of each lies inside it. The report is sent each time the set changes (a mosaic scroll, a resize, a preset switch, a
 * zone content swap, a column added or closed, a page over the main zone), debounced 100 ms, so a run of changes sends
 * once, the last; an unchanged set is not sent again.
 *
 * The bridge, the facts and the observer are injected (the house idiom over `vi.mock`); the timer is the window's own.
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue'

/**
 * 14 §3.9 (pending design, DG-25): a mine zone counts as on screen when it intersects the Valle viewport by at least this
 * share (07 S39.05).
 */
export const VALLE_ON_SCREEN_RATIO = 0.5
/** S39.05's debounce, as Veta's (S20.18). */
export const VALLE_PRESENCE_DEBOUNCE_MS = 100

/** The members of an IntersectionObserver the report uses. */
export interface ValleObserver {
  observe(element: Element): void
  unobserve(element: Element): void
  disconnect(): void
}

/** What a zone shows, and for which mine (14 §3.9 `ZoneContent`). */
export interface ValleZone {
  readonly mineId: MineId
  readonly content: ZoneContent
}

/** What the report is read from besides the zones. */
export interface VallePresenceFacts {
  /** Whether Valle is the shown mode window. */
  readonly shown: boolean
  /** A nav page (Map, Mines, a mine's history) covers the main zone. */
  readonly pageOverMain: boolean
}

export interface VallePresenceDeps {
  /** The seam A member this composable uses (14 A-44). */
  bridge: { reportVisibleMines(request: { mineIds: MineId[] }): void }
  facts(): VallePresenceFacts
  /** Builds the one observer over the Valle viewport. */
  observer(
    callback: (entries: { target: Element; intersectionRatio: number }[]) => void,
    options: { threshold: number[] }
  ): ValleObserver
}

export interface VallePresence {
  /** A zone drawn: its element, and what it shows now. Answers its removal. */
  track(element: Element, zone: () => ValleZone): () => void
  /** The mines on screen now (S39.05), as the next report will send them. */
  onScreen(): MineId[]
}

interface Tracked {
  readonly zone: () => ValleZone
  readonly ratio: number
}

/** The mines on screen: only a shown Valle, with no page over its main zone, has any (S39.04, S39.05). */
export function visibleValleMines(
  facts: VallePresenceFacts,
  zones: readonly { zone: ValleZone; ratio: number }[]
): MineId[] {
  if (!facts.shown || facts.pageOverMain) return []
  const mines: MineId[] = []
  for (const { zone, ratio } of zones) {
    if (zone.content === 'mine' && ratio >= VALLE_ON_SCREEN_RATIO && !mines.includes(zone.mineId)) {
      mines.push(zone.mineId)
    }
  }
  return mines
}

const sameIds = (a: readonly MineId[], b: readonly MineId[]): boolean =>
  a.length === b.length && a.every((id, at) => id === b[at])

export function useVallePresence(deps: VallePresenceDeps): VallePresence {
  const tracked = shallowRef<ReadonlyMap<Element, Tracked>>(new Map())
  const observer = deps.observer(
    (entries) => {
      const next = new Map(tracked.value)
      for (const { target, intersectionRatio } of entries) {
        const zone = next.get(target)
        if (zone !== undefined) next.set(target, { ...zone, ratio: intersectionRatio })
      }
      tracked.value = next
    },
    { threshold: [0, VALLE_ON_SCREEN_RATIO, 1] }
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  let sent: MineId[] | null = null
  function schedule(mineIds: MineId[]): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (sent !== null && sameIds(sent, mineIds)) return
      sent = mineIds
      deps.bridge.reportVisibleMines({ mineIds: [...mineIds] })
    }, VALLE_PRESENCE_DEBOUNCE_MS)
  }

  const onScreen = (): MineId[] =>
    visibleValleMines(
      deps.facts(),
      [...tracked.value.values()].map(({ zone, ratio }) => ({ zone: zone(), ratio }))
    )
  // A fresh array each time the facts or a zone change: `schedule` compares with what was sent.
  watch(onScreen, schedule, { immediate: true })
  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    })
  }

  return {
    onScreen,
    track(element, zone) {
      tracked.value = new Map(tracked.value).set(element, { zone, ratio: 0 })
      observer.observe(element)
      return () => {
        observer.unobserve(element)
        const next = new Map(tracked.value)
        next.delete(element)
        tracked.value = next
      }
    }
  }
}
