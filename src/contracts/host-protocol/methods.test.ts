import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { Instant } from '../wire'
import { HOST_METHOD_SCHEMAS, type HostMethods } from './methods'

// The B-M02 entry of 14 §3.4 and its strict() schemas (14 §1.4).

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
