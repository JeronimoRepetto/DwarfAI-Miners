// The Host connection rows (14 §2.2 A-N03 `getHostConnection`, A-N04 `onHostConnection`, A-N05 `retryHostConnection`:
// NEW, `ui-local`, owner `window` (HostClient); 14 §3.8 `HostConnectionView`; ADR-002 D9): a route target of the
// router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload (ADR-019 items 7, 8).
// The rows are listed in `contracts/ipc/unrouted.ts` until the cut-0 switch (ISSUE-056) routes them here; until then
// the router refuses them like a channel with no route.
//
// - A-N03 answers the view of HostClient's state now: ADR-002 D9's `HostConnection` (`retrying` shows as
//   `unavailable{unresponsive}`, 07 §12B) plus what composables gate on — the current connection's capabilities,
//   lifecycle state and job status (16 §4.14.1 "state / onStateChange").
// - A-N04 is pushed on every state change (`pushHostConnection`), with its reason and capabilities.
// - A-N05 is the person's retry (`HostClient.ensureHost()`, ADR-002 D9): it starts the retry and answers the state
//   the retry moved to (`connecting`, or the unchanged hung-Host state while the Retry checks the Host); what follows
//   arrives on A-N04. A retry in any other state changes nothing and answers the state as it is.
// - A-N33 `confirmHostRestart` has no handler in v1 (AMENDMENT-11; review R8B-06): like any channel that is not one
//   of these rows, it is refused, never guessed (14 §1.5).
import type { ChannelKey, HostConnectionView, IpcError } from '@dwarfai/contracts'
import type { HostClientService } from '../../host-client/HostClient'
import type { RouteTarget } from '../router'

/** The invoke rows this module serves, by registry key. */
export const HOST_CONNECTION_ROWS = [
  'host:connection:get',
  'host:connection:retry'
] as const satisfies readonly ChannelKey[]

/** A-N04, pushed by `pushHostConnection`. */
export const HOST_CONNECTION_PUSH = 'host:connection:changed' satisfies ChannelKey

/** What the rows read of HostClient. */
export type HostConnectionSource = Pick<
  HostClientService,
  'state' | 'capabilities' | 'ensureHost' | 'onStateChange' | 'hostFacts'
>

/** 14 §3.8 `HostConnectionView` of the client's state now (16 §4.14.1). */
export function hostConnectionView(source: HostConnectionSource): HostConnectionView {
  const connection = source.state()
  switch (connection.state) {
    case 'connecting':
      return { state: 'connecting' }
    case 'reconnecting':
      return { state: 'reconnecting', since: connection.since }
    case 'unavailable':
      return {
        state: 'unavailable',
        reason: connection.reason,
        ...(connection.restart === undefined ? {} : { restart: { ...connection.restart } })
      }
    case 'connected': {
      const facts = source.hostFacts()
      return {
        state: 'connected',
        hostVersion: connection.hostVersion,
        compat: connection.compat,
        ...(facts === null ? {} : { hostState: facts.hostState, jobStatus: facts.jobStatus }),
        capabilities: [...source.capabilities()]
      }
    }
  }
}

export function createHostConnectionRows(source: HostConnectionSource): RouteTarget {
  const served: readonly string[] = HOST_CONNECTION_ROWS
  return {
    serve(channel) {
      if (!served.includes(channel)) {
        const error: IpcError = {
          code: 'METHOD_NOT_FOUND',
          message: `no ui-local handler for ${channel}`,
          retryable: false
        }
        return Promise.resolve({ ok: false, error })
      }
      // A-N05: the retry runs on; its outcome is pushed on A-N04 (and logged by HostClient).
      if (channel === 'host:connection:retry') void source.ensureHost().catch(() => {})
      return Promise.resolve(hostConnectionView(source))
    }
  }
}

/** A-N04: `send` gets the view on every state change; the answer stops it. */
export function pushHostConnection(
  source: HostConnectionSource,
  send: (view: HostConnectionView) => void
): () => void {
  return source.onStateChange(() => send(hostConnectionView(source)))
}
