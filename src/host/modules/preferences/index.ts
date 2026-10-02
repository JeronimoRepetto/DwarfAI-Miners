// The preferences module (05 §3.12): the Host-read settings in the `host_preferences` singleton
// (INV-105). Cut 1 serves `get` and `set`; secrets (only ever in `SecretStore`, ADR-017),
// integrations, the first-run step, feature flags and Reset metrics join with their issues. It
// imports no other module (05 §1.3, R4).
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { SqlitePreferencesStore } from './adapters/sqlite/SqlitePreferencesStore'
import {
  PreferencesService,
  type PreferencesCommands,
  type PreferencesQueries
} from './application/preferencesService'
import type { PreferencesEvent } from './domain/events'

export type { PreferencesCommands, PreferencesQueries }
export type { HostPreferencesChanged, PreferencesEvent } from './domain/events'
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
