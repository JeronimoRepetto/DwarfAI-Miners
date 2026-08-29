import { reactive } from 'vue'
import { defaultViewState } from '../types'

// Singleton store: module-scope state shared by every useView() caller
// (house style shared with useMines and the sibling AI-Tools Vue tools).
const state = reactive(defaultViewState())

export function useView() {
  function openMine(mineId: string): void {
    state.view = { kind: 'mine', mineId }
  }

  function showMap(): void {
    state.view = { kind: 'map' }
  }

  /** Fall back to the map when the currently open mine no longer exists. */
  function syncWithMines(mineIds: readonly string[]): void {
    if (state.view.kind === 'mine' && !mineIds.includes(state.view.mineId)) showMap()
  }

  function clear(): void {
    Object.assign(state, defaultViewState())
  }

  return { state, openMine, showMap, syncWithMines, clear }
}
