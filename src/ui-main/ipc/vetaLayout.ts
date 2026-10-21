// The Veta layout rows (14 §2.2 A-N23 `layoutVeta`, A-N28 `onVetaDockChanged`: NEW, `ui-local`, owner `window`;
// ADR-025 items 2, 5, 8; 07 machine 21; ISSUE-286): a route target of the router (ADR-001 item 3), so every call has
// passed the seam A gate first, sender and payload (`validate.ts`, ADR-019 items 7, 8): an unknown kind or an extra key
// never reaches it.
//
// - A-N23 is the Veta window's own: its request goes to the dock (`VetaDockService.layout`), which answers the place it
//   applied. Another mode window moves nothing and is answered the current place with `applied: false`.
// - A-N28 is a push: UI main sends it to the Veta window itself (`VetaDockService`), so a renderer call of it is not a
//   request this target serves.
import type {
  ChannelKey,
  IpcError,
  VetaDock,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
import type { RouteTarget } from './router'

/** A-N23 (invoke). */
export const LAYOUT_VETA = 'veta:layout' satisfies ChannelKey
/** A-N28 (push). */
export const VETA_DOCK_CHANGED = 'veta:dock:changed' satisfies ChannelKey
/** The two rows (14 §2.2), routed `ui-local` together. */
export const VETA_LAYOUT_ROWS = [LAYOUT_VETA, VETA_DOCK_CHANGED] as const

export interface VetaLayoutRowsDeps {
  /** The dock (`VetaDockService`). */
  dock: {
    layout(request: VetaLayoutRequest): VetaLayoutResult
    current(): { displayKey: string; dock: VetaDock }
  }
  /** Whether a `webContents` id is the Veta window's. */
  isVeta(webContentsId: number): boolean
}

export function createVetaLayoutRows(deps: VetaLayoutRowsDeps): RouteTarget {
  return {
    serve(channel, payload, sender) {
      if (channel === LAYOUT_VETA) {
        const webContentsId = sender?.sender.id
        if (webContentsId === undefined || !deps.isVeta(webContentsId)) {
          const { displayKey, dock } = deps.dock.current()
          return Promise.resolve({ applied: false, displayKey, dock } satisfies VetaLayoutResult)
        }
        return Promise.resolve(deps.dock.layout(payload as VetaLayoutRequest))
      }
      const error: IpcError = {
        code: 'METHOD_NOT_FOUND',
        message: `no ui-local handler for ${channel}`,
        retryable: false
      }
      return Promise.resolve({ ok: false, error })
    }
  }
}
