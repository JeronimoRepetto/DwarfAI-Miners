// The preferences module (05 §3.12): the Host-read settings in the `host_preferences` singleton
// (INV-105), the Reset-metrics saga (ADR-023) and the feature flags read once at start (INV-110).
// Cut 1 serves `get`, `set`, `resetMetrics` and the feature flags; the first-run consent step's
// state joins in cut 2 (`createWelcomeStep`, ISSUE-222), and so does the Claude Code hooks toggle
// (`setClaudeHooks`, ISSUE-221); secrets (only ever in `SecretStore`, ADR-017) and the OpenCode
// toggle join with their issues. It imports no
// other module (05 §1.3, R4): the other modules' Reset steps reach the saga as `ResetDbStep`s from
// host/wiring/resetParticipants.ts.
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { PreferencesResetStep } from './adapters/sqlite/PreferencesResetStep'
import { SqliteChannelTokenStore } from './adapters/sqlite/SqliteChannelTokenStore'
import { SqliteIntegrationSettingStore } from './adapters/sqlite/SqliteIntegrationSettingStore'
import { SqlitePreferencesStore } from './adapters/sqlite/SqlitePreferencesStore'
import { SqliteResetJournal } from './adapters/sqlite/SqliteResetJournal'
import { SqliteWelcomeAnswerStore } from './adapters/SqliteWelcomeAnswerStore'
import {
  PreferencesService,
  WelcomeAnswerService,
  WelcomeStepService,
  type CredentialMinter,
  type IntegrationSettingsQueries,
  type MintedCredential,
  type PreferencesCommands,
  type PreferencesQueries,
  type WelcomeAnswer,
  type WelcomeBoot,
  type WelcomeIntegrations,
  type WelcomeQueries,
  type WelcomeSettle
} from './application/preferencesService'
import { OFFERED_FILTER } from './domain/offeredFilter'
import { ResetSaga, type ResetDbMaintenance, type ResetUiFanout } from './application/resetSaga'
import type { PreferencesEvent } from './domain/events'
import type { MetricsResetResult, ResetMetricsCommand } from './domain/resetSaga'
import type { ExternalConfigWriter } from './ports/externalConfigWriter'
import type { ResetDbStep } from './ports/resetJournal'
import type { SecretStore } from './ports/secretStore'
import type { FeatureFlagReader } from './ports/featureFlagReader'
import type { InstalledToolsReader } from './ports/installedToolsReader'

export type {
  CredentialMinter,
  IntegrationSettingsQueries,
  MintedCredential,
  PreferencesCommands,
  PreferencesQueries,
  WelcomeAnswer,
  WelcomeBoot,
  WelcomeIntegrations,
  WelcomeQueries,
  WelcomeSettle
}
export type { ResetDbMaintenance, ResetUiFanout }
export type {
  HostPreferencesChanged,
  IntegrationChanged,
  MetricsResetFailed,
  MetricsResetFinished,
  MetricsResetStarted,
  PreferencesEvent,
  WelcomeStepChanged
} from './domain/events'
export type { WelcomeChoice, WelcomeResult, WelcomeStepState } from './domain/welcomeStep'
export type { InstalledToolsReader } from './ports/installedToolsReader'
export type { WelcomeAnswerStore } from './ports/welcomeAnswerStore'
export type { MetricsResetResult, ResetMetricsCommand, ResetStep } from './domain/resetSaga'
export type { ResetDbStep } from './ports/resetJournal'
export type { SecretStore } from './ports/secretStore'
export type {
  ChannelToken,
  ConfigTarget,
  ConsentOrigin,
  ExternalConfigWriter
} from './ports/externalConfigWriter'
export type { ChannelTokenStore, TokenChannel } from './ports/channelTokenStore'
export type { IntegrationSetting, IntegrationSettingStore } from './ports/integrationSettingStore'
export type { FeatureFlagReader, FeatureFlags } from './ports/featureFlagReader'
export type {
  HostPreferenceKey,
  HostPreferences,
  JevRoutingProfile,
  ProviderId
} from './domain/hostPreferences'

export interface PreferencesDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2). */
  transactions: TransactionRunner
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /** The `host/wiring` reader of the two feature flags (05 §5.1 R9); read once, here (INV-110). */
  featureFlags: FeatureFlagReader
  /** The one config writer (16 §7): the integration toggles write and revert through it. */
  externalConfig: ExternalConfigWriter
  /** The transport's token issuance (lead decision 2026-09-30, ISSUE-198), from host/main.ts. */
  mintCredential: CredentialMinter
}

export interface Preferences {
  commands: PreferencesCommands
  queries: PreferencesQueries & IntegrationSettingsQueries
}

/**
 * The module over the Host database: `host_preferences`, `integration_settings` and
 * `channel_tokens` (09 §4.8).
 */
export function createPreferences(deps: PreferencesDeps): Preferences {
  const service = new PreferencesService({
    store: new SqlitePreferencesStore({ db: deps.db, clock: deps.clock }),
    transactions: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    featureFlags: deps.featureFlags,
    integrations: new SqliteIntegrationSettingStore({ db: deps.db }),
    tokens: new SqliteChannelTokenStore({ db: deps.db, ids: deps.ids }),
    externalConfig: deps.externalConfig,
    mintCredential: deps.mintCredential
  })
  return { commands: service, queries: service }
}

export interface WelcomeStepDeps {
  /** The Host's one writer (09 §8.1), where `app_meta.welcome_answered_at` lives. */
  db: SqliteDatabase
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** The `host/wiring` bridge to the suppliers installed detection (bridges/installedTools.ts). */
  installedTools: InstalledToolsReader
  /** The one config writer; the step only asks its legacy probe (16 §7.1). */
  externalConfig: Pick<ExternalConfigWriter, 'findLegacy'>
}

/**
 * The first-run consent step (07 machine 41; AMENDMENT-7, -9, -10): 16 §4.12
 * `PreferencesQueries.welcome` and its boot evaluation, over `app_meta.welcome_answered_at` and the
 * cut's offered filter. host/wiring/preferencesWiring.ts joins `welcome` to the module's queries,
 * as it joins `resetMetrics` to its commands.
 */
export function createWelcomeStep(
  deps: WelcomeStepDeps
): WelcomeQueries & WelcomeBoot & WelcomeSettle {
  return new WelcomeStepService({
    answers: new SqliteWelcomeAnswerStore({ db: deps.db }),
    installed: deps.installedTools,
    legacy: deps.externalConfig,
    cutFilter: OFFERED_FILTER.offered,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
}

export interface WelcomeAnswerDeps {
  /** The Host's one writer (09 §8.1), where `app_meta.welcome_answered_at` lives. */
  db: SqliteDatabase
  transactions: TransactionRunner
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** The step `createWelcomeStep` built; the answer settles it (07 S41.05). */
  step: WelcomeQueries & WelcomeSettle
  /** The module `createPreferences` built: its toggles' enable path and their stored states. */
  preferences: {
    commands: Pick<PreferencesCommands, 'setClaudeHooks'>
    queries: Pick<PreferencesQueries, 'integrationState'>
  }
  /** The one config writer: its legacy probe and its revert of an old-app entry (16 §7.1, §7.4). */
  externalConfig: Pick<ExternalConfigWriter, 'findLegacy' | 'revert'>
}

/**
 * 16 §4.12 `PreferencesCommands.answerWelcome` (AMENDMENT-7, OQ-68; 07 S41.04, S41.05): the
 * first-run step's one answer. host/wiring joins it to the module's commands (later: ISSUE-323).
 */
export function createWelcomeAnswer(deps: WelcomeAnswerDeps): WelcomeAnswer {
  return new WelcomeAnswerService({
    step: deps.step,
    answers: new SqliteWelcomeAnswerStore({ db: deps.db }),
    legacy: deps.externalConfig,
    integrations: {
      setClaudeHooks: (on, origin) => deps.preferences.commands.setClaudeHooks(on, origin),
      integrationState: (id) => deps.preferences.queries.integrationState(id)
    },
    transactions: deps.transactions,
    cutFilter: OFFERED_FILTER.offered,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
}

/**
 * 16 §4.12 `PreferencesCommands.resetMetrics` (ADR-023 saga). host/wiring/preferencesWiring.ts
 * joins it to `Preferences.commands` when it wires the module into the Host (ISSUE-226).
 */
export interface ResetMetricsCommands {
  resetMetrics(cmd: ResetMetricsCommand): Promise<MetricsResetResult>
}

/**
 * The saga's boot resume (07 S13.08; 16 §8.2 step 3), called by the Host boot before commands and
 * observation: the unfinished saga's result, or `null` when no saga is unfinished.
 */
export interface ResetSagaResume {
  resumeOnBoot(): Promise<MetricsResetResult | null>
}

export interface ResetSagaModuleDeps {
  /** The Host's one writer (09 §8.1), where `reset_journal` lives. */
  db: SqliteDatabase
  transactions: TransactionRunner
  /** Every module's `ResetDbStep`, in the 09 §7.2 order (host/wiring/resetParticipants.ts). */
  dbSteps: readonly ResetDbStep[]
  /** The ledger's install-moment step (host/wiring/resetParticipants.ts). */
  installMoment: ResetDbStep
  /** The `db` step's post-commit cleanup (host/platform/sqlite/resetCleanup.ts). */
  maintenance: ResetDbMaintenance
  secrets: SecretStore
  externalConfig: ExternalConfigWriter
  /** The attached UIs (host/transport/methods/resetMetrics.ts). */
  ui: ResetUiFanout
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

/** The Reset-metrics saga over the Host database's `reset_journal` (16 §4.12). */
export function createResetSaga(deps: ResetSagaModuleDeps): ResetMetricsCommands & ResetSagaResume {
  const { db, clock, ids, ...rest } = deps
  return new ResetSaga({
    ...rest,
    clock,
    ids,
    journal: new SqliteResetJournal({ db, clock, ids })
  })
}

/** The preferences module's own `ResetDbStep`: `host_preferences` to its defaults (09 §7.2). */
export function createPreferencesResetStep(deps: {
  db: SqliteDatabase
  clock: Clock
}): ResetDbStep {
  return new PreferencesResetStep(deps)
}
