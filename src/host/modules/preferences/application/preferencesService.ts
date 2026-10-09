// The preferences use cases of cut 1 (05 §3.12; 16 §4.12): `PreferencesCommands.set` and
// `PreferencesQueries.get` over the `host_preferences` singleton, and `PreferencesQueries.featureFlags`,
// the flags the `FeatureFlagReader` read once when the service was built (INV-110), and
// `PreferencesQueries.integrationState`, `off` for every integration until the integration store
// joins (later: ISSUE-323). `WelcomeStepService` below is `PreferencesQueries.welcome` and the
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
  IntegrationState
} from '../../../kernel/domain/values'
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
import type { ConfigTarget, ExternalConfigWriter } from '../ports/externalConfigWriter'
import type { FeatureFlagReader, FeatureFlags } from '../ports/featureFlagReader'
import type { InstalledToolsReader } from '../ports/installedToolsReader'
import type { WelcomeAnswerStore } from '../ports/welcomeAnswerStore'
import type { PreferencesStore } from '../ports/preferencesStore'

/** Driving port (05 §3.12): cut 1's member; the others join with their issues. */
export interface PreferencesCommands {
  /** Returns what was STORED (IPC Gap 10). */
  set<K extends HostPreferenceKey>(key: K, value: HostPreferences[K]): HostPreferences
}

/** Driving port (05 §3.12): cut 1's member; the others join with their issues. */
export interface PreferencesQueries {
  get(): HostPreferences
  featureFlags(): FeatureFlags
  integrationState(id: IntegrationId): IntegrationState
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
}

export class PreferencesService implements PreferencesCommands, PreferencesQueries {
  /** Read once, at construction (Host start); never re-read while the Host runs (INV-110). */
  private readonly flags: FeatureFlags

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
   * 16 §4.12, the `IntegrationGateReader` bridge's target. Fail closed until the integration store
   * joins (later: ISSUE-323): every integration is `off`, the new-install value (ADR-011 item 7;
   * 18 C-27), so a gated provider's answer channel stays closed.
   */
  integrationState(_id: IntegrationId): IntegrationState {
    return 'off'
  }
}

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
