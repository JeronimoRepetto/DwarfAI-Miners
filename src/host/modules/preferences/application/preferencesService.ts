// The preferences use cases of cut 1 (05 §3.12; 16 §4.12): `PreferencesCommands.set` and
// `PreferencesQueries.get` over the `host_preferences` singleton, and `PreferencesQueries.featureFlags`,
// the flags the `FeatureFlagReader` read once when the service was built (INV-110), and
// `PreferencesQueries.integrationState`, `off` for every integration until the integration store
// joins (later: ISSUE-323). The other members of the driving ports (secrets, the integration toggles,
// the first-run step) join with their issues (later: ISSUE-215, ISSUE-216, ISSUE-218…ISSUE-225);
// Reset metrics is the saga's (resetSaga.ts), joined to the commands by host/wiring.
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
import type { FeatureFlagReader, FeatureFlags } from '../ports/featureFlagReader'
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
