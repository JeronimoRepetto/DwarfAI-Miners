// B-M15 `preferences.resetMetrics`, B-M09 `ui.resetPreferences.ack`, and the frames of the Reset
// saga: B-F26 `ui.resetPreferences`, B-F27 `reset.progress` and B-F03 `resync-required
// {metrics-reset}` (14 §2.3, §2.4, §1.9, §6.3 "Reset saga progress"; ADR-023 items 4–5; 07 machine
// 13). host/wiring/preferencesWiring.ts registers them (ISSUE-226).
//
// - B-M15 is `ui` only (roles.ts) and mutating: a repeated `requestId` gets the first answer with
//   no second effect (dispatcher.ts, 14 §1.6). Its params are the contract's strict() schema, so a
//   `confirmed` other than `'yes'` is INVALID_PARAMS before the saga runs (ADR-019). It answers the
//   saga's `MetricsResetResult`: `reset` only at `done`, `failed` with `resumesOnNextStart`.
// - `MetricsResetStarted` (the `db` commit) becomes `resync-required {metrics-reset}` for every `ui`
//   connection, so no attached UI keeps a hard-deleted mine, dwarf or message (14 §1.9; I-04).
// - `ConnectionResetUiFanout` is the saga's way to the attached UIs: `reset.progress` per step, and
//   `ui.resetPreferences {epoch}` to every `ui` connection attached at that moment, settling once
//   each of them acked with B-M09 for that epoch or detached (07 S13.04, S13.05). There is no ack
//   timeout (07 §24 I-14). A UI that was not attached learns the epoch from the snapshot `meta`
//   section at attach (14 §4.3 rule 4, S13.09); its ack then finds no pending reset and changes
//   nothing. B-M09 is idempotent by its shape and carries no requestId.
import {
  HOST_METHOD_SCHEMAS,
  type HostFrameName,
  type HostMethods,
  type ResetId
} from '@dwarfai/contracts'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type {
  PreferencesEvent,
  ResetMetricsCommands,
  ResetStep,
  ResetUiFanout
} from '../../modules/preferences'
import type { ConnectionRegistry } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { RESYNC_CAUSE_CLASS } from '../events/framePublisher'
import { METHOD_ROLES } from '../roles'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const RESET_FRAMES: readonly HostFrameName[] = Object.freeze([
  'ui.resetPreferences',
  'reset.progress'
])

/** One `ui.resetPreferences` waiting for its acks. */
interface PendingReset {
  epoch: number
  waiting: Set<string>
  settle(): void
}

export class ConnectionResetUiFanout implements ResetUiFanout {
  private pending: PendingReset | null = null

  constructor(private readonly connections: ConnectionRegistry) {
    connections.onDetach((connection) => this.leave(connection.clientId))
  }

  progress(progress: { resetId: string; epoch: number; step: ResetStep }): void {
    this.connections.publish('reset.progress', {
      resetId: progress.resetId as ResetId,
      epoch: progress.epoch,
      step: progress.step
    })
  }

  resetPreferences(epoch: number): Promise<void> {
    const waiting = new Set(
      this.connections
        .connections()
        .filter((connection) => connection.role === 'ui')
        .map((connection) => connection.clientId)
    )
    const done = new Promise<void>((resolve) => {
      this.pending = { epoch, waiting, settle: resolve }
    })
    this.connections.publish('ui.resetPreferences', { epoch })
    this.settleWhenNoneLeft()
    return done
  }

  /** B-M09 from `clientId` for `epoch`. */
  acked(clientId: string, epoch: number): void {
    if (this.pending?.epoch !== epoch) return
    this.leave(clientId)
  }

  private leave(clientId: string): void {
    if (this.pending?.waiting.delete(clientId) !== true) return
    this.settleWhenNoneLeft()
  }

  private settleWhenNoneLeft(): void {
    const pending = this.pending
    if (pending === null || pending.waiting.size > 0) return
    this.pending = null
    pending.settle()
  }
}

export interface ResetMetricsMethodsDeps {
  reset: ResetMetricsCommands
  fanout: ConnectionResetUiFanout
}

/** Serves `preferences.resetMetrics` (B-M15) and `ui.resetPreferences.ack` (B-M09) on `dispatcher`. */
export function registerResetMetrics(dispatcher: Dispatcher, deps: ResetMetricsMethodsDeps): void {
  dispatcher.registerMutating(
    'preferences.resetMetrics',
    HOST_METHOD_SCHEMAS['preferences.resetMetrics'].params,
    METHOD_ROLES['preferences.resetMetrics'] ?? [],
    (params): Promise<HostMethods['preferences.resetMetrics']['result']> =>
      deps.reset.resetMetrics({ confirmed: params.confirmed })
  )
  dispatcher.register(
    'ui.resetPreferences.ack',
    HOST_METHOD_SCHEMAS['ui.resetPreferences.ack'].params,
    METHOD_ROLES['ui.resetPreferences.ack'] ?? [],
    (params, context): HostMethods['ui.resetPreferences.ack']['result'] => {
      deps.fanout.acked(context.clientId, params.epoch)
      return {}
    }
  )
}

/**
 * Routes `MetricsResetStarted` to `resync-required {metrics-reset}` (B-F03) for every `ui`
 * connection, logged `channel.resync`; returns the unsubscribe.
 */
export function publishResetFrames(
  bus: DomainEventBus<PreferencesEvent>,
  connections: ConnectionRegistry,
  log: DiagnosticsLog
): () => void {
  return bus.subscribe('MetricsResetStarted', () => {
    connections.publish('resync-required', { reason: 'metrics-reset' })
    log.record({
      level: 'info',
      event: 'channel.resync',
      subsystem: 'transport',
      causeClass: RESYNC_CAUSE_CLASS['metrics-reset']
    })
  })
}
