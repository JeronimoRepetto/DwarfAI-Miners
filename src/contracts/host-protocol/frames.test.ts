import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
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
