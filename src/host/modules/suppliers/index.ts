// The suppliers module (05 §3.4): the open provider catalog, the driver registry and the one
// ProviderDriver contract of ADR-009, whose types this file re-exports (never redefines): catalogue
// `launchable` (installed detection through the one `InstallResolver`, ISSUE-146), `entry` /
// `capabilities` as the effective values of the capability merge, probe and integration gate
// (ISSUE-147), `DriverRegistry` with the SimulatedDriver attached in
// development builds, `SessionChannels` over the sessions the registry's drivers opened. The
// drivers of the person's own CLIs join with their process deps (`cliDrivers`, ISSUE-182); wiring
// into `host/main.ts` is ISSUE-159.
import type { HostEpoch, LaunchId, ProviderId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { ProcessControl } from '../../kernel/ports/processControl'
import type { Scheduler } from '../../kernel/ports/scheduler'
import {
  CATALOG_RECORDS,
  OPENCODE_ACP,
  SIMULATED_CAPABILITIES,
  SIMULATED_RECORD
} from './adapters/catalog/profiles'
import { AcpDriver } from './adapters/drivers/acp/AcpDriver'
import { ClaudeStreamJsonDriver } from './adapters/drivers/claude-stream-json/ClaudeStreamJsonDriver'
import type { McpConfigFiles } from './adapters/drivers/claude-stream-json/mcpConfigFile'
import type { PromptToolDeps } from './adapters/drivers/claude-stream-json/promptTool'
import { AntigravityNdjsonDriver } from './adapters/drivers/antigravity-ndjson/AntigravityNdjsonDriver'
import { CodexAppServerDriver } from './adapters/drivers/codex-app-server/CodexAppServerDriver'
import { HostedCommandDriver } from './adapters/drivers/hosted-command/HostedCommandDriver'
import { HOSTED_COMMAND_PROFILE } from './adapters/drivers/hosted-command/profile'
import type { LoginEnvironment } from './adapters/drivers/shared/childEnv'
import { SimulatedDriver } from './adapters/drivers/simulated/SimulatedDriver'
import { CatalogDriverRegistry } from './adapters/registry/CatalogDriverRegistry'
import { createSupplierCatalogue, type SupplierCatalogueQueries } from './application/catalogue'
import { createInstallDetection, type InstallDetection } from './application/detection'
import { createCapabilityProbing } from './application/probe'
import {
  trackLiveSessions,
  type SessionBindings,
  type SessionChannels,
  type SessionReleases
} from './application/sessionChannels'
import type { SuppliersEvent } from './domain/events'
import { recordsForBuild, type CatalogRecord, type DriverTransport } from './domain/profile'
import type { CapabilityRecordStore } from './ports/capabilityRecordStore'
import type { DriverRegistry } from './ports/driverRegistry'
import type { ProviderDriver, SessionRef } from './ports/providerDriver'
import type { InstallResolver } from './ports/installResolver'
import type { IntegrationGateReader } from './ports/integrationGateReader'
import type { SuppliedEventSink } from './ports/suppliedEventSink'

// ADR-009 D1–D3 and the 15 §1.2 supporting types: every other module imports them from here.
export type {
  CatalogRecord,
  PermissionModeCatalog,
  DriverTransport,
  ModelEntry,
  PermissionModeId,
  PermissionModeSpec,
  ProviderId,
  ProviderPolicy,
  ProviderProfile,
  SessionOwnership
} from './domain/profile'
export type {
  CapabilityCeiling,
  ObservedCapabilities,
  ProviderCapabilities
} from './domain/capabilities'
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
  TurnEndedInput,
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
export type { InstallResolver } from './ports/installResolver'
export type { CapabilityRecordStore } from './ports/capabilityRecordStore'
export type { IntegrationGateReader } from './ports/integrationGateReader'
export type { ProviderCapabilitiesRecorded, SuppliersEvent } from './domain/events'
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
export type { SupplierCatalogueQueries, SupplierEntry } from './application/catalogue'
export type {
  SessionBindings,
  SessionChannels,
  SessionReleases
} from './application/sessionChannels'
export type {
  SuppliedEvent,
  SuppliedEventDelivery,
  SuppliedEventSink
} from './ports/suppliedEventSink'

/**
 * The provider id of the "Other…" launch way (15 §4.11): the id its sessions and launch records
 * carry. Never a catalog id (INV-43): `entry()` and `launchable()` never answer it.
 */
export const HOSTED_COMMAND_PROVIDER_ID: ProviderId = HOSTED_COMMAND_PROFILE.id

/** What the "Other…" `HostedCommandDriver` spawns with (15 §4.11), bound by `host/main.ts`. */
export interface HostedCommandDeps {
  readonly processControl: ProcessControl
  /** The person's login environment `childEnv` copies the allowlisted variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  readonly platform: NodeJS.Platform
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound by the root (R9). */
  readonly redact: (text: string) => string
}

/**
 * What the drivers of the person's own CLIs spawn with (ISSUE-182), bound by `host/main.ts`: the
 * Codex app-server driver (15 §4.4) and, once its permission prompt tool is composed, Claude's
 * stream-json driver (15 §4.2; AMENDMENT-21). Each is attached for the catalog record whose
 * profile lists its transport (ADR-009 D4), never by a provider id (R12).
 */
export interface CliDriverDeps {
  readonly processControl: ProcessControl
  /** The person's login environment `childEnv` copies the allowlisted variables from (15 §4). */
  readonly loginEnv: LoginEnvironment
  /** The folder a `--help` probe runs in (the person's home). */
  readonly home: string
  readonly platform: 'win32' | 'darwin' | 'linux'
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound by the root (R9). */
  readonly redact: (text: string) => string
  /** `initialize.clientInfo` of the Codex app-server: who DwarfAI is to the server. */
  readonly clientInfo: { readonly name: string; readonly version: string }
  /**
   * What a restarted Host's resume reads of the stored launch record (ISSUE-173): the folder and
   * the spawn tag of a session this Host's driver did not launch (wiring/bridges/resumeContext.ts).
   */
  readonly resumeContext: (
    ref: SessionRef
  ) => { cwd: string; spawnTag: string; launchId?: LaunchId } | null
  /**
   * Claude's permission prompt tool (AMENDMENT-21): its `--mcp-config` files and the relay. Absent,
   * the stream-json driver is not attached: a session without the tool would deny every tool use
   * unseen, so nothing is offered that is not built (21 §1 item 8).
   */
  readonly claudeStreamJson?: {
    readonly mcpConfig: { readonly dir: string; readonly files: McpConfigFiles }
    readonly promptTool: PromptToolDeps
  }
}

export interface SuppliersDeps {
  /** `CATALOG_PROVIDER_IDS`, handed over by `host/main.ts` (R9): every profile id must be in it. */
  readonly catalogIds: readonly ProviderId[]
  /** The build-time flag of ADR-009 D6; a public build also drops the simulated provider. */
  readonly publicBuild: boolean
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** The SimulatedDriver's seed: the same seed replays the same run. */
  readonly simulatedSeed: string
  /** Where driver events go, each with its bound dwarf (`host/wiring`, ISSUE-159). */
  readonly sink: SuppliedEventSink
  /** The one resolver behind every `detect()` (ADR-009 D5): `CliInstallResolver` in the Host. */
  readonly installResolver: InstallResolver
  /** Detection revalidates its cache by the `stat` mtime of each resolved path (ADR-009 D5). */
  readonly fs: Pick<FileSystem, 'stat'>
  /** Measured capabilities with provider version and date (NFR-OBS-04); SQLite in ISSUE-148. */
  readonly capabilityRecords: CapabilityRecordStore
  /** The answer-channel gate: a `host/wiring` bridge to `preferences.integrationState` (ADR-011 item 7). */
  readonly integrationGate: IntegrationGateReader
  /** Where `ProviderCapabilitiesRecorded` goes (08 §0). */
  readonly bus: Pick<DomainEventBus<SuppliersEvent>, 'publish'>
  readonly ids: IdGenerator
  readonly hostEpoch: HostEpoch
  /**
   * The "Other…" driver's process deps (ISSUE-165). Absent, no "Other…" driver is attached and a
   * custom launch settles `not-installed` (a composition that launches no custom command).
   */
  readonly hostedCommand?: HostedCommandDeps
  /** The person's own CLIs' drivers (ISSUE-182). Absent, none is attached. */
  readonly cliDrivers?: CliDriverDeps
}

export interface Suppliers {
  readonly catalogue: SupplierCatalogueQueries
  readonly sessions: SessionChannels
  /** Launching binds each session to its dwarf (ADR-015 item 7); events wait for it. */
  readonly bindings: SessionBindings
  /** A launch that failed after its session was handed out releases it unbound (GitHub #1316). */
  readonly releases: SessionReleases
  /** The registry launching uses; every session its drivers open is reachable through `sessions`. */
  readonly registry: DriverRegistry
}

export function createSuppliers(deps: SuppliersDeps): Suppliers {
  const records = recordsForBuild(CATALOG_RECORDS, deps)
  const drivers: ProviderDriver[] = records.includes(SIMULATED_RECORD)
    ? [
        new SimulatedDriver({
          profile: SIMULATED_RECORD.profile,
          transport: 'acp',
          capabilities: SIMULATED_CAPABILITIES,
          seed: deps.simulatedSeed,
          clock: deps.clock,
          scheduler: deps.scheduler
        })
      ]
    : []
  if (deps.hostedCommand !== undefined) {
    // "Other…" (ISSUE-165): served outside the catalog (INV-43), tracked like every driver below.
    drivers.push(
      new HostedCommandDriver({
        ...deps.hostedCommand,
        clock: deps.clock,
        scheduler: deps.scheduler
      })
    )
  }
  // One install detection behind every `detect()`, the catalogue's and each driver's (ADR-009 D5).
  const detection = createInstallDetection({
    resolver: deps.installResolver,
    fs: deps.fs,
    scheduler: deps.scheduler
  })
  if (deps.cliDrivers !== undefined) {
    drivers.push(...cliDrivers(records, detection, deps, deps.cliDrivers))
  }
  const registry = new CatalogDriverRegistry({
    catalogIds: deps.catalogIds,
    records,
    drivers,
    publicBuild: deps.publicBuild
  })
  const tracked = trackLiveSessions(registry, { sink: deps.sink, clock: deps.clock })
  return {
    catalogue: createSupplierCatalogue({
      records,
      publicBuild: deps.publicBuild,
      detection,
      // Probing only detects and probes: it never launches, so it reads the plain registry.
      probing: createCapabilityProbing({
        registry,
        store: deps.capabilityRecords,
        clock: deps.clock,
        scheduler: deps.scheduler,
        bus: deps.bus,
        ids: deps.ids,
        hostEpoch: deps.hostEpoch
      }),
      gate: deps.integrationGate,
      scheduler: deps.scheduler
    }),
    sessions: tracked.channels,
    bindings: tracked.bindings,
    releases: tracked.releases,
    registry: tracked.registry
  }
}

/** The CLI drivers of this build's records, each for the record whose profile lists its transport. */
function cliDrivers(
  records: readonly CatalogRecord[],
  detection: InstallDetection,
  deps: SuppliersDeps,
  cli: CliDriverDeps
): ProviderDriver[] {
  const recordOf = (transport: DriverTransport): CatalogRecord | undefined =>
    records.find((record) => record.profile.drivers.includes(transport))
  const shared = {
    detection,
    processControl: cli.processControl,
    clock: deps.clock,
    scheduler: deps.scheduler,
    loginEnv: cli.loginEnv,
    home: cli.home,
    platform: cli.platform,
    redact: cli.redact,
    resumeContext: cli.resumeContext
  }
  const attached: ProviderDriver[] = []
  const codex = recordOf('app-server-rpc')
  if (codex !== undefined) {
    attached.push(
      new CodexAppServerDriver({ ...shared, record: codex, clientInfo: cli.clientInfo })
    )
  }
  // Antigravity (ISSUE-188, step 3e; the driver of ISSUE-156): attached in every build, as the
  // registry and the catalogue apply its `publicLaunch: 'gated'` from the one build flag (ADR-009 D6):
  // a public build launches nothing through it, a development build launches the person's own agy.
  const antigravity = recordOf('ndjson')
  if (antigravity !== undefined) {
    attached.push(new AntigravityNdjsonDriver({ ...shared, record: antigravity }))
  }
  // OpenCode (ISSUE-238, step 4b; the driver of ISSUE-155): the generic `AcpDriver` over the person's own
  // `opencode acp`, configured by `OPENCODE_ACP` alone (15 §4.7; ADR-009 D4 option (c)), for the one record whose
  // profile lists the `http-server` transport (OpenCode's). S-031-3 failed, so `OpenCodeServerDriver` offers no
  // launch (its probe reports `launch: false`, FM-084) and is not attached: launching takes the registry's first
  // driver (ADR-009 D4), which must be the one that launches. The answer-channel gate of the profile applies (15 §2.1,
  // ADR-011 item 7): a permission request is a card only while `opencode-permissions` is `on-verified`.
  const opencode = recordOf('http-server')
  if (opencode !== undefined) {
    attached.push(new AcpDriver({ ...shared, record: opencode, ...OPENCODE_ACP }))
  }
  const claude = recordOf('stream-json')
  if (claude !== undefined && cli.claudeStreamJson !== undefined) {
    attached.push(
      new ClaudeStreamJsonDriver({
        ...shared,
        record: claude,
        ids: deps.ids,
        mcpConfig: cli.claudeStreamJson.mcpConfig,
        promptTool: cli.claudeStreamJson.promptTool
      })
    )
  }
  return attached
}
