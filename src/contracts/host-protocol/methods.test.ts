import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { DwarfId, Instant } from '../wire'
import {
  HOST_METHOD_SCHEMAS,
  type HostMethods,
  type HostShutdownParams,
  type HostShutdownResult
} from './methods'

// The B-M02 and B-M05 entries of 14 §3.4 and their strict() schemas (14 §1.4).

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
