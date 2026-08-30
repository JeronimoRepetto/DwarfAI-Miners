import { reactive } from 'vue'
import {
  REACTION_WINDOW_MS,
  observeReaction,
  openReactionWatch,
  type ReactionSnapshot,
  type ReactionWatch
} from '../lib/reaction'
import {
  defaultDwarfKickingState,
  type Dwarf,
  type DwarfKickResult,
  type DwarfKickState
} from '../types'
import { RESULT_VISIBLE_MS } from './useDwarfMessaging'

/**
 * Delivery state for Kick, mirroring useDwarfMessaging: fire-and-observe, so
 * the panel stays usable while the interrupt/relay/foreman-relay attempt runs,
 * and the only thing the UI blocks on is the per-dwarf marker this store drives.
 *
 * Two-phase verdict, same as messaging (issue #21): 'delivered' means the
 * interrupt was handed over, and only a session actually seen stopping earns
 * 'reacted'. A relayed kick is a semantic ask — the session decides how and
 * when to honour it — so the gap between the two is real and often long.
 */
export { RESULT_VISIBLE_MS }

// Singleton store: module-scope state shared by every useDwarfKicking() caller
// (same house style as useDwarfMessaging).
const state = reactive(defaultDwarfKickingState())
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Open reaction watches, keyed by dwarf id — at most one per dwarf. */
const watches = new Map<string, ReactionWatch>()
const watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** The latest snapshot seen per dwarf, so a new kick has a baseline to compare against. */
const lastSeen = new Map<string, ReactionSnapshot>()

function scheduleClear(dwarfId: string): void {
  clearTimeout(clearTimers.get(dwarfId))
  clearTimers.set(
    dwarfId,
    setTimeout(() => {
      delete state.byDwarfId[dwarfId]
      clearTimers.delete(dwarfId)
    }, RESULT_VISIBLE_MS)
  )
}

function stopWatch(dwarfId: string): void {
  clearTimeout(watchTimers.get(dwarfId))
  watchTimers.delete(dwarfId)
  watches.delete(dwarfId)
}

/** Watch for proof the session stopped; the marker stays up for as long as it runs. */
function startWatch(dwarfId: string): void {
  stopWatch(dwarfId)
  watches.set(dwarfId, openReactionWatch('kick', lastSeen.get(dwarfId), Date.now()))
  watchTimers.set(
    dwarfId,
    setTimeout(() => {
      stopWatch(dwarfId)
      const current = state.byDwarfId[dwarfId]
      if (current?.phase !== 'delivered') return
      // Decay, never promote: an unobserved window says so plainly.
      state.byDwarfId[dwarfId] = { ...current, awaitingReaction: false }
      scheduleClear(dwarfId)
    }, REACTION_WINDOW_MS)
  )
}

export function useDwarfKicking() {
  function stateFor(dwarfId: string): DwarfKickState | undefined {
    return state.byDwarfId[dwarfId]
  }

  /**
   * Cancel `dwarfId`'s current work. A second call while one is still in
   * flight for the same dwarf is ignored: a double-click must never fire the
   * kick twice.
   */
  async function kick(dwarfId: string): Promise<void> {
    if (state.byDwarfId[dwarfId]?.phase === 'kicking') return
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    stopWatch(dwarfId)
    state.byDwarfId[dwarfId] = { phase: 'kicking' }

    let result: DwarfKickResult
    try {
      result = await window.api.kickDwarf({ dwarfId })
    } catch {
      result = { delivered: false, via: 'none', error: 'The panel lost contact with the app.' }
    }

    const next: DwarfKickState = {
      phase: result.delivered ? 'delivered' : 'failed',
      via: result.via
    }
    if (result.error !== undefined) next.error = result.error
    if (result.delivered) next.awaitingReaction = true
    state.byDwarfId[dwarfId] = next

    if (result.delivered) startWatch(dwarfId)
    else scheduleClear(dwarfId)
  }

  /**
   * Fold one poll's snapshot of the mine into the store — the entire input to
   * reaction detection. No new IPC: this is the same per-dwarf status the panel
   * is already rendering.
   */
  function observe(dwarfs: readonly Dwarf[]): void {
    for (const dwarf of dwarfs) {
      const snapshot: ReactionSnapshot = { status: dwarf.status, lastMessage: dwarf.lastMessage }
      const watch = watches.get(dwarf.id)
      lastSeen.set(dwarf.id, snapshot)
      if (watch === undefined) continue

      const next = observeReaction(watch, snapshot, Date.now())
      if (next.verdict !== 'reacted') {
        watches.set(dwarf.id, next)
        continue
      }

      stopWatch(dwarf.id)
      const current = state.byDwarfId[dwarf.id]
      if (current?.phase !== 'delivered') continue
      state.byDwarfId[dwarf.id] = {
        phase: 'reacted',
        ...(current.via === undefined ? {} : { via: current.via })
      }
      // The same fact that earns the ✓✓ is the only one that earns a removal
      // (issue #46): this agent has been SEEN stopping. Reported rather than
      // acted on, because main owns which dwarfs exist — the dwarf walks out
      // when the next poll's snapshot says so. The watch is already closed
      // above, so this fires once however many polls follow.
      window.api.retireDwarf(dwarf.id)
      scheduleClear(dwarf.id)
    }
  }

  function clear(dwarfId: string): void {
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    stopWatch(dwarfId)
    lastSeen.delete(dwarfId)
    delete state.byDwarfId[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
    for (const dwarfId of [...watches.keys()]) stopWatch(dwarfId)
    lastSeen.clear()
  }

  return { state, kick, observe, stateFor, clear, clearAll }
}
