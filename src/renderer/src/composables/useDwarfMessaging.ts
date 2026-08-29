import { reactive } from 'vue'
import { defaultDwarfMessagingState, type DwarfSendState, type DwarfTextResult } from '../types'

/**
 * Delivery state for messages typed into the panel.
 *
 * Sending is deliberately fire-and-observe: the relay can take seconds, and
 * the panel must stay usable the whole time, so the only thing the UI blocks
 * on is the per-dwarf marker this store drives.
 */

/** How long a verdict stays on the dwarf before the marker clears itself. */
export const RESULT_VISIBLE_MS = 4_000

// Singleton store: module-scope state shared by every useDwarfMessaging()
// caller (house style shared with the sibling AI-Tools Vue tools).
const state = reactive(defaultDwarfMessagingState())
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
    state.byDwarfId[dwarfId] = next
    scheduleClear(dwarfId)
  }

  function clear(dwarfId: string): void {
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    delete state.byDwarfId[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
  }

  return { state, send, stateFor, clear, clearAll }
}
