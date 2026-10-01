// The A-N30 `reportRendererDiagnostic` handler (14 §2.2 row A-N30: `send`, `ui-local`, "window (UI logger)"; §1.10):
// the route target that serves the row once its step routes it `ui-local` (cut 0, ISSUE-056; until then the row is
// listed in `contracts/ipc/unrouted.ts` and the router refuses it). It hands the payload and the sender's window to
// the renderer diagnostics, which validate, rate-limit and log it; it has no Host dependency, so nothing it serves
// can be forwarded to the Host. A one-way call answers nothing; a call of any other channel is refused like a call
// with no route, so this target never serves a row that is not its own.
import type { ChannelKey } from '@dwarfai/contracts'
import type { RendererDiagnostics } from '../../diagnostics/rendererDiagnostics'
import type { RouteRefusal, RouteTarget } from '../router'

export const RENDERER_DIAGNOSTIC_CHANNEL: ChannelKey = 'diag:renderer:report'

export function createRendererDiagnosticHandler(diagnostics: RendererDiagnostics): RouteTarget {
  return {
    async serve(channel, payload, sender): Promise<RouteRefusal | undefined> {
      if (channel !== RENDERER_DIAGNOSTIC_CHANNEL) {
        return {
          ok: false,
          error: { code: 'METHOD_NOT_FOUND', message: `no route for ${channel}`, retryable: false }
        }
      }
      diagnostics.report(sender?.sender.id, payload)
      return undefined
    }
  }
}
