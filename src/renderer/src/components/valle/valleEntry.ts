/*
 * The Valle entry of the renderer (ADR-025 item 1; 05 §2.3; ISSUE-299): every mode window loads the same bundle, and UI
 * main names the mode in the entry's query; the Valle window loads it with `?mode=valle`. Pure.
 *
 * The Valle root reads the seam A members it uses through one plain bridge, built by the composition root (`main.ts`)
 * from the page's own `window.api` (R13), so the root and its parts never read `window.api` themselves.
 */
import type { HostFrame, UiPreferenceWrite } from '@dwarfai/contracts'
import type { ValleMosaicBridge, ValleMosaicWrite } from '../../composables/useValleMosaic'
import type { VallePinsBridge, VallePinsWrite } from '../../composables/useVallePins'
import type { ValleLastMineWrite, VallePresetBridge } from '../../composables/useVallePreset'
import type { VallePresenceDeps } from '../../composables/useVallePresence'
import type { ValleStoresBridge } from '../../composables/useValleStores'
import type { ValleRevealBridge } from '../../composables/useValleReveal'
import type { ValleReadModelBridge } from '../../lib/valle/valleReadModel'

/** Whether the page's query string (`location.search`) is the Valle window's. */
export function isValleRoot(search: string): boolean {
  return new URLSearchParams(search).get('mode') === 'valle'
}

/**
 * The seam A members the Valle root uses: its stores (A-N17, A-N20, A-N12), its read models, its report (A-44), and its
 * preset's writes and moves (A-N21, A-N13; ISSUE-300), its pins' writes (A-N21 `pins`, A-N18; ISSUE-302), the
 * dive's (A-N21 `valleLastFrontMineId`, A-N18; ISSUE-301), and the mosaic's and the zones' (A-N21
 * `valleMosaicOrder`, `mutedMineIds`; A-30, A-31 for "A new project…"; ISSUE-304), and the reveal of a notification
 * click (A-N16; ISSUE-311).
 */
export type ValleBridge = ValleStoresBridge &
  ValleReadModelBridge &
  VallePresenceDeps['bridge'] &
  VallePresetBridge &
  VallePinsBridge &
  ValleMosaicBridge &
  ValleRevealBridge

/**
 * The Valle keys the Valle window writes (A-N21); the last mine worked in from ISSUE-301 on, the mosaic order and the
 * muted mines from ISSUE-304 on.
 */
type ValleWrite =
  | Extract<UiPreferenceWrite, { key: 'vallePreset' | 'valleLayout' }>
  | VallePinsWrite
  | ValleLastMineWrite
  | ValleMosaicWrite

/** The Valle bridge over a `window.api`. */
export function valleBridgeOf(api: Window['api']): ValleBridge {
  return {
    getUiPreferences: (request) => api.getUiPreferences(request),
    getUiSession: () => api.getUiSession(),
    onUiPreferencesReset: (listener) => api.onUiPreferencesReset(listener),
    onHostEvent: (listener) =>
      api.onHostEvent((frames) => listener(frames as unknown as readonly HostFrame[])),
    getHostSnapshot: (params) => api.getHostSnapshot(params),
    onHostConnection: (listener) => api.onHostConnection(listener),
    reportVisibleMines: (request) => api.reportVisibleMines(request),
    setUiPreference: (write: ValleWrite) => api.setUiPreference(write),
    moveToMode: (params) => api.moveToMode(params),
    patchUiSession: (patch) => api.patchUiSession(patch),
    declareMine: () => api.declareMine(),
    declareMainProject: () => api.declareMainProject(),
    onRevealDwarfChat: (listener) => api.onRevealDwarfChat(listener)
  }
}
