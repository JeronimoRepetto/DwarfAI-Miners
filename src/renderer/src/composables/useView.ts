import type { MineId, UiSessionPatch, UiSessionSnapshot } from '@dwarfai/contracts'
import { reactive, watch } from 'vue'
import { defaultViewState, parseLaunchView } from '../types'
import type { LaunchView, ShellArea } from '../types'
import { modeTransitionPart, type ModeTransitionPart } from './useModeTransition'

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
    launchMine = null
    stopFollowing?.()
    stopFollowing = null
  }

  return { state, openMine, closeMine, showArea, showMap, showMines, syncWithMines, clear }
}

/**
 * The mine the launch remembered, held until App knows whether it still opens (#635,
 * PANEL-QUESTIONS 25), or null when none is waiting.
 */
let launchMine: string | null = null

/**
 * Open on the page the shell last closed on (#635, PANEL-QUESTIONS 25), as main stored it; a first
 * run opens the default view. Awaited by the entry BEFORE the shell mounts, so the first paint is
 * already the remembered page rather than the Map corrected a frame later. The golden page calls it
 * the same way on its bridge.
 *
 * The page opens at once; the mine does NOT. A remembered mine that was removed, or whose folder is
 * gone, opens nothing, and only main's browse can say which (`folderMissing`), so the mine waits in
 * `takeLaunchMine` for App to ask once the board and the projects are read — opening it first and
 * closing it a moment later would show the person a mine that is not there. A bridge that cannot
 * answer opens the default view: a launch is never worth failing over.
 *
 * ISSUE-295: with the UI session store in reach (the Panel's own `window.api`), the Panel's open mine then follows its
 * current mine there (`followPanelMine`). A Panel that starts while a hand-off names its mine (07 S22.13: Veta wrote
 * `currentMine.panel` before asking for the move) waits on that mine instead of the remembered one.
 */
export async function restoreLaunchView(
  api: { getLaunchView: () => Promise<LaunchView> } & Partial<PanelMineBridge>,
  arrivals?: Pick<ModeTransitionPart, 'onMineArrival'>
): Promise<void> {
  const following = sessionBridge(api)
  const [view, named] = await Promise.all([readLaunchView(api), namedPanelMine(following)])
  Object.assign(state, { area: view.area, mineId: null })
  launchMine = named ?? view.mineId
  if (following !== null) followPanelMine(following, arrivals ?? modeTransitionPart())
}

async function readLaunchView(api: {
  getLaunchView: () => Promise<LaunchView>
}): Promise<LaunchView> {
  try {
    return parseLaunchView(await api.getLaunchView())
  } catch {
    return defaultViewState()
  }
}

/** The UI session store members the Panel's current mine needs (14 §2.2 A-N17, A-N18). */
export interface PanelMineBridge {
  getUiSession(): Promise<UiSessionSnapshot>
  patchUiSession(patch: UiSessionPatch): void
}

function sessionBridge(api: Partial<PanelMineBridge>): PanelMineBridge | null {
  const { getUiSession, patchUiSession } = api
  if (typeof getUiSession !== 'function' || typeof patchUiSession !== 'function') return null
  return { getUiSession: () => getUiSession(), patchUiSession: (patch) => patchUiSession(patch) }
}

/** The mine a hand-off named for the Panel (`currentMine.panel`), or null when none did or the store cannot answer. */
async function namedPanelMine(bridge: PanelMineBridge | null): Promise<string | null> {
  if (bridge === null) return null
  try {
    return (await bridge.getUiSession()).currentMine.panel ?? null
  } catch {
    return null
  }
}

let stopFollowing: (() => void) | null = null

/**
 * The Panel's open mine mirrors its current mine in the UI session store (ADR-024 item 1, ADR-033 item 4; ISSUE-295):
 * a run into the Panel that names a mine opens it in the mine column (07 S22.13, S27.01), and each change of the open
 * mine is written back, so the store never names a mine the person has since closed. Started once per Panel window;
 * starting again replaces the earlier one.
 */
export function followPanelMine(
  bridge: PanelMineBridge,
  arrivals: Pick<ModeTransitionPart, 'onMineArrival'>
): () => void {
  stopFollowing?.()
  const unlisten = arrivals.onMineArrival((mineId) => {
    state.mineId = mineId
  })
  const unwatch = watch(
    () => state.mineId,
    (mineId) => {
      // The renderer's mine ids are the Host's (`MineId`), held as plain strings by the legacy view state.
      bridge.patchUiSession({
        kind: 'current-mine',
        host: 'panel',
        mineId: mineId as MineId | null
      })
    },
    { flush: 'sync' }
  )
  const stop = (): void => {
    unlisten()
    unwatch()
    if (stopFollowing === stop) stopFollowing = null
  }
  stopFollowing = stop
  return stop
}

/** The remembered mine waiting to be judged, handed over once; null when none is waiting. */
export function takeLaunchMine(): string | null {
  const mine = launchMine
  launchMine = null
  return mine
}
