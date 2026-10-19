// B-M07 `presence` (14 §2.3, §3.4 `PresenceParams`; ADR-018 item 2; ADR-024 D7; INV-101, INV-119):
// what UI main's `PresenceTracker` reports on screen, handed to the attention policy as
// `AttentionInputs.presenceChanged(uiClient, presence | 'detached')` (16 §4.11). The composition
// root registers it (later: ISSUE-119).
//
// - `ui` only (roles.ts): a `notifier` or `viewer` gets FORBIDDEN before the handler runs (ADR-003
//   item 12; INV-119: presence never travels on the notifier connection). The params are the
//   contract's strict() schema (INVALID_PARAMS otherwise). Not mutating: no requestId (14 §1.6).
// - Each report is keyed by its connection's clientId. The policy keeps each client's last report,
//   ignores an older `seq` of the same client and unions every attached client (16 §4.11 row
//   `presenceChanged`); none of that is restated here.
// - `anyUiAttached` comes from the Host's own connection registry, never from the UI (ADR-018 item
//   2): a reporting client is an attached `ui` one, and a `ui` connection that leaves the registry
//   (a close, the clean exit's `endAll`) is handed on as `'detached'`, so with no `ui` client
//   attached nothing is on screen.
import { HOST_METHOD_SCHEMAS, type HostMethods, type PresenceParams } from '@dwarfai/contracts'
import type { AttentionInputs, Presence } from '../../modules/attention'
import type { ConnectionRegistry } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface PresenceMethodsDeps {
  attention: Pick<AttentionInputs, 'presenceChanged'>
  connections: Pick<ConnectionRegistry, 'onDetach'>
}

/** The policy's `Presence` for one `ui` client's report: that client is attached. */
function presenceOf(params: PresenceParams): Presence {
  return {
    anyUiAttached: true,
    anyWindowVisible: params.anyWindowVisible,
    onScreenMineIds: new Set(params.onScreenMineIds),
    seq: params.seq
  }
}

/**
 * Serves `presence` (B-M07) on `dispatcher` and hands each `ui` detach on as `'detached'`; returns
 * the unsubscribe of the detach listener.
 */
export function registerPresence(dispatcher: Dispatcher, deps: PresenceMethodsDeps): () => void {
  const { attention, connections } = deps
  dispatcher.register(
    'presence',
    HOST_METHOD_SCHEMAS.presence.params,
    METHOD_ROLES.presence ?? [],
    (params, { clientId }): HostMethods['presence']['result'] => {
      attention.presenceChanged(clientId, presenceOf(params))
      return {}
    }
  )
  return connections.onDetach((connection) => {
    if (connection.role === 'ui') attention.presenceChanged(connection.clientId, 'detached')
  })
}
