import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { PreferencesView } from '../wire'
import type { HelloOk } from './adr-003'
import { HOST_FRAME_SCHEMAS, type HostFrames } from './frames'

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
