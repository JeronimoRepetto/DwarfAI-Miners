// The suppliers module (05 §3.4): the open provider catalog, the driver registry and the one
// ProviderDriver contract of ADR-009, whose types this file re-exports (never redefines). Skeleton
// (ISSUE-143): catalogue `entry` / `capabilities` over the catalog records, `DriverRegistry` with
// the SimulatedDriver attached in development builds, `SessionChannels` over the sessions the
// registry's drivers opened. Detection, probe and merge, `launchable()` and the real drivers come
// later (ISSUE-146…163); wiring into `host/main.ts` is ISSUE-159.
import type { ProviderId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { Scheduler } from '../../kernel/ports/scheduler'
import { CATALOG_RECORDS, SIMULATED_RECORD } from './adapters/catalog/profiles'
import { SimulatedDriver } from './adapters/drivers/simulated/SimulatedDriver'
import { CatalogDriverRegistry } from './adapters/registry/CatalogDriverRegistry'
import { createSupplierCatalogue, type SupplierCatalogueSkeleton } from './application/catalogue'
import { trackLiveSessions, type SessionChannels } from './application/sessionChannels'
import { recordsForBuild } from './domain/profile'
import type { DriverRegistry } from './ports/driverRegistry'

// ADR-009 D1–D3 and the 15 §1.2 supporting types: every other module imports them from here.
export type {
  CatalogRecord,
  DriverTransport,
  ModelEntry,
  PermissionModeId,
  PermissionModeSpec,
  ProviderId,
  ProviderPolicy,
  ProviderProfile,
  SessionOwnership
} from './domain/profile'
export type { ObservedCapabilities, ProviderCapabilities } from './domain/capabilities'
export type {
  ActivityStep,
  AskInput,
  CloseOutcome,
  ConversationEntry,
  DelegationInjection,
  DetectResult,
  DriverErrorCause,
  DriverEvent,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverResumeError,
  DriverSendError,
  DriverSession,
  InstalledProvider,
  MessageInput,
  ObservationAdapter,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput,
  UsageObservationInput
} from './ports/providerDriver'
export type { DriverRegistry } from './ports/driverRegistry'
// The kernel owner types the D3 contract names (05 §2.2, revised 2026-09-30).
export type {
  AnswerOutcome,
  AnswerRefusalReason,
  Fidelity,
  LaunchFailureCause,
  PermissionPayload,
  QuestionAnswers,
  QuestionPayload,
  QuestionStep,
  SourceKey,
  TurnEndKind,
  TurnEnded,
  UsageObservation
} from '../../kernel/domain/sharedContracts'
export type {
  SupplierCatalogueQueries,
  SupplierCatalogueSkeleton,
  SupplierEntry
} from './application/catalogue'
export type { SessionChannels } from './application/sessionChannels'

export interface SuppliersDeps {
  /** `CATALOG_PROVIDER_IDS`, handed over by `host/main.ts` (R9): every profile id must be in it. */
  readonly catalogIds: readonly ProviderId[]
  /** The build-time flag of ADR-009 D6; a public build also drops the simulated provider. */
  readonly publicBuild: boolean
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The SimulatedDriver's seed: the same seed replays the same run. */
  readonly simulatedSeed: string
}

export interface Suppliers {
  readonly catalogue: SupplierCatalogueSkeleton
  readonly sessions: SessionChannels
  /** The registry launching uses; every session its drivers open is reachable through `sessions`. */
  readonly registry: DriverRegistry
}

export function createSuppliers(deps: SuppliersDeps): Suppliers {
  const records = recordsForBuild(CATALOG_RECORDS, deps)
  const drivers = records.includes(SIMULATED_RECORD)
    ? [
        new SimulatedDriver({
          profile: SIMULATED_RECORD.profile,
          transport: 'acp',
          capabilities: SIMULATED_RECORD.ceiling,
          seed: deps.simulatedSeed,
          clock: deps.clock,
          scheduler: deps.scheduler
        })
      ]
    : []
  const tracked = trackLiveSessions(
    new CatalogDriverRegistry({
      catalogIds: deps.catalogIds,
      records,
      drivers,
      publicBuild: deps.publicBuild
    })
  )
  return {
    catalogue: createSupplierCatalogue({ records }),
    sessions: tracked.channels,
    registry: tracked.registry
  }
}
