/*
 * Veta's on-screen report (07 S20.18; 14 A-44 `reportVisibleMines`; ADR-024 item 7; BR-02; ISSUE-287): the mines whose
 * chamber is drawn, for UI main's `PresenceTracker`, the one place "on screen" is computed (INV-119). The report is
 * empty in `first-run` and `no-sessions` (the closed entrance draws no chamber) and while the window is not shown; a
 * folded or undrawn mine is never in it: a mine folded into "+N" is not on screen, so a need there may notify (07
 * S25.10, BR-02; ISSUE-291). The drawn set is re-reported each time it changes, a wheel turn, an unfold or a re-measure
 * (S25.03, S25.04, S25.11). Debounced 100 ms, so a run of changes (an arrival, a wheel turn) sends once, the last; an
 * unchanged set is not sent again.
 *
 * The bridge and the facts are injected (the house idiom over `vi.mock`); the timer is the window's own.
 */
import type { MineId } from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, watch } from 'vue'
import type { VetaLifeState } from '../lib/veta/lifeState'

/** The seam A member this composable uses (14 A-44). */
export interface VetaPresenceBridge {
  reportVisibleMines(request: { mineIds: MineId[] }): void
}

/** What the report is read from. */
export interface VetaPresenceFacts {
  readonly state: VetaLifeState | null
  /** Whether Veta is the shown mode window. */
  readonly shown: boolean
  /** The mines whose chamber is drawn, in mine order. */
  readonly drawn: readonly MineId[]
}

export interface VetaPresenceDeps {
  bridge: VetaPresenceBridge
  facts(): VetaPresenceFacts
}

/** S20.18's debounce. */
export const VETA_PRESENCE_DEBOUNCE_MS = 100

/** The mines on screen: only a shown window with chambers has any. */
export function visibleMines(facts: VetaPresenceFacts): MineId[] {
  const chambers = facts.state === 'all-idle' || facts.state === 'sessions-working'
  return facts.shown && chambers ? [...facts.drawn] : []
}

const sameIds = (a: readonly MineId[], b: readonly MineId[]): boolean =>
  a.length === b.length && a.every((id, at) => id === b[at])

export function useVetaPresence(deps: VetaPresenceDeps): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let sent: MineId[] | null = null

  function schedule(mineIds: MineId[]): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (sent !== null && sameIds(sent, mineIds)) return
      sent = mineIds
      deps.bridge.reportVisibleMines({ mineIds: [...mineIds] })
    }, VETA_PRESENCE_DEBOUNCE_MS)
  }

  // A fresh array each time the facts change: `schedule` compares with what was sent.
  watch(() => visibleMines(deps.facts()), schedule, { immediate: true })
  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
}

/** The report over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowVetaPresence(facts: () => VetaPresenceFacts): void {
  useVetaPresence({ bridge: window.api, facts })
}
