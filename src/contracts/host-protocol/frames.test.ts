import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type {
  AttentionKind,
  DwarfId,
  DwarfWire,
  Material,
  MaterialAmount,
  MineId,
  MineWire,
  OsNotification,
  PreferencesView,
  ResetId
} from '../wire'
import type { HelloOk } from './adr-003'
import { HOST_FRAME_SCHEMAS, SENSITIVE_FRAMES, type HostFrames } from './frames'
import type { DepartureCause } from './params/crew'
import type { ResetStep } from './params/preferences'

// The B-F04 and B-F05 payloads of 14 §3.5 and their strict() schemas (14 §1.4).

describe('host.state and host.closing payloads (14 §3.5, B-F04, B-F05)', () => {
  it('[ADR-002] each lifecycle frame schema infers exactly its 14 §3.5 payload and refuses any other key', () => {
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['host.state']>>().toEqualTypeOf<
      HostFrames['host.state']
    >()
    expectTypeOf<HostFrames['host.state']>().toEqualTypeOf<{
      state: HelloOk['state']
      jobStatus: HelloOk['jobStatus']
    }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['host.closing']>>().toEqualTypeOf<
      HostFrames['host.closing']
    >()
    expectTypeOf<HostFrames['host.closing']>().toEqualTypeOf<{
      reason: 'idle' | 'stop-all' | 'upgrade' | 'os-session-end'
      clean: true
    }>()

    const state = HOST_FRAME_SCHEMAS['host.state']
    const closing = HOST_FRAME_SCHEMAS['host.closing']
    expect(state.safeParse({ state: 'upgrade-pending', jobStatus: 'in-job' }).success).toBe(true)
    expect(state.safeParse({ state: 'ready', jobStatus: 'none', extra: 1 }).success).toBe(false)
    expect(state.safeParse({ state: 'checkpointing', jobStatus: 'none' }).success).toBe(false)
    expect(closing.safeParse({ reason: 'os-session-end', clean: true }).success).toBe(true)
    expect(closing.safeParse({ reason: 'stop-all', clean: false }).success).toBe(false)
    expect(closing.safeParse({ reason: 'stop-all', clean: true, at: 1 }).success).toBe(false)
  })
})

// The B-F03 payload of 14 §3.5 and its strict() schema (14 §1.4).

describe('resync-required payload (14 §3.5, B-F03)', () => {
  it('[ADR-003] the resync-required schema infers exactly its 14 §3.5 payload with its five reasons and refuses any other', () => {
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['resync-required']>>().toEqualTypeOf<
      HostFrames['resync-required']
    >()
    expectTypeOf<HostFrames['resync-required']>().toEqualTypeOf<{
      reason:
        'epoch-changed' | 'seq-not-in-ring' | 'ring-overrun' | 'backpressure' | 'metrics-reset'
    }>()

    const resync = HOST_FRAME_SCHEMAS['resync-required']
    for (const reason of [
      'epoch-changed',
      'seq-not-in-ring',
      'ring-overrun',
      'backpressure',
      'metrics-reset'
    ]) {
      expect(resync.safeParse({ reason }).success, reason).toBe(true)
    }
    expect(resync.safeParse({ reason: 'events-lost' }).success).toBe(false)
    expect(resync.safeParse({ reason: 'backpressure', seq: 3 }).success).toBe(false)
    expect(resync.safeParse({}).success).toBe(false)
  })
})

// The B-F24 payload of 14 §3.5 and its strict() schema (14 §1.4).

describe('preferences.changed payload (14 §3.5, B-F24)', () => {
  it('[ADR-024] the preferences.changed schema infers exactly its 14 §3.5 PreferencesView and refuses any other key', () => {
    expectTypeOf<HostFrames['preferences.changed']>().toEqualTypeOf<PreferencesView>()
    expectTypeOf<
      z.infer<(typeof HOST_FRAME_SCHEMAS)['preferences.changed']>
    >().toEqualTypeOf<PreferencesView>()

    const changed = HOST_FRAME_SCHEMAS['preferences.changed']
    const view = {
      preferences: {
        subagentDelegationOn: false,
        routingProfile: 'balanced',
        systemNotificationsOn: true,
        openCodePermissionsOn: false
      },
      secrets: [],
      secretBackend: 'unavailable',
      integrations: [],
      welcome: { due: false, legacyFound: [], offered: [] }
    }
    expect(changed.safeParse(view).success).toBe(true)
    expect(changed.safeParse({ ...view, seq: 3 }).success).toBe(false)
    expect(changed.safeParse({ preferences: view.preferences }).success).toBe(false)
  })
})

// The B-F26 and B-F27 payloads of 14 §3.5 and their strict() schemas (14 §1.4).

describe('ui.resetPreferences and reset.progress payloads (14 §3.5, B-F26, B-F27)', () => {
  const RESET_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

  it('[ADR-023] each reset frame schema infers exactly its 14 §3.5 payload, takes only the seven ResetStep values and refuses any other key', () => {
    expectTypeOf<HostFrames['ui.resetPreferences']>().toEqualTypeOf<{ epoch: number }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['ui.resetPreferences']>>().toEqualTypeOf<
      HostFrames['ui.resetPreferences']
    >()
    expectTypeOf<HostFrames['reset.progress']>().toEqualTypeOf<{
      resetId: ResetId
      epoch: number
      step: ResetStep
    }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['reset.progress']>>().toEqualTypeOf<
      HostFrames['reset.progress']
    >()
    expectTypeOf<ResetStep>().toEqualTypeOf<
      'begun' | 'db' | 'secrets' | 'external-config' | 'ui-prefs' | 'install-moment' | 'done'
    >()

    const resetPreferences = HOST_FRAME_SCHEMAS['ui.resetPreferences']
    expect(resetPreferences.safeParse({ epoch: 1 }).success).toBe(true)
    expect(resetPreferences.safeParse({ epoch: 0 }).success).toBe(false)
    expect(resetPreferences.safeParse({ epoch: 1, resetId: RESET_ID }).success).toBe(false)

    const progress = HOST_FRAME_SCHEMAS['reset.progress']
    for (const step of [
      'begun',
      'db',
      'secrets',
      'external-config',
      'ui-prefs',
      'install-moment',
      'done'
    ]) {
      expect(progress.safeParse({ resetId: RESET_ID, epoch: 1, step }).success, step).toBe(true)
    }
    expect(progress.safeParse({ resetId: RESET_ID, epoch: 1, step: 'vacuum' }).success).toBe(false)
    expect(progress.safeParse({ resetId: 'reset-1', epoch: 1, step: 'db' }).success).toBe(false)
    expect(progress.safeParse({ resetId: RESET_ID, epoch: 1 }).success).toBe(false)
    expect(
      progress.safeParse({ resetId: RESET_ID, epoch: 1, step: 'db', reason: 'x' }).success
    ).toBe(false)
  })
})

// The B-F06, B-F08, B-F09 and B-F10 payloads of 14 §3.5 and their strict() schemas (14 §1.4).

describe('board frame payloads (14 §3.5, B-F06, B-F08, B-F09, B-F10)', () => {
  const MINE = '01920000-0000-7000-8000-000000000001'
  const DWARF = '01920000-0000-7000-8000-000000000002'
  const totals = {
    coal: { tokens: 1 },
    bronze: { tokens: 0 },
    copper: { tokens: 0 },
    silver: { tokens: 0 },
    gold: { tokens: 0 },
    uranium: { tokens: 0 }
  }
  const mine = {
    id: MINE,
    path: '/work/alpha',
    name: 'alpha',
    state: 'unrecorded',
    tier: null,
    hasBeenMeasured: false,
    lastUsedAt: 1,
    totals
  }
  const dwarf = {
    id: DWARF,
    mineId: MINE,
    providerId: 'claude',
    baseName: 'Borin',
    customName: null,
    rank: 'foreman',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId: 'claude' },
    presence: 'present',
    processState: 'running',
    status: 'idle',
    needsYou: false,
    canReceiveMessages: false,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1
  }

  it('[ADR-003] each board frame schema infers exactly its 14 §3.5 payload, carries the full MineWire or DwarfWire and refuses any other key', () => {
    expectTypeOf<HostFrames['mine.changed']>().toEqualTypeOf<{ mine: MineWire }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['mine.changed']>>().toEqualTypeOf<
      HostFrames['mine.changed']
    >()
    expectTypeOf<HostFrames['dwarf.arrived']>().toEqualTypeOf<{
      dwarf: DwarfWire
      announce: boolean
    }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['dwarf.arrived']>>().toEqualTypeOf<
      HostFrames['dwarf.arrived']
    >()
    expectTypeOf<HostFrames['dwarf.changed']>().toEqualTypeOf<{ dwarf: DwarfWire }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['dwarf.changed']>>().toEqualTypeOf<
      HostFrames['dwarf.changed']
    >()
    expectTypeOf<HostFrames['dwarf.departed']>().toEqualTypeOf<{
      dwarfId: DwarfId
      mineId: MineId
      cause: DepartureCause
    }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['dwarf.departed']>>().toEqualTypeOf<
      HostFrames['dwarf.departed']
    >()
    expectTypeOf<DepartureCause>().toEqualTypeOf<
      | 'stopped'
      | 'mine-removed'
      | 'closed-elsewhere'
      | 'crashed'
      | 'recovery-dismissed'
      | 'recovery-failed'
    >()

    const changed = HOST_FRAME_SCHEMAS['mine.changed']
    expect(changed.safeParse({ mine }).success).toBe(true)
    expect(changed.safeParse({ mine: { ...mine, state: 'removed' } }).success).toBe(false)
    expect(changed.safeParse({ mine, seq: 3 }).success).toBe(false)

    const arrived = HOST_FRAME_SCHEMAS['dwarf.arrived']
    expect(arrived.safeParse({ dwarf, announce: true }).success).toBe(true)
    expect(arrived.safeParse({ dwarf }).success).toBe(false)
    // No status facts and no process id cross the channel (14 §3.6 DwarfWire).
    expect(arrived.safeParse({ dwarf: { ...dwarf, pid: 4242 }, announce: false }).success).toBe(
      false
    )
    expect(
      arrived.safeParse({ dwarf: { ...dwarf, facts: { openAsk: null } }, announce: false }).success
    ).toBe(false)

    const dwarfChanged = HOST_FRAME_SCHEMAS['dwarf.changed']
    expect(dwarfChanged.safeParse({ dwarf }).success).toBe(true)
    expect(dwarfChanged.safeParse({ dwarf, announce: false }).success).toBe(false)

    const departed = HOST_FRAME_SCHEMAS['dwarf.departed']
    for (const cause of [
      'stopped',
      'mine-removed',
      'closed-elsewhere',
      'crashed',
      'recovery-dismissed',
      'recovery-failed'
    ]) {
      expect(departed.safeParse({ dwarfId: DWARF, mineId: MINE, cause }).success, cause).toBe(true)
    }
    expect(departed.safeParse({ dwarfId: DWARF, mineId: MINE, cause: 'killed' }).success).toBe(
      false
    )
    expect(departed.safeParse({ dwarfId: DWARF, cause: 'stopped' }).success).toBe(false)
    expect(
      departed.safeParse({ dwarfId: DWARF, mineId: MINE, cause: 'stopped', toast: true }).success
    ).toBe(false)
  })
})

// The B-F22 and B-F23 payloads of 14 §3.5, their strict() schemas (14 §1.4) and SENSITIVE_FRAMES:
// the notifier's attention frames (ADR-003 item 12; ADR-018).

describe('attention.notify and attention.withdraw payloads (14 §3.5, B-F22, B-F23)', () => {
  const MINE = '01890a5d-ac96-774b-bcce-b302099a8111'
  const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111'
  const NOTIFICATION = {
    key: `${DWARF}:question:ask-1`,
    kind: 'question',
    title: 'Canary has a question',
    body: 'Mine one',
    mineId: MINE,
    dwarfId: DWARF,
    sensitive: true
  }

  it('[ADR-018] the attention frame schemas infer exactly OsNotification and {keys}, and refuse any other key', () => {
    expect(Object.keys(HOST_FRAME_SCHEMAS)).toEqual(
      expect.arrayContaining(['attention.notify', 'attention.withdraw'])
    )
    expectTypeOf<HostFrames['attention.notify']>().toEqualTypeOf<OsNotification>()
    expectTypeOf<OsNotification>().toEqualTypeOf<{
      key: string
      kind: AttentionKind
      title: string
      body: string
      mineId: MineId
      dwarfId: DwarfId
      sensitive: true
    }>()
    expectTypeOf<AttentionKind>().toEqualTypeOf<'permission' | 'question' | 'turn-finished'>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['attention.notify']>>().toEqualTypeOf<
      HostFrames['attention.notify']
    >()
    expectTypeOf<HostFrames['attention.withdraw']>().toEqualTypeOf<{ keys: string[] }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['attention.withdraw']>>().toEqualTypeOf<
      HostFrames['attention.withdraw']
    >()

    const notify = HOST_FRAME_SCHEMAS['attention.notify']
    for (const kind of ['permission', 'question', 'turn-finished']) {
      expect(notify.safeParse({ ...NOTIFICATION, kind }).success, kind).toBe(true)
    }
    expect(notify.safeParse({ ...NOTIFICATION, kind: 'host-crash' }).success).toBe(false)
    expect(notify.safeParse({ ...NOTIFICATION, sensitive: false }).success).toBe(false)
    expect(notify.safeParse({ ...NOTIFICATION, mineId: 'mine-1' }).success).toBe(false)
    expect(notify.safeParse({ ...NOTIFICATION, dwarfId: 'dwarf-1' }).success).toBe(false)
    expect(notify.safeParse({ ...NOTIFICATION, at: 1 }).success).toBe(false)
    expect(notify.safeParse({ ...NOTIFICATION, body: undefined }).success).toBe(false)

    const withdraw = HOST_FRAME_SCHEMAS['attention.withdraw']
    expect(withdraw.safeParse({ keys: [NOTIFICATION.key, 'k2'] }).success).toBe(true)
    expect(withdraw.safeParse({ keys: [] }).success).toBe(true)
    expect(withdraw.safeParse({ keys: [1] }).success).toBe(false)
    expect(withdraw.safeParse({ keys: ['k'], reason: 'ended' }).success).toBe(false)
  })

  it('[NFR-SEC-12] attention.notify is a sensitive frame: its payload is never logged (14 §3.5)', () => {
    expect(SENSITIVE_FRAMES).toContain('attention.notify')
    expect(SENSITIVE_FRAMES).not.toContain('attention.withdraw')
  })
})

describe('ledger.changed payload (14 §3.5, B-F20)', () => {
  const MINE = '01920000-0000-7000-8000-00000000000a'
  const TOTALS = {
    coal: { tokens: 2_600 },
    bronze: { tokens: 0 },
    copper: { tokens: 30_000 },
    silver: { tokens: 0 },
    gold: { tokens: 0 },
    uranium: { tokens: 0 }
  }

  it('[US-MINE-010.AC02, ADR-006] the ledger.changed schema infers exactly its 14 §3.5 payload with six separate material totals and refuses any other key', () => {
    expectTypeOf<HostFrames['ledger.changed']>().toEqualTypeOf<{
      mineId: MineId
      totals: Record<Material, MaterialAmount>
    }>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['ledger.changed']>>().toEqualTypeOf<
      HostFrames['ledger.changed']
    >()

    const changed = HOST_FRAME_SCHEMAS['ledger.changed']
    expect(changed.safeParse({ mineId: MINE, totals: TOTALS }).success).toBe(true)
    // Six materials, each its own count: never a summed total, never a missing material.
    expect(
      changed.safeParse({ mineId: MINE, totals: { ...TOTALS, all: { tokens: 32_600 } } }).success
    ).toBe(false)
    const five: Partial<typeof TOTALS> = { ...TOTALS }
    delete five.uranium
    expect(changed.safeParse({ mineId: MINE, totals: five }).success).toBe(false)
    expect(changed.safeParse({ mineId: MINE, totals: TOTALS, total: 32_600 }).success).toBe(false)
    expect(
      changed.safeParse({ mineId: MINE, totals: { ...TOTALS, coal: { tokens: -1 } } }).success
    ).toBe(false)
    expect(
      changed.safeParse({ mineId: MINE, totals: { ...TOTALS, coal: { tokens: 1, units: 0 } } })
        .success
    ).toBe(false)
    expect(changed.safeParse({ totals: TOTALS }).success).toBe(false)
    expect(SENSITIVE_FRAMES).not.toContain('ledger.changed')
  })
})
