// The preferences module's event routes to the transport (05 §4 "event routes"; 14 §2.4):
//
// - `HostPreferencesChanged` and `WelcomeStepChanged` → B-F24 `preferences.changed` to every `ui`
//   connection (transport/methods/preferences.ts `publishPreferencesChanged`; ADR-024 D9; 07
//   S41.05 "→ preferences.changed"; ISSUE-222);
// - `IntegrationChanged` → B-F25 `integration.changed` to every `ui` connection
//   (transport/methods/setClaudeHooks.ts `publishIntegrationChanged`; 05 §4; ISSUE-221);
// - `MetricsResetStarted` → B-F03 `resync-required {metrics-reset}` (transport/methods/resetMetrics.ts
//   `publishResetFrames`; 14 §1.9);
// - the Reset saga's way to the attached UIs, B-F27 `reset.progress` and B-F26 `ui.resetPreferences`,
//   through the `ConnectionResetUiFanout` that also takes the B-M09 acks (14 §6.3).
//
// One rule is the wiring's: a saga resumed by the boot (16 §8.2 step 3, before `ready`) does not
// send B-F26 or wait for an ack. No command is answered before `ready` (14 §3.3 HOST_NOT_READY), so
// a UI attached while the Host is `starting` could never ack, and the boot would never reach
// `ready`. Such a UI learns the new epoch from the snapshot `meta` section once it is served (14
// §4.3 rule 4; 07 S13.09), like a UI that was not attached; `reset.progress` still reaches it.
//
// Later routes of preferences events join this file with their issues (later: ISSUE-140,
// ISSUE-323, ISSUE-324).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type {
  IntegrationSettingsQueries,
  PreferencesEvent,
  PreferencesQueries,
  ResetUiFanout,
  WelcomeQueries
} from '../../modules/preferences'
import type { ConnectionRegistry } from '../../transport/connectionRegistry'
import { publishPreferencesChanged } from '../../transport/methods/preferences'
import { publishIntegrationChanged } from '../../transport/methods/setClaudeHooks'
import {
  publishResetFrames,
  type ConnectionResetUiFanout
} from '../../transport/methods/resetMetrics'

export interface PreferencesRoutesDeps {
  bus: DomainEventBus<PreferencesEvent>
  connections: ConnectionRegistry
  log: DiagnosticsLog
  /** The fanout B-M09 `ui.resetPreferences.ack` lands in (registered with the method). */
  acks: ConnectionResetUiFanout
  /** Whether the Host answers commands: its lifecycle state is `ready`. */
  ready: () => boolean
  /**
   * The module's queries, for the view `WelcomeStepChanged` is sent with and the consent origin
   * `integration.changed` carries.
   */
  queries: Pick<PreferencesQueries, 'get'> & WelcomeQueries & IntegrationSettingsQueries
}

/** Routes the module's events; returns the saga's `ResetUiFanout`, with the boot rule above. */
export function routePreferences(deps: PreferencesRoutesDeps): ResetUiFanout {
  const { acks } = deps
  publishPreferencesChanged(deps.bus, deps.connections, deps.queries)
  publishIntegrationChanged(deps.bus, deps.connections, deps.queries)
  publishResetFrames(deps.bus, deps.connections, deps.log)
  return {
    progress: (progress) => acks.progress(progress),
    resetPreferences: (epoch) => (deps.ready() ? acks.resetPreferences(epoch) : Promise.resolve())
  }
}
