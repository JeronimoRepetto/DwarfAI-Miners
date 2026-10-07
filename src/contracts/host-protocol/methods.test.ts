import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  HostPreferences,
  Instant,
  MineId,
  PreferencesView,
  StranglerDwarfIdentity
} from '../wire'
import {
  HOST_METHOD_SCHEMAS,
  type HostMethods,
  type HostShutdownParams,
  type HostShutdownResult,
  type PresenceParams,
  type RemoveMineResult,
  type SubscribeParams,
  type SubscribeResult
} from './methods'
import type {
  HostPreferenceKey,
  MetricsResetResult,
  PreferenceSetParams,
  ResetMetricsParams
} from './params/preferences'
import type {
  AdoptMainProjectResult,
  DeclareMineResult,
  MineListParams,
  MineListResult,
  MineSummaryWire,
  ResolveFileResult
} from './params/mines'
import type { FeedPage, MineHistoryView } from '../wire'
import type { FeedParams } from './params/conversation'

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

// The B-M41 entry of 14 §3.4 and its strict() schemas (14 §1.4; AMENDMENT-8, OQ-69): strangler-only,
// deleted with LegacyDwarfIdBridge at the end of cut 4.

describe('strangler.dwarfIdentities params and result (14 §3.4, B-M41)', () => {
  it('[ADR-015] the strangler.dwarfIdentities schemas infer exactly the 14 §3.4 entry and refuse any other key', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
    expectTypeOf<HostMethods['strangler.dwarfIdentities']['params']>().toEqualTypeOf<{}>()
    expectTypeOf<HostMethods['strangler.dwarfIdentities']['result']>().toEqualTypeOf<
      StranglerDwarfIdentity[]
    >()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['strangler.dwarfIdentities']['params']>
    >().toEqualTypeOf<HostMethods['strangler.dwarfIdentities']['params']>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['strangler.dwarfIdentities']['result']>
    >().toEqualTypeOf<StranglerDwarfIdentity[]>()

    const { params, result } = HOST_METHOD_SCHEMAS['strangler.dwarfIdentities']
    const record = {
      dwarfId: '01890a5d-ac96-774b-bcce-b302099a8058',
      providerId: 'claude',
      identity: { providerId: 'claude', providerSessionId: 'session-1', providerAgentId: 'agent-1' }
    }
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ mineId: 'm' }).success).toBe(false)
    expect(result.safeParse([]).success).toBe(true)
    expect(result.safeParse([record]).success).toBe(true)
    expect(result.safeParse([{ ...record, legacyId: 'd-1' }]).success).toBe(false)
    expect(result.safeParse([{ ...record, dwarfId: 'session-1' }]).success).toBe(false)
  })
})

// The B-M07 entry of 14 §3.4 and its strict() schemas (14 §1.4): the UI's presence report; the Host
// adds `anyUiAttached` itself (ADR-018 item 2), so the wire never carries it.

describe('presence params and result (14 §3.4, B-M07)', () => {
  const MINE = '01890a5d-ac96-774b-bcce-b302099a8111'

  it('[ADR-018] the presence schemas infer exactly the 14 §3.4 PresenceParams and refuse anyUiAttached or any other key', () => {
    expectTypeOf<HostMethods['presence']['params']>().toEqualTypeOf<PresenceParams>()
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
    expectTypeOf<HostMethods['presence']['result']>().toEqualTypeOf<{}>()
    expectTypeOf<PresenceParams>().toEqualTypeOf<{
      onScreenMineIds: MineId[]
      anyWindowVisible: boolean
      seq: number
    }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['presence']['params']>
    >().toEqualTypeOf<PresenceParams>()

    const { params, result } = HOST_METHOD_SCHEMAS.presence
    const report = { onScreenMineIds: [MINE], anyWindowVisible: true, seq: 1 }
    expect(params.safeParse(report).success).toBe(true)
    expect(params.safeParse({ ...report, onScreenMineIds: [] }).success).toBe(true)
    expect(params.safeParse({ ...report, anyUiAttached: true }).success).toBe(false)
    expect(params.safeParse({ ...report, onScreenMineIds: ['mine-1'] }).success).toBe(false)
    expect(params.safeParse({ ...report, seq: 1.5 }).success).toBe(false)
    expect(params.safeParse({ ...report, seq: -1 }).success).toBe(false)
    expect(params.safeParse({ onScreenMineIds: [MINE], seq: 1 }).success).toBe(false)
    expect(result.safeParse({}).success).toBe(true)
    expect(result.safeParse({ seq: 1 }).success).toBe(false)
  })
})

// The B-M08 entry of 14 §3.4 and its strict() schemas (14 §1.4): the notifier reports a click on a
// level-3 notification by its key, for a diagnostics counter only (ADR-018 item 6).

describe('attention.clicked params and result (14 §3.4, B-M08)', () => {
  it('[ADR-003] the attention.clicked schemas infer exactly {key} and {}, and refuse any other key', () => {
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('attention.clicked')
    expectTypeOf<HostMethods['attention.clicked']['params']>().toEqualTypeOf<{ key: string }>()
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
    expectTypeOf<HostMethods['attention.clicked']['result']>().toEqualTypeOf<{}>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['attention.clicked']['params']>
    >().toEqualTypeOf<{ key: string }>()

    const { params, result } = HOST_METHOD_SCHEMAS['attention.clicked']
    expect(params.safeParse({ key: 'd:question:ask-1' }).success).toBe(true)
    expect(params.safeParse({ key: 1 }).success).toBe(false)
    expect(params.safeParse({}).success).toBe(false)
    expect(params.safeParse({ key: 'k', requestId: 'r' }).success).toBe(false)
    expect(result.safeParse({}).success).toBe(true)
    expect(result.safeParse({ counted: 1 }).success).toBe(false)
  })
})

describe('mines.list params and result (14 §3.4, B-M19)', () => {
  it('[ADR-019] the mines.list schemas infer exactly the 14 §3.4 entry and refuse any other key', () => {
    expectTypeOf<HostMethods['mines.list']['params']>().toEqualTypeOf<MineListParams>()
    expectTypeOf<HostMethods['mines.list']['result']>().toEqualTypeOf<MineListResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.list']['result']>
    >().toEqualTypeOf<MineListResult>()
    expectTypeOf<MineListResult['mines'][number]>().toEqualTypeOf<MineSummaryWire>()

    const { params, result } = HOST_METHOD_SCHEMAS['mines.list']
    expect(params.safeParse({ sortBy: 'lastUsed', direction: 'desc' }).success).toBe(true)
    expect(
      params.safeParse({
        tier: 'uranium',
        sortBy: 'ore',
        direction: 'asc',
        nameContains: 'repo',
        limit: 500,
        offset: 0
      }).success
    ).toBe(true)
    expect(params.safeParse({ sortBy: 'lastOpenedAt', direction: 'desc' }).success).toBe(false)
    expect(params.safeParse({ sortBy: 'name', direction: 'asc', requestId: 'x' }).success).toBe(
      false
    )
    const summary = {
      mineId: '01890a5d-ac96-774b-bcce-b302099a8057',
      name: 'repo',
      path: '/work/repo',
      tier: null,
      lastUsedAt: 1,
      presentDwarfs: 0,
      removed: false
    }
    expect(result.safeParse({ mines: [summary], total: 1 }).success).toBe(true)
    expect(result.safeParse({ mines: [{ ...summary, ore: 1 }], total: 1 }).success).toBe(false)
    expect(result.safeParse({ mines: [], total: -1 }).success).toBe(false)
  })
})

describe('mines.declare, mines.adoptMainProject and mines.resolveFile (14 §3.4, B-M16, B-M17, B-M20)', () => {
  it('[ADR-019] the B-M16, B-M17 and B-M20 schemas infer exactly the 14 §3.4 entries and refuse any other key', () => {
    expectTypeOf<HostMethods['mines.declare']['params']>().toEqualTypeOf<{
      path: FolderPath
      requestId: string
    }>()
    expectTypeOf<HostMethods['mines.declare']['result']>().toEqualTypeOf<DeclareMineResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.declare']['result']>
    >().toEqualTypeOf<DeclareMineResult>()
    expectTypeOf<HostMethods['mines.adoptMainProject']['params']>().toEqualTypeOf<{
      worktreePath: FolderPath
      requestId: string
    }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.adoptMainProject']['result']>
    >().toEqualTypeOf<AdoptMainProjectResult>()
    expectTypeOf<HostMethods['mines.resolveFile']['params']>().toEqualTypeOf<{
      mineId: MineId
      dwarfId?: DwarfId
      target: string
    }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.resolveFile']['result']>
    >().toEqualTypeOf<ResolveFileResult>()

    const MINE = '01890a5d-ac96-774b-bcce-b302099a8057'
    const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8058'
    const declare = HOST_METHOD_SCHEMAS['mines.declare']
    expect(declare.params.safeParse({ path: '/work/repo', requestId: REQUEST }).success).toBe(true)
    expect(declare.params.safeParse({ path: '/work/repo' }).success).toBe(false)
    expect(
      declare.params.safeParse({ path: '/work/repo', requestId: REQUEST, name: 'x' }).success
    ).toBe(false)
    // Amended: a worktree answer carries the main working tree's path (owner amendment G, 2026-10-07).
    expect(
      declare.result.safeParse({ ok: true, value: { worktreeOf: MINE, mainPath: '/work/repo' } })
        .success
    ).toBe(true)
    expect(declare.result.safeParse({ ok: true, value: { worktreeOf: MINE } }).success).toBe(false)
    expect(
      declare.result.safeParse({ ok: true, value: { mineId: MINE, worktreeOf: MINE } }).success
    ).toBe(false)
    expect(declare.result.safeParse({ ok: false, error: 'cancelled' }).success).toBe(false)

    const adopt = HOST_METHOD_SCHEMAS['mines.adoptMainProject']
    expect(adopt.params.safeParse({ worktreePath: '/work/feat', requestId: REQUEST }).success).toBe(
      true
    )
    expect(adopt.params.safeParse({ path: '/work/feat', requestId: REQUEST }).success).toBe(false)
    expect(adopt.result.safeParse({ ok: false, error: 'no-main-project' }).success).toBe(true)
    expect(adopt.result.safeParse({ ok: true, value: { worktreeOf: MINE } }).success).toBe(false)

    const resolve = HOST_METHOD_SCHEMAS['mines.resolveFile']
    expect(resolve.params.safeParse({ mineId: MINE, target: 'src/a.ts' }).success).toBe(true)
    expect(resolve.params.safeParse({ mineId: MINE, dwarfId: MINE, target: 'a' }).success).toBe(
      true
    )
    expect(resolve.params.safeParse({ mineId: MINE, target: '' }).success).toBe(false)
    expect(
      resolve.params.safeParse({ mineId: MINE, target: 'a', requestId: REQUEST }).success
    ).toBe(false)
    expect(resolve.result.safeParse({ ok: true, value: { path: '/work/a.ts' } }).success).toBe(true)
    expect(resolve.result.safeParse({ ok: false, error: 'outside' }).success).toBe(false)
  })
})

// The B-M26 entry of 14 §3.4 (`FeedParams`) and 14 §3.6 `FeedPageRequest`, `FeedPage`, with their
// strict() schemas (14 §1.4).

describe('conversation.feed params and result (14 §3.4, §3.6, B-M26)', () => {
  const DWARF = '01890a5d-ac96-774b-bcce-b302099a8057'
  const MESSAGE = '01890a5d-ac96-774b-bcce-b302099a8058'
  const view = {
    id: MESSAGE,
    dwarfId: DWARF,
    role: 'dwarf',
    text: 'hello',
    attachments: [],
    providerTime: 1_000,
    createdAt: 1_001
  }

  it('[ADR-003] the conversation.feed schemas infer exactly FeedParams and FeedPage, limit at most 50, and refuse any other key', () => {
    expectTypeOf<HostMethods['conversation.feed']['params']>().toEqualTypeOf<FeedParams>()
    expectTypeOf<HostMethods['conversation.feed']['result']>().toEqualTypeOf<FeedPage>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.feed']['params']>
    >().toEqualTypeOf<FeedParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.feed']['result']>
    >().toEqualTypeOf<FeedPage>()

    const { params, result } = HOST_METHOD_SCHEMAS['conversation.feed']
    expect(params.safeParse({ dwarfId: DWARF }).success).toBe(true)
    expect(params.safeParse({ dwarfId: DWARF, page: {} }).success).toBe(true)
    expect(params.safeParse({ dwarfId: DWARF, page: { before: MESSAGE, limit: 50 } }).success).toBe(
      true
    )
    // At most 50 rows exist per dwarf (PO #87): a larger page is never asked for.
    expect(params.safeParse({ dwarfId: DWARF, page: { limit: 51 } }).success).toBe(false)
    expect(params.safeParse({ dwarfId: DWARF, page: { limit: 0 } }).success).toBe(false)
    expect(params.safeParse({ dwarfId: DWARF, page: { limit: 1.5 } }).success).toBe(false)
    expect(params.safeParse({ dwarfId: DWARF, page: { before: 7 } }).success).toBe(false)
    expect(params.safeParse({ dwarfId: DWARF, page: { cursor: MESSAGE } }).success).toBe(false)
    expect(params.safeParse({ dwarfId: DWARF, mineId: DWARF }).success).toBe(false)
    expect(params.safeParse({ dwarfId: 'claude:s1' }).success).toBe(false)
    expect(params.safeParse({}).success).toBe(false)

    expect(result.safeParse({ dwarfId: DWARF, messages: [view], reachedStart: true }).success).toBe(
      true
    )
    // MessageView never carries the stored row's sourceKey, origin or askId (06 §0.2).
    for (const extra of [{ sourceKey: 'k' }, { origin: 'transcript' }, { askId: MESSAGE }]) {
      expect(
        result.safeParse({ dwarfId: DWARF, messages: [{ ...view, ...extra }], reachedStart: true })
          .success,
        Object.keys(extra)[0]
      ).toBe(false)
    }
    expect(result.safeParse({ dwarfId: DWARF, messages: [] }).success).toBe(false)
    expect(
      result.safeParse({ dwarfId: DWARF, messages: [], reachedStart: true, next: MESSAGE }).success
    ).toBe(false)
  })
})

// The B-M27 entry of 14 §3.4 and 14 §3.6 `MineHistoryView`, with their strict() schemas (14 §1.4).

describe('conversation.mineHistory params and result (14 §3.4, §3.6, B-M27)', () => {
  const MINE = '01890a5d-ac96-774b-bcce-b302099a8050'
  const DWARF = '01890a5d-ac96-774b-bcce-b302099a8057'
  const MESSAGE = '01890a5d-ac96-774b-bcce-b302099a8058'
  const view = {
    id: MESSAGE,
    dwarfId: DWARF,
    role: 'person',
    text: 'hello',
    attachments: [],
    delivery: {
      messageId: MESSAGE,
      dwarfId: DWARF,
      kind: 'message',
      phase: 'failed',
      failure: { kind: 'session-closed' },
      attempts: 1,
      phaseAt: 1_002
    },
    providerTime: null,
    createdAt: 1_001
  }
  // Amended: each speaker carries its rank and provider (owner amendment F, 2026-10-07).
  const speaker = {
    dwarfId: DWARF,
    displayName: 'Dáin',
    rank: 'foreman',
    providerId: 'claude',
    departed: true,
    messages: [view]
  }

  it('[ADR-003] the conversation.mineHistory schemas infer exactly { mineId } and MineHistoryView, and refuse any other key', () => {
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('conversation.mineHistory')
    expectTypeOf<HostMethods['conversation.mineHistory']['params']>().toEqualTypeOf<{
      mineId: MineId
    }>()
    expectTypeOf<
      HostMethods['conversation.mineHistory']['result']
    >().toEqualTypeOf<MineHistoryView>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.mineHistory']['params']>
    >().toEqualTypeOf<{ mineId: MineId }>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.mineHistory']['result']>
    >().toEqualTypeOf<MineHistoryView>()

    const { params, result } = HOST_METHOD_SCHEMAS['conversation.mineHistory']
    expect(params.safeParse({ mineId: MINE }).success).toBe(true)
    expect(params.safeParse({ mineId: MINE, limit: 50 }).success).toBe(false)
    expect(params.safeParse({ mineId: 7 }).success).toBe(false)
    expect(params.safeParse({ mineId: 'mine-one' }).success).toBe(false)
    expect(params.safeParse({}).success).toBe(false)

    expect(result.safeParse({ mineId: MINE, speakers: [] }).success).toBe(true)
    expect(result.safeParse({ mineId: MINE, speakers: [speaker] }).success).toBe(true)
    const speakerWithoutRank = Object.fromEntries(
      Object.entries(speaker).filter(([key]) => key !== 'rank')
    )
    expect(result.safeParse({ mineId: MINE, speakers: [speakerWithoutRank] }).success).toBe(false)
    expect(
      result.safeParse({ mineId: MINE, speakers: [{ ...speaker, retry: true }] }).success
    ).toBe(false)
    expect(
      result.safeParse({
        mineId: MINE,
        speakers: [{ ...speaker, messages: [{ ...view, origin: 'transcript' }] }]
      }).success
    ).toBe(false)
    expect(result.safeParse({ mineId: MINE }).success).toBe(false)
  })
})

// The B-M18 entry of 14 §3.4 (`RemoveMineResult`) and its strict() schemas (14 §1.4).

describe('mines.remove params and result (14 §3.4, B-M18)', () => {
  it('[US-MINES-006.AC09, ADR-014] the mines.remove schemas infer exactly the 14 §3.4 entry, answer only ok or dwarf-could-not-be-ended, and refuse any other key', () => {
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('mines.remove')
    expectTypeOf<HostMethods['mines.remove']['params']>().toEqualTypeOf<{
      mineId: MineId
      requestId: string
    }>()
    expectTypeOf<HostMethods['mines.remove']['result']>().toEqualTypeOf<RemoveMineResult>()
    expectTypeOf<z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.remove']['params']>>().toEqualTypeOf<
      HostMethods['mines.remove']['params']
    >()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['mines.remove']['result']>
    >().toEqualTypeOf<RemoveMineResult>()

    const MINE = '01890a5d-ac96-774b-bcce-b302099a8057'
    const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8058'
    const { params, result } = HOST_METHOD_SCHEMAS['mines.remove']
    expect(params.safeParse({ mineId: MINE, requestId: REQUEST }).success).toBe(true)
    expect(params.safeParse({ mineId: MINE }).success).toBe(false)
    expect(params.safeParse({ mineId: 'alpha', requestId: REQUEST }).success).toBe(false)
    expect(params.safeParse({ mineId: MINE, requestId: REQUEST, force: true }).success).toBe(false)
    expect(result.safeParse({ ok: true, value: {} }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'dwarf-could-not-be-ended' }).success).toBe(true)
    // The failed dwarfs reach the UI only in the one toast frame (PO #79), never in the result.
    expect(result.safeParse({ ok: true, value: { failed: [MINE] } }).success).toBe(false)
    expect(result.safeParse({ ok: false, error: 'could-not-end' }).success).toBe(false)
  })
})
