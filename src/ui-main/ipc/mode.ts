// The mode rows (14 §2.2 A-N13 `moveToMode`, A-N14 `onModeTransition`, A-N15 `modeTransitionDone`: NEW, `ui-local`,
// owner `window` (ModeCoordinator); 14 §3.9 `MoveToModeParams`, `ModeTransition`; ADR-025 item 3; ISSUE-284): a route
// target of the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload
// (`validate.ts`, ADR-019 items 7, 8): an extra key or an unknown mode never reaches it.
//
// - A-N13 is forwarded to the coordinator, which answers when the move that carries it settles (AMENDMENT-10).
// - A-N14 is a push: the coordinator sends it to the two windows of a run, no handler serves it.
// - A-N15 is one-way: the answer of the window that sent it, named by that window's mode. A sender whose mode is not
//   known is not a mode window, so its answer is dropped.
import type { ChannelKey, IpcError, MoveToModeParams } from '@dwarfai/contracts'
import type { AppMode, ModeCoordinator } from '../window/application/ModeCoordinator'
import type { RouteTarget } from './router'

/** A-N13 (invoke). */
export const MODE_MOVE = 'mode:move' satisfies ChannelKey
/** A-N14 (push), sent by the `ModeCoordinator`. */
export const MODE_TRANSITION = 'mode:transition' satisfies ChannelKey
/** A-N15 (send). */
export const MODE_TRANSITION_DONE = 'mode:transition:done' satisfies ChannelKey
/** The three rows (14 §2.2), routed `ui-local` together. */
export const MODE_ROWS = [MODE_MOVE, MODE_TRANSITION, MODE_TRANSITION_DONE] as const

export function createModeRows(
  coordinator: Pick<ModeCoordinator, 'moveToMode' | 'transitionDone'>,
  modeOf: (webContentsId: number) => AppMode | undefined
): RouteTarget {
  return {
    serve(channel, payload, sender) {
      if (channel === MODE_MOVE) return coordinator.moveToMode(payload as MoveToModeParams)
      if (channel === MODE_TRANSITION_DONE) {
        const webContentsId = sender?.sender.id
        const mode = webContentsId === undefined ? undefined : modeOf(webContentsId)
        if (mode !== undefined) {
          coordinator.transitionDone(mode, payload as { transitionId: string })
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
