// The preferences module's wiring (05 §3.12, §4; 16 §4.12, §8.2), run by boot step 3 over the
// database step 2 opened and the adapters the composition root built (`host/main.ts`, the only file
// that `new`s them, R6). It constructs the module first, because step 3 resumes an unfinished Reset
// saga before the rest is constructed and before any command is accepted (05 §2.3; ADR-023 item 4;
// 07 S13.08):
//
// - `createPreferences` with the wiring `FeatureFlagReader` (ISSUE-211), and the Reset saga with the
//   participant list of resetParticipants.ts (ISSUE-212); `resetMetrics` joins the module's
//   commands here (16 §4.12 `PreferencesCommands.resetMetrics`);
// - its seam-B members (14 §2.3 B-M12, B-M13, B-M15, B-M09) registered on the Host dispatcher, its
//   snapshot section (14 §4.1), and its event routes (routes/preferencesRoutes.ts: B-F24, B-F03,
//   B-F26, B-F27);
// - the bridges other modules read it through, never by a module import (R4): the kernel
//   `SecretReader` and the suppliers `IntegrationGateReader` (bridges/).
//
// Until later steps wire them, three bindings of cut 1 stand in, each the true value while nothing
// exists to read or write (fail closed):
// - `unavailableSecretStore`: the Host has no OS secret store yet (`OsKeyringSecretStore`, later:
//   ISSUE-324). Nothing can have been stored, so the saga's `secrets` step completes as a no-op
//   (`delete` resolves `'unavailable'`, ADR-017 items 5, 7; AMENDMENT-2), and `set` refuses.
// - `noOwnedConfigWriter`: DwarfAI owns no entry in another tool's config yet (the Claude hooks and
//   OpenCode writers, later: ISSUE-218…ISSUE-221, ISSUE-323): with no active `config_writes` row
//   the `external-config` step is a no-op (lead decision 2026-09-30, ISSUE-212), and nothing is
//   installed.
// - `emptyLedgerInstallMoment`: the ledger module, which owns `install_moment`, is not built yet
//   (later: ISSUE-096 binds `LedgerRepository.setInstallMoment`, ISSUE-121 registers its step), so
//   the `install-moment` step writes nothing, as no ledger step deletes the moment either.
import type { HostEpoch } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { SecretReader } from '../kernel/ports/secretReader'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type { TransactionScope } from '../kernel/ports/transactionScope'
import { createAttentionResetStep } from '../modules/attention'
import {
  createPreferences,
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type FeatureFlagReader,
  type MetricsResetResult,
  type Preferences,
  type PreferencesCommands,
  type PreferencesEvent,
  type ResetDbMaintenance,
  type ResetMetricsCommands,
  type SecretStore
} from '../modules/preferences'
import type { IntegrationGateReader } from '../modules/suppliers'
import type { ConnectionRegistry } from '../transport/connectionRegistry'
import type { Dispatcher } from '../transport/dispatcher'
import { preferencesSection, registerPreferences } from '../transport/methods/preferences'
import { registerResetMetrics } from '../transport/methods/resetMetrics'
import type { SectionRegistry } from '../transport/snapshot/sectionRegistry'
import { preferencesIntegrationGate } from './bridges/integrationGateReader'
import { failClosedSecretReader } from './bridges/secretReader'
import { resetParticipants, type LedgerInstallMoment } from './resetParticipants'
import { routePreferences } from './routes/preferencesRoutes'

/** No OS secret store is wired (later: ISSUE-324): nothing is stored, nothing can be. */
export const unavailableSecretStore: SecretStore = {
  backend: () => Promise.resolve('unavailable'),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  set: () => Promise.reject(new Error('SecretStoreUnavailable')),
  delete: () => Promise.resolve('unavailable')
}

/** DwarfAI owns no config entry yet (later: ISSUE-218…ISSUE-221, ISSUE-323). */
export const noOwnedConfigWriter: ExternalConfigWriter = {
  install: () => Promise.resolve({ ok: false, error: 'io' }),
  verify: () => Promise.resolve('absent'),
  revert: () => Promise.resolve({ ok: true, value: undefined }),
  findLegacy: () => Promise.resolve(false)
}

/** No ledger module owns `install_moment` yet (later: ISSUE-096). */
export const emptyLedgerInstallMoment: LedgerInstallMoment = {
  setInstallMoment: () => undefined
}

export interface PreferencesWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The Host's one event bus (16 §2.3). */
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** `createFeatureFlagReader` (featureFlagReader.ts), read once at start (INV-110). */
  featureFlags: FeatureFlagReader
  /** The `db` step's post-commit cleanup (`SqliteResetCleanup`, host/platform/sqlite). */
  maintenance: ResetDbMaintenance
  /** The ledger's install-moment writer (`emptyLedgerInstallMoment` until ISSUE-096). */
  ledger: LedgerInstallMoment
  /** `unavailableSecretStore` until ISSUE-324. */
  secrets: SecretStore
  /** `noOwnedConfigWriter` until ISSUE-323. */
  externalConfig: ExternalConfigWriter
  connections: ConnectionRegistry
  /** The Host dispatcher (hostDispatcher.ts), where the module's methods join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where the `preferences` section joins. */
  sections: SectionRegistry
  /** Whether the Host answers commands (its lifecycle state is `ready`). */
  ready: () => boolean
}

export interface WiredPreferences {
  /** The module, with `resetMetrics` joined to its commands. */
  preferences: Preferences & { commands: PreferencesCommands & ResetMetricsCommands }
  /** 07 S13.08: the saga's boot resume, run by boot step 3. */
  resumeOnBoot(): Promise<MetricsResetResult | null>
  /** The suppliers bridge (16 §4.4). */
  integrationGate: IntegrationGateReader
  /** The kernel bridge (16 §3), fail closed until ISSUE-324. */
  secretReader: SecretReader
}

export function wirePreferences(deps: PreferencesWiringDeps): WiredPreferences {
  const { db, transactions, bus, clock, ids, hostEpoch, log } = deps
  const module = createPreferences({
    db,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch,
    featureFlags: deps.featureFlags
  })
  const routes = routePreferences({
    bus,
    connections: deps.connections,
    log,
    ready: deps.ready
  })
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    attention: createAttentionResetStep({ db, scope: transactions }),
    ledger: deps.ledger,
    clock
  })
  const saga = createResetSaga({
    db,
    transactions,
    dbSteps: participants.dbSteps,
    installMoment: participants.installMoment,
    maintenance: deps.maintenance,
    secrets: deps.secrets,
    externalConfig: deps.externalConfig,
    ui: routes.sagaUi,
    bus,
    clock,
    ids,
    hostEpoch,
    log
  })
  const preferences: WiredPreferences['preferences'] = {
    commands: {
      set: (key, value) => module.commands.set(key, value),
      resetMetrics: (cmd) => saga.resetMetrics(cmd)
    },
    queries: module.queries
  }
  registerPreferences(deps.dispatcher, { preferences })
  registerResetMetrics(deps.dispatcher, { reset: preferences.commands, fanout: routes.acks })
  deps.sections.registerSection('preferences', ['ui'], preferencesSection(preferences))
  return {
    preferences,
    resumeOnBoot: () => saga.resumeOnBoot(),
    integrationGate: preferencesIntegrationGate(module.queries),
    secretReader: failClosedSecretReader
  }
}
