// The preferences use cases of cut 1 (05 §3.12; 16 §4.12): `PreferencesCommands.set` and
// `PreferencesQueries.get` over the `host_preferences` singleton, and `PreferencesQueries.featureFlags`,
// the flags the `FeatureFlagReader` read once when the service was built (INV-110), and
// `PreferencesQueries.integrationState`, the stored state of `integration_settings`, and
// `PreferencesCommands.setClaudeHooks` (AMENDMENT-7; ISSUE-221), the "Claude Code · instant
// updates" toggle and the enable path the first-run step reuses. `WelcomeStepService` below is
// `PreferencesQueries.welcome` and the first-run step's boot evaluation (07 machine 41, ISSUE-222),
// joined to the queries by host/wiring; `WelcomeAnswerService` is `PreferencesCommands.answerWelcome`
// (ISSUE-223), joined to the commands by host/wiring (later: ISSUE-323). The other members of the
// driving ports (secrets, the OpenCode toggle) join with their issues (later: ISSUE-215, ISSUE-216,
// ISSUE-228); Reset metrics is the saga's (resetSaga.ts), joined to the commands by host/wiring.
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
import {
  evaluate,
  type WelcomeChoice,
  type WelcomeResult,
  type WelcomeStepState
} from '../domain/welcomeStep'
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
   *   Otherwise a new `claudeHookToken` is minted and the one config writer installs the entry
   *   with the plaintext token and records the origin; it issues the token's hash in its Tx A,
   *   revoking the previous one, and its Tx B turns the integration `on-verified` (16 §7.3; owner
   *   amendment M). A failed write withdraws the new hash, so the previous token is active again,
   *   and answers `config-write-failed`; the integration stays as it was.
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
    const { integrations, externalConfig } = this.deps
    if (
      integrations.get(CLAUDE_HOOKS).state === 'on-verified' &&
      (await externalConfig.verify(CLAUDE_HOOKS)) === 'verified'
    ) {
      return this.settled(CLAUDE_HOOKS, null)
    }
    // Owner amendment M: the writer issues the new hash in its own Tx A, together with the `config_writes` row,
    // and its Tx B (failure) withdraws it in the transaction that deletes the Tx A rows, making the previous token
    // active again (16 §7.3). A crash between the hash and Tx A is impossible by construction, and a failed
    // re-enable leaves the working token of an `on-*` integration active.
    const credential = this.deps.mintCredential()
    const installed = await externalConfig.install(
      CLAUDE_HOOKS,
      credential.value as ChannelToken,
      origin,
      credential.sha256
    )
    if (!installed.ok) return this.settled(CLAUDE_HOOKS, 'config-write-failed')
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

/**
 * The integrations whose enable path the first-run step can run. `opencode-permissions` joins with
 * its toggle (later: ISSUE-228) when the cut offers it (later: ISSUE-232).
 */
const ENABLE_PATHS: readonly IntegrationId[] = [CLAUDE_HOOKS]

/** 16 §4.12 `PreferencesQueries.welcome` (AMENDMENT-7); host/wiring joins it to the module's queries. */
export interface WelcomeQueries {
  welcome(): WelcomeStepState
}

/** The step's boot evaluation (07 S41.01, S41.02, S41.03, S41.09), called once per Host boot. */
export interface WelcomeBoot {
  evaluateWelcomeAtBoot(): Promise<WelcomeStepState>
}

/** The step settled by its answer (07 S41.05). */
export interface WelcomeSettle {
  settleAnswered(): WelcomeStepState
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
export class WelcomeStepService implements WelcomeQueries, WelcomeBoot, WelcomeSettle {
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

  /**
   * 07 S41.05: the answer was recorded, so the step is no longer due and lists nothing found,
   * whatever a failed write or revert left (the next boot finds a remaining old-app entry again,
   * S41.02). `WelcomeStepChanged` closes the step in every window.
   */
  settleAnswered(): WelcomeStepState {
    const next = evaluate({
      answeredAt: this.deps.clock.now(),
      installed: this.state.offered,
      legacyFound: [],
      cutFilter: this.deps.cutFilter
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
}

/** 16 §4.12 `PreferencesCommands.answerWelcome` (AMENDMENT-7); host/wiring joins it to the module's commands. */
export interface WelcomeAnswer {
  answerWelcome(choice: WelcomeChoice): Promise<WelcomeResult>
}

/** What answering reads and runs of the integration toggles: their enable path and stored state. */
export type WelcomeIntegrations = Pick<PreferencesCommands, 'setClaudeHooks'> &
  Pick<PreferencesQueries, 'integrationState'>

export interface WelcomeAnswerServiceDeps {
  /** The step the boot evaluated; the answer reads it and settles it (07 S41.05). */
  step: WelcomeQueries & WelcomeSettle
  /** `app_meta.welcome_answered_at`, written once the per-integration actions settled. */
  answers: WelcomeAnswerStore
  /**
   * The one config writer's legacy probe (16 §7.1) and its revert, which removes an old-app entry
   * of an option left unticked (16 §7.4; 07 S14.12).
   */
  legacy: Pick<ExternalConfigWriter, 'findLegacy' | 'revert'>
  /** The enable path a ticked option runs with origin `first-run`, and the stored states. */
  integrations: WelcomeIntegrations
  transactions: TransactionRunner
  /** The integrations whose foreign entry the Host writes in this cut (domain/offeredFilter.ts). */
  cutFilter: readonly IntegrationId[]
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
}

/**
 * 16 §4.12 `answerWelcome` (AMENDMENT-7, OQ-68; 07 S41.04, S41.05; ADR-016 items 5–7): the one
 * answer of the first-run consent step. "Activate" is the consent; nothing is written or reverted
 * before it, and an old-app entry is never adopted.
 *
 * - One answer at a time: an answer sent while another runs settles after it, and an answer while
 *   the step is not due (a second answer, or one before the boot evaluated it) is a no-op that
 *   returns the current states.
 * - Per integration, in the order `claude-hooks`, `opencode-permissions`: a ticked option the step
 *   offered runs the toggle's enable path with origin `first-run` (S14.01; S14.16 when the writer
 *   replaces an old-app entry in the same write; S14.15 the writer's no-op when it is already on).
 *   A `true` for an option not offered is treated as `false` (S41.04). An option left unticked
 *   that is already on stays on (S14.15); otherwise only an old-app entry the legacy probe finds
 *   is reverted (S14.12, S14.13), and nothing at all happens without one (S14.14). A target the
 *   Host does not write in this cut is never probed or reverted: its writer is still the legacy
 *   installer (21 §2 cut 2, no double writer).
 * - After both settled, one transaction records `welcome_answered_at`; a failed write or revert
 *   does not keep the step open, it is in the result (S41.05; 13 FM-148, FM-149). A Host that dies
 *   before that transaction leaves the step unanswered, so the next boot shows it again (S41.06).
 *
 * The enable path publishes `IntegrationChanged` itself; a revert of an old-app entry publishes it
 * here, after a failed revert too, with the stored state (16 §7.4).
 */
export class WelcomeAnswerService implements WelcomeAnswer {
  /** The answers, one at a time (16 §4.12 "one answer at a time"). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: WelcomeAnswerServiceDeps) {
    for (const id of deps.cutFilter) {
      if (!ENABLE_PATHS.includes(id)) {
        throw new HostInvariantError(`the first-run step cannot offer ${id}: no enable path yet`)
      }
    }
  }

  answerWelcome(choice: WelcomeChoice): Promise<WelcomeResult> {
    const run = this.queue.then(() => this.answer(choice))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async answer(choice: WelcomeChoice): Promise<WelcomeResult> {
    const step = this.deps.step.welcome()
    if (!step.due) return this.currentStates({})
    const ticked: Readonly<Record<IntegrationId, boolean>> = {
      'claude-hooks': choice.claudeHooks,
      'opencode-permissions': choice.openCodePermissions
    }
    const failures: Partial<Record<IntegrationId, ToggleFailure>> = {}
    for (const id of INTEGRATIONS) {
      const failure =
        ticked[id] && step.offered.includes(id) ? await this.enable(id) : await this.decline(id)
      if (failure !== null) failures[id] = failure
    }
    const { transactions, answers, clock } = this.deps
    transactions.inTransaction(() => answers.setAnsweredAt(clock.now()))
    this.deps.step.settleAnswered()
    return this.currentStates(failures)
  }

  /** The toggle's enable path with origin `first-run` (only `claude-hooks` has one before cut 4a). */
  private async enable(id: IntegrationId): Promise<ToggleFailure | null> {
    if (id !== CLAUDE_HOOKS) {
      throw new HostInvariantError(`the first-run step cannot offer ${id}: no enable path yet`)
    }
    const result = await this.deps.integrations.setClaudeHooks(true, 'first-run')
    return result.ok ? null : result.error
  }

  /** An unticked (or hidden) option: only an old-app entry is reverted, and only when it is off. */
  private async decline(id: IntegrationId): Promise<ToggleFailure | null> {
    const { cutFilter, integrations, legacy } = this.deps
    if (!cutFilter.includes(id) || integrations.integrationState(id) !== 'off') return null
    const target = TARGET_OF[id]
    if (!(await legacy.findLegacy(target))) return null
    const reverted = await legacy.revert(target)
    this.deps.bus.publish({
      type: 'IntegrationChanged',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload: { id, state: integrations.integrationState(id) }
    })
    return reverted.ok ? null : 'config-revert-failed'
  }

  private currentStates(failures: Partial<Record<IntegrationId, ToggleFailure>>): WelcomeResult {
    const entry = (id: IntegrationId) => {
      const failure = failures[id]
      const state = this.deps.integrations.integrationState(id)
      return failure === undefined ? { state } : { state, failure }
    }
    return {
      'claude-hooks': entry('claude-hooks'),
      'opencode-permissions': entry('opencode-permissions')
    }
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
