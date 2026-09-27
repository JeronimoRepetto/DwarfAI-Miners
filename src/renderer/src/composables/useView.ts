import { reactive } from 'vue'
import { defaultViewState, parseLaunchView } from '../types'
import type { LaunchView, ShellArea } from '../types'

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

/**
 * Open on the page and the mine the shell last closed on (#635, PANEL-QUESTIONS 25), as main
 * stored them; a first run opens the default view. Awaited by the entry BEFORE the shell mounts, so
 * the first paint is already the remembered page rather than the Map corrected a frame later. The
 * golden page calls it the same way on its bridge.
 *
 * The mine is only a claim: whether it still opens — removed, or its folder gone, and it does not,
 * while the page still does — is App's to decide once the board and the remembered projects have
 * both been read (App.vue, `pruneOpenMine`). A bridge that cannot answer opens the default view:
 * a launch is never worth failing over.
 */
export async function restoreLaunchView(api: {
  getLaunchView: () => Promise<LaunchView>
}): Promise<void> {
  let view: LaunchView
  try {
    view = parseLaunchView(await api.getLaunchView())
  } catch {
    view = defaultViewState()
  }
  Object.assign(state, view)
}
