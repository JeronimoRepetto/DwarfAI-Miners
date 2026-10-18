// The preferences module's wiring (05 §3.12, §4; 16 §4.12, §8.2), in two parts:
//
// - `servePreferences`, run by the composition root before the boot binds the endpoint: the
//   module's seam-B members (14 §2.3 B-M10, B-M11, B-M12, B-M13, B-M14, B-M15, B-M09, B-M39, B-M40) on the Host dispatcher and its
//   snapshot section (14 §4.1). A UI that attaches while the Host is `starting` gets a `hello.ok`
//   whose capabilities already list them (14 §1.3), so its HostClient never refuses them locally.
//   They forward to the module boot step 3 constructs; until then (`starting`, `migrating`) the
//   dispatcher answers them HOST_NOT_READY before any handler runs (14 §3.3).
// - `wire`, run by boot step 3 over the database step 2 opened and the adapters the composition
//   root built (`host/main.ts`, the only file that `new`s them, R6). It constructs the module first,
//   because step 3 resumes an unfinished Reset saga before the rest is constructed and before any
//   command is accepted (05 §2.3; ADR-023 item 4; 07 S13.08): `createPreferences` with the wiring
//   `FeatureFlagReader` (ISSUE-211), the Reset saga with the participant list of
//   resetParticipants.ts (ISSUE-212; the cut-1 module steps of moduleResetSteps.ts, ISSUE-121, and
//   the ledger's install-moment writer, `SqliteLedgerRepository`), `resetMetrics` joined to the module's commands (16 §4.12
//   `PreferencesCommands.resetMetrics`), the first-run consent step (`createWelcomeStep`,
//   ISSUE-222: `welcome` joined to the module's queries, its boot evaluation run by boot step 8,
//   07 machine 41) over the suppliers installed detection (`installedTools`,
//   bridges/installedTools.ts) and the config writer's legacy probe, the "Claude Code · instant
//   updates" toggle (`setClaudeHooks`, ISSUE-221) and the "OpenCode · permission requests" toggle
//   (`setOpenCodePermissions`, B-M14, ISSUE-228) with the transport's credential minter
//   (transport/auth/mintCredential.ts; lead decision 2026-09-30, ISSUE-198), the first-run step's
//   answer (`createWelcomeAnswer`, ISSUE-223: `answerWelcome` joined to the module's commands and
//   served as B-M40; ISSUE-323), the secrets' configured flags (`createSecrets`, ISSUE-216:
//   `saveSecret`/`clearSecret` joined to the commands and served as B-M10/B-M11, `secretStatus` and
//   the view's reads joined to the queries; their boot read, `loadSecretStatuses`, runs in boot
//   step 3 after the saga resume, so a resumed `secrets` step is already reflected), its event routes (routes/preferencesRoutes.ts: B-F24, B-F25, B-F03,
//   B-F26, B-F27), and the bridges other modules read it through, never by a module import (R4): the
//   kernel `SecretReader` (bridges/secretReader.ts `storeSecretReader`: the store host/main.ts
//   built, `OsKeyringSecretStore` since step 3a, read with its SECRET_READ_TIMEOUT_MS deadline on
//   the Host scheduler; ISSUE-324), the suppliers `IntegrationGateReader` and the channel-token
//   lookup the hook ingress reads (bridges/). The Reset saga deletes the secrets through the module's
//   `clearSecret` (`sagaSecretStore` below), so the flags and every UI follow its `secrets` step
//   (14 §6.3: `preferences.changed` with the secrets cleared).
//
// The config writer is the composition root's (host/main.ts, cut 2 since ISSUE-323: the engine
// with the Claude Code hooks target behind bridges/hostConfigWriter.ts), and so is its boot
// re-verification, which boot step 3 runs right after `resumeOnBoot` (bootSteps.ts
// `reverifyConfigWrites`; 16 §7.3, 07 S14.11).
//
// `unavailableSecretStore` stays for a wiring with no OS secret store to compose (L2 cases of other
// modules; host/main.ts composes `OsKeyringSecretStore` since ISSUE-324): nothing can have been
// stored, so the saga's `secrets` step completes as a no-op (`delete` resolves `'unavailable'`,
// ADR-017 items 5, 7; AMENDMENT-2), `set` refuses, and the `SecretReader` reads "not set".
// `noOwnedConfigWriter` stays for a wiring with no config writer to compose (L2 cases of other
// modules): DwarfAI owns no entry, so the `external-config` step is a no-op and nothing is
// installed.
import { HostInvariantError } from '../kernel/domain/errors'
import type { HostEpoch } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { SecretReader } from '../kernel/ports/secretReader'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type { TransactionScope } from '../kernel/ports/transactionScope'
import { createAttentionResetStep } from '../modules/attention'
import {
  createPreferences,
  createPreferencesResetStep,
  createResetSaga,
  createSecrets,
  createWelcomeAnswer,
  createWelcomeStep,
  type ChannelTokenStore,
  type CredentialMinter,
  type ExternalConfigWriter,
  type FeatureFlagReader,
  type InstalledToolsReader,
  type IntegrationSettingsQueries,
  type MetricsResetResult,
  type Preferences,
  type PreferencesCommands,
  type PreferencesEvent,
  type PreferencesQueries,
  type ResetDbMaintenance,
  type ResetMetricsCommands,
  type SecretBackend,
  type SecretCommands,
  type SecretDeleteOutcome,
  type SecretQueries,
  type SecretStore,
  type WelcomeAnswer,
  type WelcomeQueries,
  type WelcomeStepState
} from '../modules/preferences'
import type { IntegrationGateReader } from '../modules/suppliers'
import { mintCredential as transportMintCredential } from '../transport/auth/mintCredential'
import type { ConnectionRegistry } from '../transport/connectionRegistry'
import type { Dispatcher } from '../transport/dispatcher'
import { preferencesSection, registerPreferences } from '../transport/methods/preferences'
import { ConnectionResetUiFanout, registerResetMetrics } from '../transport/methods/resetMetrics'
import { registerAnswerWelcome } from '../transport/methods/answerWelcome'
import { registerSetClaudeHooks } from '../transport/methods/setClaudeHooks'
import { registerSetOpenCodePermissions } from '../transport/methods/setOpenCodePermissions'
import { registerSettingsSecret } from '../transport/methods/settingsSecret'
import type { SectionRegistry } from '../transport/snapshot/sectionRegistry'
import { ingressChannelTokens } from './bridges/channelTokens'
import { preferencesIntegrationGate } from './bridges/integrationGateReader'
import { storeSecretReader } from './bridges/secretReader'
import {
  resetParticipants,
  type LedgerInstallMoment,
  type ModuleResetSteps
} from './resetParticipants'
import { routePreferences } from './routes/preferencesRoutes'

/** A wiring with no OS secret store (host/main.ts composes the real one): nothing is stored, nothing can be. */
export const unavailableSecretStore: SecretStore = {
  backend: () => Promise.resolve('unavailable'),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  set: () => Promise.reject(new Error('SecretStoreUnavailable')),
  delete: () => Promise.resolve('unavailable')
}

/**
 * Nothing counts as installed: the first-run step is skipped, never answered (07 S41.09). The
 * stand-in of a wiring with no installed detection to read (host/main.ts passes the suppliers
 * bridge, bridges/installedTools.ts).
 */
export const noInstalledTools: InstalledToolsReader = { installed: () => [] }

/** No channel has an active token: the hook ingress refuses every request (ADR-016 item 2). */
const noActiveChannelTokens: Pick<ChannelTokenStore, 'active'> = { active: () => null }

/** A wiring with no config writer: DwarfAI owns no config entry (host/main.ts composes the real one). */
export const noOwnedConfigWriter: ExternalConfigWriter = {
  install: () => Promise.resolve({ ok: false, error: 'io' }),
  verify: () => Promise.resolve('absent'),
  revert: () => Promise.resolve({ ok: true, value: undefined }),
  findLegacy: () => Promise.resolve(false)
}

export interface PreferencesWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The Host's one event bus (16 §2.3). */
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  /** The Host scheduler: where each `SecretReader` read waits for its 10 000 ms deadline (16 §2.6). */
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** `createFeatureFlagReader` (featureFlagReader.ts), read once at start (INV-110). */
  featureFlags: FeatureFlagReader
  /** The `db` step's post-commit cleanup (`SqliteResetCleanup`, host/platform/sqlite). */
  maintenance: ResetDbMaintenance
  /** The ledger's install-moment writer: the `SqliteLedgerRepository` boot step 4 wires. */
  ledger: LedgerInstallMoment
  /** The cut-1 module steps (`createModuleResetSteps(...).steps`, moduleResetSteps.ts). */
  moduleSteps: ModuleResetSteps
  /** The OS secret store (host/main.ts: `OsKeyringSecretStore`, ISSUE-324; ADR-017 item 2). */
  secrets: SecretStore
  /** The one config writer (host/main.ts: bridges/hostConfigWriter.ts over the engine, cut 2). */
  externalConfig: ExternalConfigWriter
  /**
   * The suppliers installed detection, through bridges/installedTools.ts (16 §4.12
   * `InstalledToolsReader`): the first-run step offers only installed tools (AMENDMENT-9).
   * `noInstalledTools` when absent.
   */
  installedTools?: InstalledToolsReader
  /**
   * The transport's token issuance (host/main.ts passes transport/auth/mintCredential.ts, lead
   * decision 2026-09-30, ISSUE-198); that same minter when absent.
   */
  mintCredential?: CredentialMinter
  /**
   * The stored channel-token hashes (`SqliteChannelTokenStore`, host/main.ts): the hook ingress
   * reads the active one through `WiredPreferences.channelTokens`. No active token when absent.
   */
  channelTokens?: Pick<ChannelTokenStore, 'active'>
  /** Whether the Host answers commands (its lifecycle state is `ready`). */
  ready: () => boolean
}

export interface PreferencesServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where the module's methods join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where the `preferences` section joins. */
  sections: SectionRegistry
  connections: ConnectionRegistry
}

export interface ServedPreferences {
  /** Boot step 3: constructs and wires the module the served members forward to. */
  wire(deps: PreferencesWiringDeps): WiredPreferences
}

export interface WiredPreferences {
  /**
   * The module, with `resetMetrics` and the first-run step's `answerWelcome` joined to its commands
   * and `welcome` to its queries.
   */
  preferences: Preferences & {
    commands: PreferencesCommands & ResetMetricsCommands & WelcomeAnswer & SecretCommands
    queries: PreferencesQueries & IntegrationSettingsQueries & WelcomeQueries & SecretQueries
  }
  /** 07 S13.08: the saga's boot resume, run by boot step 3. */
  resumeOnBoot(): Promise<MetricsResetResult | null>
  /** The secrets' configured flags and backend, read once by boot step 3 after `resumeOnBoot`. */
  loadSecretStatuses(): Promise<void>
  /**
   * 07 S41.01, S41.02, S41.09: the first-run step's boot evaluation, run by boot step 8 right after
   * the start-up installed detection (bootSteps.ts `evaluateWelcomeAfterDetection`).
   */
  evaluateWelcomeAtBoot(): Promise<WelcomeStepState>
  /** The suppliers bridge (16 §4.4). */
  integrationGate: IntegrationGateReader
  /** The kernel bridge (16 §3): reads through `secrets` with SECRET_READ_TIMEOUT_MS (ISSUE-324). */
  secretReader: SecretReader
  /** The channel-token lookup the hook ingress reads (bridges/channelTokens.ts; ISSUE-140). */
  channelTokens: Pick<ChannelTokenStore, 'active'>
}

/** Serves the module's seam-B members before it exists; `wire` constructs it at boot step 3. */
export function servePreferences(serve: PreferencesServeDeps): ServedPreferences {
  const acks = new ConnectionResetUiFanout(serve.connections)
  let wired: WiredPreferences['preferences'] | undefined
  const current = (): WiredPreferences['preferences'] => {
    if (wired === undefined) {
      throw new HostInvariantError('preferences are served from boot step 3 on')
    }
    return wired
  }
  const served: WiredPreferences['preferences'] = {
    commands: {
      set: (key, value) => current().commands.set(key, value),
      setClaudeHooks: (on, origin) => current().commands.setClaudeHooks(on, origin),
      setOpenCodePermissions: (on, origin) => current().commands.setOpenCodePermissions(on, origin),
      resetMetrics: (cmd) => current().commands.resetMetrics(cmd),
      answerWelcome: (choice) => current().commands.answerWelcome(choice),
      saveSecret: (name, value) => current().commands.saveSecret(name, value),
      clearSecret: (name) => current().commands.clearSecret(name)
    },
    queries: {
      get: () => current().queries.get(),
      featureFlags: () => current().queries.featureFlags(),
      integrationState: (id) => current().queries.integrationState(id),
      integrationSettings: () => current().queries.integrationSettings(),
      welcome: () => current().queries.welcome(),
      secretStatus: (name) => current().queries.secretStatus(name),
      secretStatuses: () => current().queries.secretStatuses(),
      secretBackend: () => current().queries.secretBackend()
    }
  }
  registerPreferences(serve.dispatcher, { preferences: served })
  registerSettingsSecret(serve.dispatcher, { commands: served.commands })
  registerSetClaudeHooks(serve.dispatcher, { commands: served.commands })
  registerSetOpenCodePermissions(serve.dispatcher, { commands: served.commands })
  registerAnswerWelcome(serve.dispatcher, { commands: served.commands, queries: served.queries })
  registerResetMetrics(serve.dispatcher, { reset: served.commands, fanout: acks })
  serve.sections.registerSection('preferences', ['ui'], preferencesSection(served))
  return {
    wire: (deps) => {
      if (wired !== undefined) throw new HostInvariantError('preferences are wired once')
      const result = wirePreferences(deps, { connections: serve.connections, acks })
      wired = result.preferences
      return result
    }
  }
}

function wirePreferences(
  deps: PreferencesWiringDeps,
  transport: { connections: ConnectionRegistry; acks: ConnectionResetUiFanout }
): WiredPreferences {
  const { db, transactions, bus, clock, ids, hostEpoch, log } = deps
  const module = createPreferences({
    db,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch,
    featureFlags: deps.featureFlags,
    externalConfig: deps.externalConfig,
    mintCredential: deps.mintCredential ?? transportMintCredential
  })
  const welcome = createWelcomeStep({
    db,
    bus,
    clock,
    ids,
    hostEpoch,
    installedTools: deps.installedTools ?? noInstalledTools,
    externalConfig: deps.externalConfig
  })
  const answer = createWelcomeAnswer({
    db,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch,
    step: welcome,
    preferences: module,
    externalConfig: deps.externalConfig
  })
  const secrets = createSecrets({ secrets: deps.secrets, bus, clock, ids, hostEpoch })
  const queries: WiredPreferences['preferences']['queries'] = {
    get: () => module.queries.get(),
    featureFlags: () => module.queries.featureFlags(),
    integrationState: (id) => module.queries.integrationState(id),
    integrationSettings: () => module.queries.integrationSettings(),
    welcome: () => welcome.welcome(),
    secretStatus: (name) => secrets.secretStatus(name),
    secretStatuses: () => secrets.secretStatuses(),
    secretBackend: () => secrets.secretBackend()
  }
  const sagaUi = routePreferences({
    bus,
    connections: transport.connections,
    log,
    acks: transport.acks,
    ready: deps.ready,
    queries
  })
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    modules: deps.moduleSteps,
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
    secrets: sagaSecretStore(deps.secrets, secrets),
    externalConfig: deps.externalConfig,
    ui: sagaUi,
    bus,
    clock,
    ids,
    hostEpoch,
    log
  })
  const preferences: WiredPreferences['preferences'] = {
    commands: {
      set: (key, value) => module.commands.set(key, value),
      setClaudeHooks: (on, origin) => module.commands.setClaudeHooks(on, origin),
      setOpenCodePermissions: (on, origin) => module.commands.setOpenCodePermissions(on, origin),
      resetMetrics: (cmd) => saga.resetMetrics(cmd),
      answerWelcome: (choice) => answer.answerWelcome(choice),
      saveSecret: (name, value) => secrets.saveSecret(name, value),
      clearSecret: (name) => secrets.clearSecret(name)
    },
    queries
  }
  return {
    preferences,
    resumeOnBoot: () => saga.resumeOnBoot(),
    loadSecretStatuses: () => secrets.loadSecretStatuses(),
    evaluateWelcomeAtBoot: () => welcome.evaluateWelcomeAtBoot(),
    integrationGate: preferencesIntegrationGate(module.queries),
    secretReader: storeSecretReader({ store: deps.secrets, scheduler: deps.scheduler }),
    channelTokens: ingressChannelTokens(deps.channelTokens ?? noActiveChannelTokens)
  }
}

/**
 * The `SecretStore` the Reset saga's `secrets` step deletes through (ADR-023; 16 §4.12.1): its
 * `delete` is the module's `clearSecret`, so the configured flags follow the step and
 * `SecretStatusChanged` reaches every UI as `preferences.changed`. The outcome keeps the port's
 * contract: `'unavailable'` when no secret service is usable (AMENDMENT-2), `'deleted'` otherwise; a
 * failing delete rejects, which fails the step (07 S13.07). The other members are the store's own.
 */
export function sagaSecretStore(
  store: SecretStore,
  secrets: Pick<SecretCommands, 'clearSecret'> & Pick<SecretQueries, 'secretBackend'>
): SecretStore {
  const outcomeOf = (backend: SecretBackend): SecretDeleteOutcome =>
    backend === 'unavailable' ? 'unavailable' : 'deleted'
  return {
    backend: () => store.backend(),
    get: (name) => store.get(name),
    has: (name) => store.has(name),
    set: (name, value) => store.set(name, value),
    delete: async (name) => {
      await secrets.clearSecret(name)
      return outcomeOf(secrets.secretBackend())
    }
  }
}
