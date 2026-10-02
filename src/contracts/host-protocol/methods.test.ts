import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { DwarfId, HostEpoch, HostPreferences, Instant, PreferencesView } from '../wire'
import {
  HOST_METHOD_SCHEMAS,
  type HostMethods,
  type HostShutdownParams,
  type HostShutdownResult,
  type SubscribeParams,
  type SubscribeResult
} from './methods'
import type {
  HostPreferenceKey,
  MetricsResetResult,
  PreferenceSetParams,
  ResetMetricsParams
} from './params/preferences'

// The B-M02, B-M05 and B-M06 entries of 14 §3.4 and their strict() schemas (14 §1.4).

describe('ping params and result (14 §3.4, B-M02)', () => {
  it('[ADR-003] the ping schemas infer exactly the 14 §3.4 entry and refuse any other key', () => {
    expectTypeOf<HostMethods['ping']['result']>().toEqualTypeOf<{ at: Instant }>()
    expectTypeOf<z.infer<(typeof HOST_METHOD_SCHEMAS)['ping']['result']>>().toEqualTypeOf<
      HostMethods['ping']['result']
    >()
    expectTypeOf<z.infer<(typeof HOST_METHOD_SCHEMAS)['ping']['params']>>().toEqualTypeOf<
      HostMethods['ping']['params']
    >()

    const { params, result } = HOST_METHOD_SCHEMAS.ping
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ at: 1 }).success).toBe(false)
    expect(result.safeParse({ at: 1_000 }).success).toBe(true)
    expect(result.safeParse({ at: -1 }).success).toBe(false)
    expect(result.safeParse({ at: 1.5 }).success).toBe(false)
    expect(result.safeParse({ at: 1_000, seq: 1 }).success).toBe(false)
  })
})

describe('host.shutdown params and result (14 §3.4, B-M05)', () => {
  const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
  const DWARF_ID = '01890a5d-ac96-774b-bcce-b302099a8058'

  it('[ADR-002] the host.shutdown schemas infer exactly the 14 §3.4 entry, keep the generation-stable params shape and refuse any other key', () => {
    expectTypeOf<HostMethods['host.shutdown']['params']>().toEqualTypeOf<HostShutdownParams>()
    expectTypeOf<HostMethods['host.shutdown']['result']>().toEqualTypeOf<HostShutdownResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['host.shutdown']['params']>
    >().toEqualTypeOf<HostShutdownParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['host.shutdown']['result']>
    >().toEqualTypeOf<HostShutdownResult>()
    expectTypeOf<Extract<HostShutdownResult, { mode: 'stop-all' }>['outcome']>().toEqualTypeOf<{
      ended: DwarfId[]
      failed: DwarfId[]
    }>()

    const { params, result } = HOST_METHOD_SCHEMAS['host.shutdown']
    // The wire keeps every mode of the generation-stable shape (14 §1.3); the Host refuses the
    // ones it does not serve, with INVALID_PARAMS (hostShutdown.ts).
    for (const mode of ['when-idle', 'stop-all', 'upgrade-drain']) {
      expect(params.safeParse({ mode, requestId: REQUEST_ID }).success, mode).toBe(true)
    }
    expect(params.safeParse({ mode: 'stop-all' }).success).toBe(false)
    expect(params.safeParse({ mode: 'stop-all', requestId: 'not-a-uuid' }).success).toBe(false)
    expect(params.safeParse({ mode: 'idle', requestId: REQUEST_ID }).success).toBe(false)
    expect(params.safeParse({ mode: 'stop-all', requestId: REQUEST_ID, force: true }).success).toBe(
      false
    )

    expect(
      result.safeParse({ mode: 'stop-all', outcome: { ended: [DWARF_ID], failed: [] } }).success
    ).toBe(true)
    expect(result.safeParse({ mode: 'stop-all', outcome: { ended: [] } }).success).toBe(false)
    expect(
      result.safeParse({ mode: 'stop-all', outcome: { ended: ['d-1'], failed: [] } }).success
    ).toBe(false)
    expect(result.safeParse({ mode: 'upgrade-drain', accepted: true }).success).toBe(true)
    expect(result.safeParse({ mode: 'stop-all', accepted: true }).success).toBe(false)
  })
})

// The B-M03 entry of 14 §3.4 and its strict() schemas (14 §1.4).

describe('events.subscribe params and result (14 §3.4, B-M03)', () => {
  it('[ADR-003] the events.subscribe schemas infer exactly the 14 §3.4 SubscribeParams and SubscribeResult and refuse any other key', () => {
    expectTypeOf<HostMethods['events.subscribe']['params']>().toEqualTypeOf<SubscribeParams>()
    expectTypeOf<HostMethods['events.subscribe']['result']>().toEqualTypeOf<SubscribeResult>()
    expectTypeOf<SubscribeParams>().toEqualTypeOf<{
      resume?: { epoch: HostEpoch; lastSeq: number }
    }>()
    expectTypeOf<SubscribeResult>().toEqualTypeOf<
      | { status: 'replaying'; fromSeq: number; toSeq: number }
      | { status: 'live'; fromSeq: number }
      | { status: 'resync-required' }
    >()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['events.subscribe']['params']>
    >().toEqualTypeOf<SubscribeParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['events.subscribe']['result']>
    >().toEqualTypeOf<SubscribeResult>()

    const { params, result } = HOST_METHOD_SCHEMAS['events.subscribe']
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ resume: { epoch: 'epoch-1', lastSeq: 7 } }).success).toBe(true)
    expect(params.safeParse({ resume: { epoch: 'epoch-1', lastSeq: -1 } }).success).toBe(false)
    expect(params.safeParse({ resume: { epoch: 'epoch-1', lastSeq: 1.5 } }).success).toBe(false)
    expect(params.safeParse({ resume: { epoch: 'epoch-1' } }).success).toBe(false)
    expect(params.safeParse({ resume: { epoch: 'e', lastSeq: 1, at: 1 } }).success).toBe(false)
    expect(params.safeParse({ lastSeq: 1 }).success).toBe(false)
    expect(result.safeParse({ status: 'replaying', fromSeq: 8, toSeq: 9 }).success).toBe(true)
    expect(result.safeParse({ status: 'live', fromSeq: 1 }).success).toBe(true)
    expect(result.safeParse({ status: 'resync-required' }).success).toBe(true)
    expect(result.safeParse({ status: 'live' }).success).toBe(false)
    expect(result.safeParse({ status: 'live', fromSeq: 1, toSeq: 2 }).success).toBe(false)
    expect(result.safeParse({ status: 'resync-required', reason: 'backpressure' }).success).toBe(
      false
    )
  })
})

describe('host.upgrade.request params and result (14 §3.4, B-M06)', () => {
  const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

  it('[ADR-002] the host.upgrade.request schemas infer exactly the 14 §3.4 entry and refuse any other key', () => {
    expectTypeOf<HostMethods['host.upgrade.request']['params']>().toEqualTypeOf<{
      targetVersion: string
      targetDir: string
      requestId: string
    }>()
    expectTypeOf<HostMethods['host.upgrade.request']['result']>().toEqualTypeOf<{
      state: 'upgrade-pending'
    }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['host.upgrade.request']['params']>
    >().toEqualTypeOf<HostMethods['host.upgrade.request']['params']>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['host.upgrade.request']['result']>
    >().toEqualTypeOf<HostMethods['host.upgrade.request']['result']>()

    const { params, result } = HOST_METHOD_SCHEMAS['host.upgrade.request']
    const valid = { targetVersion: '0.21.0', targetDir: '/data/j/dwarfai/host/0.21.0' }
    expect(params.safeParse({ ...valid, requestId: REQUEST_ID }).success).toBe(true)
    expect(params.safeParse(valid).success).toBe(false)
    expect(params.safeParse({ ...valid, requestId: 'not-a-uuid' }).success).toBe(false)
    expect(params.safeParse({ ...valid, requestId: REQUEST_ID, force: true }).success).toBe(false)
    expect(result.safeParse({ state: 'upgrade-pending' }).success).toBe(true)
    expect(result.safeParse({ state: 'ready' }).success).toBe(false)
    expect(result.safeParse({ state: 'upgrade-pending', at: 1 }).success).toBe(false)
  })
})

// The B-M12 and B-M13 entries of 14 §3.4 and their strict() schemas (14 §1.4).

describe('preferences.get and preferences.set params and result (14 §3.4, B-M12, B-M13)', () => {
  const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
  const STORED = {
    subagentDelegationOn: true,
    routingProfile: 'premium',
    defaultProvider: 'claude',
    defaultModel: 'opus',
    systemNotificationsOn: true,
    openCodePermissionsOn: false
  }
  const VIEW = {
    preferences: STORED,
    secrets: [],
    secretBackend: 'unavailable',
    integrations: [],
    welcome: { due: false, legacyFound: [], offered: [] }
  }

  it('[ADR-024] the preferences.get and preferences.set schemas infer exactly the 14 §3.4 entries and refuse any other key', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
    expectTypeOf<HostMethods['preferences.get']['params']>().toEqualTypeOf<{}>()
    expectTypeOf<HostMethods['preferences.get']['result']>().toEqualTypeOf<PreferencesView>()
    expectTypeOf<HostMethods['preferences.set']['params']>().toEqualTypeOf<PreferenceSetParams>()
    expectTypeOf<HostMethods['preferences.set']['result']>().toEqualTypeOf<HostPreferences>()
    expectTypeOf<HostPreferenceKey>().toEqualTypeOf<
      | 'subagentDelegationOn'
      | 'routingProfile'
      | 'defaultProvider'
      | 'defaultModel'
      | 'defaultEffort'
      | 'systemNotificationsOn'
    >()
    expectTypeOf<Extract<PreferenceSetParams, { key: 'defaultProvider' }>>().toEqualTypeOf<{
      key: 'defaultProvider'
      value: string | undefined
      requestId: string
    }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['preferences.get']['params']>
    >().toEqualTypeOf<HostMethods['preferences.get']['params']>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['preferences.get']['result']>
    >().toEqualTypeOf<PreferencesView>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['preferences.set']['params']>
    >().toEqualTypeOf<PreferenceSetParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['preferences.set']['result']>
    >().toEqualTypeOf<HostPreferences>()

    const get = HOST_METHOD_SCHEMAS['preferences.get']
    expect(get.params.safeParse({}).success).toBe(true)
    expect(get.params.safeParse({ keys: ['routingProfile'] }).success).toBe(false)
    expect(get.result.safeParse(VIEW).success).toBe(true)
    expect(get.result.safeParse({ ...VIEW, flags: {} }).success).toBe(false)

    const { result } = HOST_METHOD_SCHEMAS['preferences.set']
    expect(result.safeParse(STORED).success).toBe(true)
    expect(result.safeParse({ ...STORED, notificationSoundsOn: true }).success).toBe(false)
    expect(result.safeParse({ ...STORED, routingProfile: 'fast' }).success).toBe(false)
  })

  it('[ADR-003] preferences.set takes one writable key with its value: a catalog provider or none as the default provider, never Other or the derived openCodePermissionsOn', () => {
    const { params } = HOST_METHOD_SCHEMAS['preferences.set']
    const set = (key: string, value?: unknown, extra: object = {}) =>
      params.safeParse({
        key,
        ...(value === undefined ? {} : { value }),
        requestId: REQUEST_ID,
        ...extra
      })

    expect(set('subagentDelegationOn', true).success).toBe(true)
    expect(set('routingProfile', 'economy').success).toBe(true)
    expect(set('defaultProvider', 'codex').success).toBe(true)
    expect(set('defaultModel', 'gpt-5-codex').success).toBe(true)
    expect(set('defaultEffort', 'high').success).toBe(true)
    expect(set('systemNotificationsOn', false).success).toBe(true)
    // "None": the optional keys are cleared by leaving the value out (JSON has no undefined).
    const none = set('defaultProvider')
    expect(none.success).toBe(true)
    expect(none.data).toStrictEqual({
      key: 'defaultProvider',
      value: undefined,
      requestId: REQUEST_ID
    })
    expect(set('defaultModel').success).toBe(true)
    expect(set('defaultEffort').success).toBe(true)

    expect(set('subagentDelegationOn').success).toBe(false)
    expect(set('subagentDelegationOn', 'yes').success).toBe(false)
    expect(set('routingProfile', 'fast').success).toBe(false)
    expect(set('defaultProvider', 'other').success).toBe(false)
    expect(set('defaultProvider', 'Other…').success).toBe(false)
    expect(set('defaultProvider', null).success).toBe(false)
    expect(set('defaultModel', 7).success).toBe(false)
    expect(set('openCodePermissionsOn', true).success).toBe(false)
    expect(set('notificationSoundsOn', true).success).toBe(false)
    expect(set('jev-key', 'secret').success).toBe(false)
    expect(set('routingProfile', 'economy', { origin: 'settings' }).success).toBe(false)
    expect(params.safeParse({ key: 'routingProfile', value: 'economy' }).success).toBe(false)
    expect(
      params.safeParse({ key: 'routingProfile', value: 'economy', requestId: 'not-a-uuid' }).success
    ).toBe(false)
  })
})

// The B-M09 and B-M15 entries of 14 §3.4 and their strict() schemas (14 §1.4).

describe('ui.resetPreferences.ack and preferences.resetMetrics params and result (14 §3.4, B-M09, B-M15)', () => {
  const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

  it('[ADR-023] the B-M09 and B-M15 schemas infer exactly the 14 §3.4 entries and refuse any other key or a confirmation other than yes', () => {
    expectTypeOf<HostMethods['ui.resetPreferences.ack']['params']>().toEqualTypeOf<{
      epoch: number
    }>()
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
    expectTypeOf<HostMethods['ui.resetPreferences.ack']['result']>().toEqualTypeOf<{}>()
    expectTypeOf<
      HostMethods['preferences.resetMetrics']['params']
    >().toEqualTypeOf<ResetMetricsParams>()
    expectTypeOf<
      HostMethods['preferences.resetMetrics']['result']
    >().toEqualTypeOf<MetricsResetResult>()
    expectTypeOf<ResetMetricsParams>().toEqualTypeOf<{ confirmed: 'yes'; requestId: string }>()

    const ack = HOST_METHOD_SCHEMAS['ui.resetPreferences.ack']
    expect(ack.params.safeParse({ epoch: 3 }).success).toBe(true)
    expect(ack.params.safeParse({ epoch: 0 }).success).toBe(false)
    expect(ack.params.safeParse({ epoch: 1.5 }).success).toBe(false)
    expect(ack.params.safeParse({}).success).toBe(false)
    expect(ack.params.safeParse({ epoch: 3, requestId: REQUEST_ID }).success).toBe(false)
    expect(ack.result.safeParse({}).success).toBe(true)
    expect(ack.result.safeParse({ epoch: 3 }).success).toBe(false)

    const reset = HOST_METHOD_SCHEMAS['preferences.resetMetrics']
    expect(reset.params.safeParse({ confirmed: 'yes', requestId: REQUEST_ID }).success).toBe(true)
    for (const confirmed of ['YES', ' yes', 'no', true, '']) {
      expect(
        reset.params.safeParse({ confirmed, requestId: REQUEST_ID }).success,
        String(confirmed)
      ).toBe(false)
    }
    expect(reset.params.safeParse({ confirmed: 'yes' }).success).toBe(false)
    expect(
      reset.params.safeParse({ confirmed: 'yes', requestId: REQUEST_ID, force: true }).success
    ).toBe(false)
    expect(reset.result.safeParse({ outcome: 'reset', epoch: 2 }).success).toBe(true)
    expect(
      reset.result.safeParse({ outcome: 'failed', reason: 'secrets', resumesOnNextStart: true })
        .success
    ).toBe(true)
    expect(reset.result.safeParse({ outcome: 'reset' }).success).toBe(false)
    expect(reset.result.safeParse({ outcome: 'failed', reason: 'secrets' }).success).toBe(false)
    expect(reset.result.safeParse({ outcome: 'done', epoch: 2 }).success).toBe(false)
  })
})
