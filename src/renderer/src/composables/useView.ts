import { reactive } from 'vue'
import { defaultViewState } from '../types'
import type { ShellArea } from '../types'

// Singleton store: module-scope state shared by every useView() caller
// (house style shared with useMines and a sibling Vue project).
const state = reactive(defaultViewState())

export function useView() {
  /**
   * Hold a mine open. The secondary panel is left exactly where it was, which
   * is the design's concurrent model: walking into a mine from the map leaves
   * the map behind it, and walking in from the browse leaves the browse.
   */
  function openMine(mineId: string): void {
    state.mineId = mineId
  }

  /** Close the mine, leaving the secondary panel untouched. */
  function closeMine(): void {
    state.mineId = null
  }

  /** Select one of the six shell areas. The open mine, if any, stays open. */
  function showArea(area: ShellArea): void {
    state.area = area
  }

  function showMap(): void {
    showArea('map')
  }

  /** The browse over every remembered project, not just the ones on the board (#92). */
  function showMines(): void {
    showArea('mines')
  }

  /** Let go of the open mine when it no longer exists on the board. */
  function syncWithMines(mineIds: readonly string[]): void {
    if (state.mineId !== null && !mineIds.includes(state.mineId)) closeMine()
  }

  function clear(): void {
    Object.assign(state, defaultViewState())
  }

  return { state, openMine, closeMine, showArea, showMap, showMines, syncWithMines, clear }
}
