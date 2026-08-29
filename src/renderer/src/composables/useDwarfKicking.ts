import { reactive } from 'vue'
import { defaultDwarfKickingState, type DwarfKickResult, type DwarfKickState } from '../types'
import { RESULT_VISIBLE_MS } from './useDwarfMessaging'

/**
 * Delivery state for Kick, mirroring useDwarfMessaging: fire-and-observe, so
 * the panel stays usable while the interrupt/relay/foreman-relay attempt runs,
 * and the only thing the UI blocks on is the per-dwarf marker this store drives.
 */
export { RESULT_VISIBLE_MS }

// Singleton store: module-scope state shared by every useDwarfKicking() caller
// (same house style as useDwarfMessaging).
const state = reactive(defaultDwarfKickingState())
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

  return { state, kick, stateFor, clear, clearAll }
}
