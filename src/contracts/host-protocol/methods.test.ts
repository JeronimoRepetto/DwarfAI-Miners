import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { DwarfId, HostEpoch, Instant } from '../wire'
import {
  HOST_METHOD_SCHEMAS,
  type HostMethods,
  type HostShutdownParams,
  type HostShutdownResult,
  type SubscribeParams,
  type SubscribeResult
} from './methods'

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
