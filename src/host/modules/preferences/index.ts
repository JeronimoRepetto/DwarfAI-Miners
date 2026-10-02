// The preferences module (05 §3.12): the Host-read settings in the `host_preferences` singleton
// (INV-105) and the Reset-metrics saga (ADR-023). Cut 1 serves `get`, `set` and `resetMetrics`;
// secrets (only ever in `SecretStore`, ADR-017), integrations, the first-run step and feature flags
// join with their issues. It imports no other module (05 §1.3, R4): the other modules' Reset steps
// reach the saga as `ResetDbStep`s from host/wiring/resetParticipants.ts.
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { PreferencesResetStep } from './adapters/sqlite/PreferencesResetStep'
import { SqlitePreferencesStore } from './adapters/sqlite/SqlitePreferencesStore'
import { SqliteResetJournal } from './adapters/sqlite/SqliteResetJournal'
import {
  PreferencesService,
  type PreferencesCommands,
  type PreferencesQueries
} from './application/preferencesService'
import { ResetSaga, type ResetDbMaintenance, type ResetUiFanout } from './application/resetSaga'
import type { PreferencesEvent } from './domain/events'
import type { MetricsResetResult, ResetMetricsCommand } from './domain/resetSaga'
import type { ExternalConfigWriter } from './ports/externalConfigWriter'
import type { ResetDbStep } from './ports/resetJournal'
import type { SecretStore } from './ports/secretStore'

export type { PreferencesCommands, PreferencesQueries }
export type { ResetDbMaintenance, ResetUiFanout }
export type {
  HostPreferencesChanged,
  MetricsResetFailed,
  MetricsResetFinished,
  MetricsResetStarted,
  PreferencesEvent
} from './domain/events'
export type { MetricsResetResult, ResetMetricsCommand, ResetStep } from './domain/resetSaga'
export type { ResetDbStep } from './ports/resetJournal'
export type { SecretStore } from './ports/secretStore'
export type { ExternalConfigWriter } from './ports/externalConfigWriter'
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
}

export interface Preferences {
  commands: PreferencesCommands
  queries: PreferencesQueries
}

/** The module over the Host database. */
export function createPreferences(deps: PreferencesDeps): Preferences {
  const service = new PreferencesService({
    store: new SqlitePreferencesStore({ db: deps.db, clock: deps.clock }),
    transactions: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  return { commands: service, queries: service }
}

/**
 * 16 §4.12 `PreferencesCommands.resetMetrics` (ADR-023 saga). It joins `Preferences.commands`
 * when the module is wired into the Host (later: ISSUE-226).
 */
export interface ResetMetricsCommands {
  resetMetrics(cmd: ResetMetricsCommand): Promise<MetricsResetResult>
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
export function createResetSaga(deps: ResetSagaModuleDeps): ResetMetricsCommands {
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
