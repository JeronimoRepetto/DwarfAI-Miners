// B-M03 `events.subscribe` (14 §2.3, §3.4; ADR-003 items 7–8, frozen): a `ui` or `viewer`
// connection subscribes first, then reads the snapshot (14 §1.9). The result is `live`,
// `replaying` (the missed frames follow) or `resync-required` (a `resync-required` frame follows),
// as the frame publisher decides (events/framePublisher.ts); the frames that follow are released
// right after the result was handed to the connection's writer (`afterAnswer`). A `notifier` gets FORBIDDEN
// from the role table: it receives its frames without subscribing (14 §2.3 "Notifier scope").
//
// A resync is logged `channel.resync` with its cause class only (19 §9.2; 14 §1.10).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { ConnectionRegistry } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { RESYNC_CAUSE_CLASS } from '../events/framePublisher'
import { METHOD_ROLES } from '../roles'

export interface EventsSubscribeDeps {
  connections: ConnectionRegistry
  /** This boot's epoch: a `resume` from another epoch is never replayed (14 §4.3 rule 3). */
  epoch: string
  log: DiagnosticsLog
}

/** Serves `events.subscribe` on `dispatcher`. */
export function registerEventsSubscribe(dispatcher: Dispatcher, deps: EventsSubscribeDeps): void {
  dispatcher.register(
    'events.subscribe',
    HOST_METHOD_SCHEMAS['events.subscribe'].params,
    METHOD_ROLES['events.subscribe'] ?? [],
    (params, context): HostMethods['events.subscribe']['result'] => {
      const outcome = deps.connections.subscribe(context.clientId, params, deps.epoch)
      if (outcome.reason !== undefined) {
        deps.log.record({
          level: 'info',
          event: 'channel.resync',
          subsystem: 'transport',
          causeClass: RESYNC_CAUSE_CLASS[outcome.reason],
          role: context.role,
          connId: context.clientId
        })
      }
      context.afterAnswer(outcome.release)
      return outcome.result
    }
  )
}
