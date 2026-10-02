// UI main's `PresenceTracker` (ADR-024 item 7; 14 A-44 `reportVisibleMines`, B-M07 `presence`; ADR-018 item 2): the
// owner of the cross-mode "on screen" query, whose only consumer is the Host.
//
// - Each mode window's renderer reports the mines it shows (A-44, `{ mineIds }`); a window's report settles once it
//   has held for 100 ms (a newer report of the same window within that time replaces it).
// - The on-screen set is the union of the settled reports of the mode windows shown and not minimized right now: in v1
//   there is one such window at most (the visible mode). A hidden or minimized window contributes no mine, and keeps
//   its last report for when it is shown again. `anyWindowVisible` is whether any mode window is shown.
// - `presence {onScreenMineIds, anyWindowVisible, seq}` is handed to `HostClient.reportPresence` only when the set or
//   `anyWindowVisible` changed, with a `seq` one higher than the last; the HostClient sends it on the `ui` connection
//   only (INV-119). The Host adds `anyUiAttached` itself.
// - OS-level occlusion by other applications is not detected (ADR-024 item 7, documented limitation).
import type { MineId } from '@dwarfai/contracts'
import type { HostClient, Presence } from '../ports/hostClient'

/** ADR-024 item 7: a window's report settles after 100 ms. */
export const PRESENCE_DEBOUNCE_MS = 100

/** The timer the debounce runs on (the HostClient's timers in production, a manual queue in tests). */
export interface PresenceTimers {
  /** Runs `run` after `ms`; the answer cancels it. */
  after(ms: number, run: () => void): () => void
}

export interface PresenceTrackerDeps {
  host: Pick<HostClient, 'reportPresence'>
  timers: PresenceTimers
  /** The `webContents` ids of the mode windows shown and not minimized right now. */
  visibleWindows(): readonly number[]
}

export interface PresenceTracker {
  /** A-44: the mines the mode window `windowId` shows; settles after 100 ms. */
  report(windowId: number, mineIds: readonly MineId[]): void
  /** A mode window was shown, hidden, minimized or restored: the set is computed again at once. */
  windowsChanged(): void
  /** A mode window closed: its report goes, and so does a report of it still settling. */
  windowClosed(windowId: number): void
}

function sameSet(a: readonly MineId[], b: readonly MineId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

export function createPresenceTracker(deps: PresenceTrackerDeps): PresenceTracker {
  const { host, timers } = deps
  /** The settled report of each mode window. */
  const reports = new Map<number, readonly MineId[]>()
  /** The cancel of each window's report still settling. */
  const settling = new Map<number, () => void>()
  /** The last presence handed to the HostClient; `null` before the first. */
  let last: Presence | null = null

  const update = (): void => {
    const visible = deps.visibleWindows()
    const onScreenMineIds = [...new Set(visible.flatMap((id) => reports.get(id) ?? []))]
    const anyWindowVisible = visible.length > 0
    if (
      last !== null &&
      last.anyWindowVisible === anyWindowVisible &&
      sameSet(last.onScreenMineIds, onScreenMineIds)
    ) {
      return
    }
    last = { onScreenMineIds, anyWindowVisible, seq: (last?.seq ?? 0) + 1 }
    host.reportPresence(last)
  }

  const cancelSettling = (windowId: number): void => {
    settling.get(windowId)?.()
    settling.delete(windowId)
  }

  return {
    report(windowId, mineIds) {
      cancelSettling(windowId)
      const report = [...mineIds]
      settling.set(
        windowId,
        timers.after(PRESENCE_DEBOUNCE_MS, () => {
          settling.delete(windowId)
          reports.set(windowId, report)
          update()
        })
      )
    },
    windowsChanged: update,
    windowClosed(windowId) {
      cancelSettling(windowId)
      reports.delete(windowId)
      update()
    }
  }
}
