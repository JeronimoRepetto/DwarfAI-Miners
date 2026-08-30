import { reactive } from 'vue'
import {
  REACTION_WINDOW_MS,
  observeReaction,
  openReactionWatch,
  type ReactionSnapshot,
  type ReactionWatch
} from '../lib/delivery/reaction'
import {
  defaultDwarfMessagingState,
  type Dwarf,
  type DwarfSendState,
  type DwarfTextResult
} from '../types'

/**
 * Delivery state for messages typed into the panel.
 *
 * Sending is deliberately fire-and-observe: the relay can take seconds, and
 * the panel must stay usable the whole time, so the only thing the UI blocks
 * on is the per-dwarf marker this store drives.
 *
 * The verdict has two phases (issue #21). 'delivered' means the text reached
 * the session's QUEUE — nothing more. A session reads its queue between tool
 * calls, so the store then watches that dwarf's own poll snapshots (fed in
 * through `observe`) for proof it acted, and only then promotes to 'reacted'.
 * A delivery that is never seen reacting decays back to a plain, honest
 * 'delivered' instead of hanging or claiming something that did not happen.
 */

/** How long a verdict stays on the dwarf before the marker clears itself. */
export const RESULT_VISIBLE_MS = 4_000

// Singleton store: module-scope state shared by every useDwarfMessaging()
// caller (house style shared with the sibling AI-Tools Vue tools).
const state = reactive(defaultDwarfMessagingState())
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Open reaction watches, keyed by dwarf id — at most one per dwarf. */
const watches = new Map<string, ReactionWatch>()
const watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** The latest snapshot seen per dwarf, so a new delivery has a baseline to compare against. */
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

/**
 * Start watching for proof the session read this message. The marker deliberately
 * stays on screen for as long as the watch is open — the whole point is to show
 * whether a reaction followed, which a four-second ✓ could never do.
 */
function startWatch(dwarfId: string): void {
  stopWatch(dwarfId)
  watches.set(dwarfId, openReactionWatch('message', lastSeen.get(dwarfId), Date.now()))
  watchTimers.set(
    dwarfId,
    setTimeout(() => {
      stopWatch(dwarfId)
      const current = state.byDwarfId[dwarfId]
      if (current?.phase !== 'delivered') return
      // Decay, never promote: the window closed without proof, and the marker
      // says exactly that before clearing itself.
      state.byDwarfId[dwarfId] = { ...current, awaitingReaction: false }
      scheduleClear(dwarfId)
    }, REACTION_WINDOW_MS)
  )
}

export function useDwarfMessaging() {
  function stateFor(dwarfId: string): DwarfSendState | undefined {
    return state.byDwarfId[dwarfId]
  }

  /**
   * Deliver `text` to `dwarfId`. A second call while one is still in flight
   * for the same dwarf is ignored: a double-click must never type the message
   * into a session twice.
   */
  async function send(dwarfId: string, text: string, pressEnter: boolean): Promise<void> {
    if (state.byDwarfId[dwarfId]?.phase === 'sending') return
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    stopWatch(dwarfId)
    state.byDwarfId[dwarfId] = { phase: 'sending' }

    let result: DwarfTextResult
    try {
      result = await window.api.sendDwarfText({ dwarfId, text, pressEnter })
    } catch {
      result = { delivered: false, via: 'none', error: 'The panel lost contact with the app.' }
    }

    const next: DwarfSendState = {
      phase: result.delivered ? 'delivered' : 'failed',
      via: result.via
    }
    if (result.error !== undefined) next.error = result.error
    if (result.delivered) next.awaitingReaction = true
    state.byDwarfId[dwarfId] = next

    // A failure has nothing to wait for; a delivery does.
    if (result.delivered) startWatch(dwarfId)
    else scheduleClear(dwarfId)
  }

  /**
   * Fold one poll's snapshot of the mine into the store. This is the entire
   * input to reaction detection: the panel already receives every dwarf's
   * status and last message on each poll, so proving a session acted costs no
   * new IPC and no new main-process field.
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

  return { state, send, observe, stateFor, clear, clearAll }
}
