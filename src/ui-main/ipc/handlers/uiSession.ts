// The UI session rows (14 §2.2 A-N17 `getUiSession`, A-N18 `patchUiSession`, A-N19 `onUiSessionChanged`: NEW,
// `ui-local`, owner `window` (SessionStore); 14 §3.9 `UiSessionSnapshot`, `UiSessionPatch`; ADR-024 items 1, 3): a
// route target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload
// (`validate.ts`, ADR-019 items 7, 8): a patch of an unknown kind or with an extra key never reaches it, it is
// dropped and counted.
//
// - A-N17 answers the whole store now (window/application/uiSession.ts).
// - A-N18 is one-way: the patch is applied and pushed to every other mode window with the mode of the window that
//   sent it (A-N19). A sender whose mode is not known is not a mode window, so its patch is dropped.
// - A-N19 is a push: the use case sends it, no handler serves it.
//
// The rows are born `ui-local` in cut 1 and listed in `unrouted.ts` until the cut-1 switch (ISSUE-123) routes them; in
// a table without their routes the router refuses them like a channel with no route. A call of any other channel is
// refused, never guessed (14 §1.5).
import type { ChannelKey, IpcError, UiSessionPatch } from '@dwarfai/contracts'
import type { UiSession } from '../../window/application/uiSession'
import type { RouteTarget } from '../router'

/** A-N17 (invoke). */
export const UI_SESSION_GET = 'ui:session:get' satisfies ChannelKey
/** A-N18 (send). */
export const UI_SESSION_PATCH = 'ui:session:patch' satisfies ChannelKey
/** The rows this target serves. */
export const UI_SESSION_ROWS = [UI_SESSION_GET, UI_SESSION_PATCH] as const

/** The mode of a mode window by its `webContents` id; undefined for any other sender. */
export type ModeOfWindow = (webContentsId: number) => 'panel' | 'veta' | 'valle' | undefined

export function createUiSessionRows(
  session: Pick<UiSession, 'get' | 'patch'>,
  modeOf: ModeOfWindow
): RouteTarget {
  return {
    serve(channel, payload, sender) {
      if (channel === UI_SESSION_GET) return Promise.resolve(session.get())
      if (channel === UI_SESSION_PATCH) {
        const webContentsId = sender?.sender.id
        const mode = webContentsId === undefined ? undefined : modeOf(webContentsId)
        if (webContentsId !== undefined && mode !== undefined) {
          session.patch(payload as UiSessionPatch, { webContentsId, mode })
        }
        return Promise.resolve(undefined)
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
