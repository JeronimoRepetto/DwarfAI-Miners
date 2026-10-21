// The Veta rows (14 §2.2 A-N22 `setVetaClickThrough`, A-N24 `getWindowingLimits`: NEW, `ui-local`, owner `window`;
// ADR-025 items 4, 6; ISSUE-285): a route target of the router (ADR-001 item 3), so every call has passed the seam A
// gate first, sender and payload (`validate.ts`, ADR-019 items 7, 8): an extra key never reaches it.
//
// - A-N22 is one-way and the Veta window's own: a mode window that is not the Veta window toggles nothing.
// - A-N24 answers any mode window (Settings › General reads it in the Panel) with the limits as they are now.
import type { ChannelKey, IpcError, VetaClickThroughParams } from '@dwarfai/contracts'
import type { WindowingLimits } from '../window/domain/windowingLimits'
import type { RouteTarget } from './router'

/** A-N22 (send). */
export const SET_VETA_CLICK_THROUGH = 'veta:clickThrough' satisfies ChannelKey
/** A-N24 (invoke). */
export const GET_WINDOWING_LIMITS = 'window:limits' satisfies ChannelKey
/** The two rows (14 §2.2), routed `ui-local` together. */
export const VETA_ROWS = [SET_VETA_CLICK_THROUGH, GET_WINDOWING_LIMITS] as const

export interface VetaRowsDeps {
  /** The Veta window's click-through (`VetaWindowController.setClickThrough`). */
  veta: { setClickThrough(ignore: boolean): void }
  /** Whether a `webContents` id is the Veta window's. */
  isVeta(webContentsId: number): boolean
  /** What the windowing of this session allows now. */
  limits(): WindowingLimits
}

export function createVetaRows(deps: VetaRowsDeps): RouteTarget {
  return {
    serve(channel, payload, sender) {
      if (channel === SET_VETA_CLICK_THROUGH) {
        const webContentsId = sender?.sender.id
        if (webContentsId !== undefined && deps.isVeta(webContentsId)) {
          deps.veta.setClickThrough((payload as VetaClickThroughParams).ignore)
        }
        return Promise.resolve(undefined)
      }
      if (channel === GET_WINDOWING_LIMITS) return Promise.resolve({ ...deps.limits() })
      const error: IpcError = {
        code: 'METHOD_NOT_FOUND',
        message: `no ui-local handler for ${channel}`,
        retryable: false
      }
      return Promise.resolve({ ok: false, error })
    }
  }
}
