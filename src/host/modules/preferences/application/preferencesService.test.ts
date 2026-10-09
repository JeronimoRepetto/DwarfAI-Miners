// layer: L2
// L2 (17 §1.2): the preferences use cases over the in-memory store, a recording bus that refuses a
// publish inside a transaction (16 §2.3), a FakeClock and a sequence id generator (16 §4.12, INV-105,
// ADR-024 D9; 08 `HostPreferencesChanged`; 09 §4.8, §4.9).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { PreferencesEvent } from '../domain/events'
import { FakeExternalConfigWriter } from '../ports/fakes/FakeExternalConfigWriter'
import { FakeFeatureFlagReader } from '../ports/fakes/FakeFeatureFlagReader'
import { InMemoryChannelTokenStore } from '../ports/fakes/InMemoryChannelTokenStore'
import { InMemoryIntegrationSettingStore } from '../ports/fakes/InMemoryIntegrationSettingStore'
import { InMemoryPreferencesStore } from '../ports/fakes/InMemoryPreferencesStore'
import { PreferencesService } from './preferencesService'

const T0 = 1_750_000_000_000
const EPOCH = 'epoch-0210'

function service() {
  const store = new InMemoryPreferencesStore()
  let open = false
  let transactions = 0
  const runner: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      const before = store.snapshot()
      open = true
      transactions += 1
      try {
        return work()
      } catch (error) {
        store.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<PreferencesEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const clock = new FakeClock(T0)
  const preferences = new PreferencesService({
    store,
    transactions: runner,
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    featureFlags: new FakeFeatureFlagReader(),
    // AMENDED for ISSUE-221: the integration toggle's deps, never reached by this suite.
    integrations: new InMemoryIntegrationSettingStore(),
    tokens: new InMemoryChannelTokenStore(),
    externalConfig: new FakeExternalConfigWriter(),
    mintCredential: () => {
      throw new Error('this suite mints no credential')
    }
  })
  return { preferences, store, bus, transactions: () => transactions }
}

describe('PreferencesCommands.set', () => {
  it('[INV-105] set returns the stored preferences and publishes HostPreferencesChanged once', () => {
    const { preferences, store, bus, transactions } = service()

    const routed = preferences.set('routingProfile', 'premium')

    expect(routed).toStrictEqual({
      subagentDelegationOn: false,
      routingProfile: 'premium',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    })
    expect(routed).toStrictEqual(store.load())
    expect(transactions()).toBe(1)
    expect(bus.ofType('HostPreferencesChanged')).toHaveLength(1)
    expect(bus.published[0]).toMatchObject({
      type: 'HostPreferencesChanged',
      v: 1,
      at: T0,
      hostEpoch: EPOCH,
      payload: { preferences: routed }
    })

    // A model without a provider is not kept: the answer is the stored row, not the request.
    const modelOnly = preferences.set('defaultModel', 'opus')
    expect(modelOnly).toStrictEqual(routed)
    expect(modelOnly).not.toHaveProperty('defaultModel')
    expect(bus.published).toHaveLength(1)

    preferences.set('defaultProvider', 'claude')
    const model = preferences.set('defaultModel', 'opus')
    expect(model).toStrictEqual({ ...routed, defaultProvider: 'claude', defaultModel: 'opus' })
    expect(model).toStrictEqual(store.load())
    expect(bus.ofType('HostPreferencesChanged').map((e) => e.payload.preferences)).toStrictEqual([
      routed,
      { ...routed, defaultProvider: 'claude' },
      model
    ])
  })

  it('[INV-105] clearing the default provider clears its default model and effort', () => {
    const { preferences, store } = service()
    preferences.set('defaultProvider', 'codex')
    preferences.set('defaultModel', 'gpt-5-codex')
    preferences.set('defaultEffort', 'high')

    const cleared = preferences.set('defaultProvider', undefined)

    expect(cleared).toStrictEqual({
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    })
    expect(store.load()).toStrictEqual(cleared)
  })

  it('[INV-105] setting a key to its current value publishes nothing', () => {
    const { preferences, bus } = service()
    preferences.set('subagentDelegationOn', true)
    expect(bus.published).toHaveLength(1)

    const same = preferences.set('subagentDelegationOn', true)
    preferences.set('systemNotificationsOn', true)
    preferences.set('defaultProvider', undefined)

    expect(same.subagentDelegationOn).toBe(true)
    expect(bus.published).toHaveLength(1)
  })

  it('[US-DLG-001.AC01] a fresh store reads the migration-1 defaults: delegation off, routing balanced, notifications on, no default provider', () => {
    const { preferences, bus } = service()

    expect(preferences.get()).toStrictEqual({
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    })
    expect(bus.published).toHaveLength(0)
  })
})

describe('PreferencesQueries.integrationState', () => {
  it('[ADR-011] before the integration store joins every integration reads off, the new-install value', () => {
    const { preferences, bus } = service()

    expect([
      preferences.integrationState('opencode-permissions'),
      preferences.integrationState('claude-hooks')
    ]).toStrictEqual(['off', 'off'])
    expect(bus.published).toHaveLength(0)
  })
})
