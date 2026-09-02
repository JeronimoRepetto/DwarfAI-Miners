import { reactive } from 'vue'
import { defaultViewState } from '../types'

// Singleton store: module-scope state shared by every useView() caller
// (house style shared with useMines and a sibling Vue project).
const state = reactive(defaultViewState())

export function useView() {
  function openMine(mineId: string): void {
    state.view = { kind: 'mine', mineId }
  }

  function showMap(): void {
    state.view = { kind: 'map' }
  }

  /** The browse over every remembered project, not just the ones on the board (#92). */
  function showMines(): void {
    state.view = { kind: 'mines' }
  }

  /** Fall back to the map when the currently open mine no longer exists. */
  function syncWithMines(mineIds: readonly string[]): void {
    if (state.view.kind === 'mine' && !mineIds.includes(state.view.mineId)) showMap()
  }

  function clear(): void {
    Object.assign(state, defaultViewState())
  }

  return { state, openMine, showMap, showMines, syncWithMines, clear }
}
