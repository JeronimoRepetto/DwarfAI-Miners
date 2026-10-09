// The preferences use cases of cut 1 (05 §3.12; 16 §4.12): `PreferencesCommands.set` and
// `PreferencesQueries.get` over the `host_preferences` singleton, and `PreferencesQueries.featureFlags`,
// the flags the `FeatureFlagReader` read once when the service was built (INV-110), and
// `PreferencesQueries.integrationState`, the stored state of `integration_settings`, and
// `PreferencesCommands.setClaudeHooks` (AMENDMENT-7; ISSUE-221), the "Claude Code · instant
// updates" toggle and the enable path the first-run step reuses (ISSUE-223). `WelcomeStepService` below is `PreferencesQueries.welcome` and the
// first-run step's boot evaluation (07 machine 41, ISSUE-222), joined to the queries by host/wiring.
// The other members of the driving ports (secrets, the integration toggles, answering the step)
// join with their issues (later: ISSUE-215, ISSUE-216, ISSUE-223…ISSUE-225); Reset metrics is the
// saga's (resetSaga.ts), joined to the commands by host/wiring.
//
// `set` (INV-105; ADR-024 D9; IPC Gap 10) runs in one transaction: it reads the row, applies the
// key within the provider rule (domain `withPreference`), saves only when something changed and
// re-reads the row, which is the answer: what was STORED, never the request. After the commit it
// publishes `HostPreferencesChanged` with that row, and only when a value changed (16 §2.3).
import type {
  EventId,
  HostEpoch,
  IntegrationId,
  IntegrationState,
  Result
} from '../../../kernel/domain/values'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { PreferencesEvent } from '../domain/events'
import {
  samePreferences,
  withPreference,
  type HostPreferenceKey,
  type HostPreferences
} from '../domain/hostPreferences'
import { evaluate, type WelcomeStepState } from '../domain/welcomeStep'
import type { ChannelTokenStore } from '../ports/channelTokenStore'
import type {
  ChannelToken,
  ConfigTarget,
  ConsentOrigin,
  ExternalConfigWriter
} from '../ports/externalConfigWriter'
import type { IntegrationSetting, IntegrationSettingStore } from '../ports/integrationSettingStore'
import type { FeatureFlagReader, FeatureFlags } from '../ports/featureFlagReader'
import type { InstalledToolsReader } from '../ports/installedToolsReader'
import type { WelcomeAnswerStore } from '../ports/welcomeAnswerStore'
import type { PreferencesStore } from '../ports/preferencesStore'

/**
 * A credential as the transport mints it (host/transport/auth/mintCredential.ts; ADR-016 item 1):
 * the plaintext `value` (32 random bytes as lower-case hex) goes only into the owned entry the
 * config writer puts on disk; only `sha256` (the SHA-256 of that hex text, lower-case hex) is
 * stored. Lead decision 2026-09-30 (ISSUE-198): the module gets randomness and hashing as this
 * plain function, never through `node:*` (R3).
 */
export interface MintedCredential {
  value: string
  sha256: string
}

/** Mints a fresh credential on every call. */
export type CredentialMinter = () => MintedCredential

/** Driving port (05 §3.12): the members served so far; the others join with their issues. */
export interface PreferencesCommands {
  /** Returns what was STORED (IPC Gap 10). */
  set<K extends HostPreferenceKey>(key: K, value: HostPreferences[K]): HostPreferences
  /**
   * AMENDMENT-7 (OQ-68): "Claude Code · instant updates"; writes (+ read-back verify) / reverts
   * DwarfAI's hook entry in Claude Code's settings through the same writer (ADR-016 items 5–7);
   * origin 'settings' or 'first-run'; a failed revert keeps the option on (16 §7.4).
   */
  setClaudeHooks(
    on: boolean,
    origin: ConsentOrigin
  ): Promise<Result<{ state: IntegrationState }, 'config-write-failed' | 'config-revert-failed'>>
}

/** Driving port (05 §3.12): cut 1's member; the others join with their issues. */
export interface PreferencesQueries {
  get(): HostPreferences
  featureFlags(): FeatureFlags
  integrationState(id: IntegrationId): IntegrationState
}

/**
 * Package gap: `PreferencesView.integrations` (14 §3.6; source `integration_settings`, 14 §4.1)
 * needs every stored `IntegrationSetting`, which no 16 §4.12 query returns (`integrationState`
 * answers the state only). This read joins the module's queries in host/wiring, as `welcome` does;
 * no frozen port changes.
 */
export interface IntegrationSettingsQueries {
  integrationSettings(): IntegrationSetting[]
}

export interface PreferencesServiceDeps {
  store: PreferencesStore
  transactions: TransactionRunner
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
  featureFlags: FeatureFlagReader
  /** `integration_settings`: read here, written by the config writer (16 §7.3, §7.4). */
  integrations: IntegrationSettingStore
  /** `channel_tokens`: the hash of each issued token (ADR-016 item 1). */
  tokens: ChannelTokenStore
  /** The one config writer (16 §7). */
  externalConfig: ExternalConfigWriter
  /** The transport's token issuance (host/transport/auth/mintCredential.ts). */
  mintCredential: CredentialMinter
}

export class PreferencesService
  implements PreferencesCommands, PreferencesQueries, IntegrationSettingsQueries
{
  /** Read once, at construction (Host start); never re-read while the Host runs (INV-110). */
  private readonly flags: FeatureFlags
  /** The integration toggle calls, one at a time (16 §7.5). */
  private toggles: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: PreferencesServiceDeps) {
    this.flags = deps.featureFlags.read()
  }

  set<K extends HostPreferenceKey>(key: K, value: HostPreferences[K]): HostPreferences {
    const { stored, changed } = this.deps.transactions.inTransaction(() => {
      const current = this.deps.store.load()
      const next = withPreference(current, key, value)
      if (samePreferences(current, next)) return { stored: current, changed: false }
      this.deps.store.save(next)
      return { stored: this.deps.store.load(), changed: true }
    })
    if (changed) {
      this.deps.bus.publish({
        type: 'HostPreferencesChanged',
        v: 1,
        id: this.deps.ids.uuidv7() as EventId,
        at: this.deps.clock.now(),
        hostEpoch: this.deps.hostEpoch,
        payload: { preferences: stored }
      })
    }
    return stored
  }

  get(): HostPreferences {
    return this.deps.store.load()
  }

  featureFlags(): FeatureFlags {
    return { ...this.flags }
  }

  /**
   * 16 §4.12, read by the `IntegrationGateReader` bridge and the hook ingress: the stored state
   * (`integration_settings`), `off` on a new install (ADR-011 item 7; 18 C-27) and until a consent
   * turned it on, so a gated provider's answer channel and `/hooks/claude/*` stay closed.
   */
  integrationState(id: IntegrationId): IntegrationState {
    return this.deps.integrations.get(id).state
  }

  /** The stored setting of every integration, for `PreferencesView.integrations` (14 §3.6). */
  integrationSettings(): IntegrationSetting[] {
    return INTEGRATIONS.map((id) => this.deps.integrations.get(id))
  }

  /**
   * 16 §4.12 `setClaudeHooks` (AMENDMENT-7, OQ-68; 16 §7.3, §7.4; 07 machine 14; ADR-016 items 1,
   * 5–7). Origin `settings` (the Settings toggle, B-M39) or `first-run` (`answerWelcome`, the same
   * enable path); `add-panel` is refused as a precondition failure, before anything is minted or
   * written (09 CHECK). One call at a time (16 §7.5): a call asked while another runs settles
   * after it.
   *
   * - On: enabling an `on-verified` integration whose entry still verifies is a no-op (16 §7.5).
   *   Otherwise a new `claudeHookToken` is minted and its hash issued, which revokes the previous
   *   one (Tx A, 16 §7.3), then the one config writer installs the entry with the plaintext
   *   token and records the origin (its Tx B turns the integration `on-verified`). A failed write
   *   revokes the new token (Tx B failure) and answers `config-write-failed`; the integration
   *   stays as it was.
   * - Off: the writer reverts the entry (its transaction turns the integration `off`), then the
   *   token is revoked. A locked file changes nothing: the option stays on, the token stays
   *   active, and the answer is `config-revert-failed` (16 §7.4).
   *
   * `IntegrationChanged` with the stored state is published after every outcome, a failed one
   * included (16 §4.12; 16 §7.4). The plaintext token goes to the writer only.
   */
  setClaudeHooks(on: boolean, origin: ConsentOrigin): Promise<ToggleResult> {
    if (!CLAUDE_HOOKS_ORIGINS.includes(origin)) {
      return Promise.reject(
        new HostInvariantError(
          `consent origin ${origin} cannot turn claude-hooks on or off (09 CHECK)`
        )
      )
    }
    const run = this.toggles.then(() =>
      on ? this.enableClaudeHooks(origin) : this.disableClaudeHooks()
    )
    this.toggles = run.catch(() => undefined)
    return run
  }

  private async enableClaudeHooks(origin: ConsentOrigin): Promise<ToggleResult> {
    const { integrations, tokens, externalConfig, transactions, clock } = this.deps
    if (
      integrations.get(CLAUDE_HOOKS).state === 'on-verified' &&
      (await externalConfig.verify(CLAUDE_HOOKS)) === 'verified'
    ) {
      return this.settled(CLAUDE_HOOKS, null)
    }
    const credential = this.deps.mintCredential()
    transactions.inTransaction(() => tokens.issue(CLAUDE_HOOKS, credential.sha256, clock.now()))
    const installed = await externalConfig.install(
      CLAUDE_HOOKS,
      credential.value as ChannelToken,
      origin
    )
    if (!installed.ok) {
      transactions.inTransaction(() => tokens.revoke(CLAUDE_HOOKS, clock.now()))
      return this.settled(CLAUDE_HOOKS, 'config-write-failed')
    }
    return this.settled(CLAUDE_HOOKS, null)
  }

  private async disableClaudeHooks(): Promise<ToggleResult> {
    const { tokens, externalConfig, transactions, clock } = this.deps
    const reverted = await externalConfig.revert(CLAUDE_HOOKS)
    if (!reverted.ok) return this.settled(CLAUDE_HOOKS, 'config-revert-failed')
    transactions.inTransaction(() => tokens.revoke(CLAUDE_HOOKS, clock.now()))
    return this.settled(CLAUDE_HOOKS, null)
  }

  /** Publishes the stored state (`IntegrationChanged`, after every commit) and answers it. */
  private settled(id: IntegrationId, failure: ToggleFailure | null): ToggleResult {
    const state = this.deps.integrations.get(id).state
    this.deps.bus.publish({
      type: 'IntegrationChanged',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload: { id, state }
    })
    return failure === null ? { ok: true, value: { state } } : { ok: false, error: failure }
  }
}

type ToggleFailure = 'config-write-failed' | 'config-revert-failed'
type ToggleResult = Result<{ state: IntegrationState }, ToggleFailure>

/** Every integration, in the order `PreferencesView.integrations` lists them. */
const INTEGRATIONS: readonly IntegrationId[] = ['claude-hooks', 'opencode-permissions']

const CLAUDE_HOOKS = 'claude-hooks'

/** 16 §4.12 (AMENDMENT-7): the consent entry points of `claude-hooks`; never `add-panel` (09 CHECK). */
const CLAUDE_HOOKS_ORIGINS: readonly ConsentOrigin[] = ['settings', 'first-run']

/** 16 §4.12 `PreferencesQueries.welcome` (AMENDMENT-7); host/wiring joins it to the module's queries. */
export interface WelcomeQueries {
  welcome(): WelcomeStepState
}

/** The step's boot evaluation (07 S41.01, S41.02, S41.03, S41.09), called once per Host boot. */
export interface WelcomeBoot {
  evaluateWelcomeAtBoot(): Promise<WelcomeStepState>
}

export interface WelcomeStepServiceDeps {
  answers: WelcomeAnswerStore
  installed: InstalledToolsReader
  /** The one config writer's legacy probe (16 §7.1); evaluation never writes or reverts. */
  legacy: Pick<ExternalConfigWriter, 'findLegacy'>
  /** The integrations this cut offers (domain/offeredFilter.ts; later: ISSUE-232). */
  cutFilter: readonly IntegrationId[]
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
}

/** The config target behind each integration's foreign entry (16 §4.12 `ConfigTarget`). */
const TARGET_OF: Readonly<Record<IntegrationId, ConfigTarget>> = {
  'claude-hooks': 'claude-hooks',
  'opencode-permissions': 'opencode-plugin'
}

/** Before the boot evaluation ran: nothing shown, nothing offered (and nothing answered). */
const NOT_EVALUATED: WelcomeStepState = Object.freeze({ due: false, legacyFound: [], offered: [] })

/**
 * The first-run consent step (07 machine 41; 16 §4.12 `welcome()`). At boot it reads the installed
 * tools, keeps those the cut filter allows (`offered`), asks the legacy probe about the offered
 * targets only (S41.02 never looks at a target the cut does not offer, 21 §2 cut 2), reads the
 * stored answer and evaluates the step (domain/welcomeStep.ts). Nothing is written, reverted or
 * answered here: an old-app entry is only listed (ADR-016, never adopted silently), and a skip with
 * nothing offered is not an answer (S41.09). `WelcomeStepChanged` is published only when the state
 * differs from the one held (the first is the not-evaluated state, so a skip publishes nothing).
 */
export class WelcomeStepService implements WelcomeQueries, WelcomeBoot {
  private state: WelcomeStepState = NOT_EVALUATED

  constructor(private readonly deps: WelcomeStepServiceDeps) {}

  async evaluateWelcomeAtBoot(): Promise<WelcomeStepState> {
    const { answers, installed, legacy, cutFilter } = this.deps
    const tools = installed.installed()
    const offered = evaluate({
      answeredAt: null,
      installed: tools,
      legacyFound: [],
      cutFilter
    }).offered
    const legacyFound: IntegrationId[] = []
    for (const id of offered) {
      if (await legacy.findLegacy(TARGET_OF[id])) legacyFound.push(id)
    }
    const next = evaluate({
      answeredAt: answers.answeredAt(),
      installed: tools,
      legacyFound,
      cutFilter
    })
    if (!sameWelcome(this.state, next)) {
      this.state = next
      this.deps.bus.publish({
        type: 'WelcomeStepChanged',
        v: 1,
        id: this.deps.ids.uuidv7() as EventId,
        at: this.deps.clock.now(),
        hostEpoch: this.deps.hostEpoch,
        payload: { state: copyOf(next) }
      })
    }
    return copyOf(this.state)
  }

  welcome(): WelcomeStepState {
    return copyOf(this.state)
  }
}

function copyOf(state: WelcomeStepState): WelcomeStepState {
  return { ...state, legacyFound: [...state.legacyFound], offered: [...state.offered] }
}

function sameWelcome(a: WelcomeStepState, b: WelcomeStepState): boolean {
  const sameList = (x: readonly IntegrationId[], y: readonly IntegrationId[]): boolean =>
    x.length === y.length && x.every((id, at) => id === y[at])
  return (
    a.due === b.due &&
    a.reason === b.reason &&
    sameList(a.legacyFound, b.legacyFound) &&
    sameList(a.offered, b.offered)
  )
}
