// The jev module (05 §3.9): Jev's routing for launches and delegated subtasks. Its one door (R15):
// other modules' ports and the Host wiring import only from here. It owns the transient
// `JevSuggestion` (never persisted, INV-87) and the routing tables; it reads the routing profile and
// the configured default along the jev → preferences edge, and the launchable providers through
// `RoutingCatalogSource` (05 §5.2 `EDGES`: jev → suppliers, preferences).
//
// The Host composition root constructs it with `TypesafeJevRouter` and the `RoutingCatalogSource`
// bridge (later: ISSUE-196); the transport serves `jev.suggest` over it (B-M38).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { SecretReader } from '../../kernel/ports/secretReader'
import type { PreferencesQueries } from '../preferences'
import { createJevAdvisor, type AbortableJevAdvisor } from './application/jevAdvisor'
import type { JevCapabilityTable } from './domain/routeDecision'
import type { JevRouter, RoutingCatalogSource } from './ports/jevRouter'

export type {
  AbortableJevAdvisor,
  JevAdvisor,
  JevAdvisorError,
  JevSuggestOptions,
  JevSuggestionView
} from './application/jevAdvisor'
export type { JevRouter, RoutingCatalogSource } from './ports/jevRouter'
export type { JevRoutingProfile } from './domain/suggestion'

export interface JevDeps {
  router: JevRouter
  /** The kernel `SecretReader` the Jev key is read through, per suggestion (ADR-017 item 3). */
  secretReader: SecretReader
  routingCatalog: RoutingCatalogSource
  preferences: Pick<PreferencesQueries, 'get'>
  log: DiagnosticsLog
  /** The capability table, when the composition derives one (OpenCode's live catalogue). */
  capabilities?: JevCapabilityTable
}

export interface Jev {
  advisor: AbortableJevAdvisor
}

export function createJev(deps: JevDeps): Jev {
  return {
    advisor: createJevAdvisor({
      router: deps.router,
      secrets: deps.secretReader,
      routingCatalog: deps.routingCatalog,
      preferences: deps.preferences,
      log: deps.log,
      ...(deps.capabilities === undefined ? {} : { capabilities: deps.capabilities })
    })
  }
}
