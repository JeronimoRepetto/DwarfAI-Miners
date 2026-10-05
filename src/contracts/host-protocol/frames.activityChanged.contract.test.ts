// layer: L6
// L6 (17 §1.6): the B-F13 `activity.changed` frame of seam B (14 §2.4, §3.5, frozen) and its
// strict() schema (14 §1.4). Its payload is 14 §3.6 `ActivityWire`: the run's id, whether it is
// open, its step count and one summary line per step — never a tool's output (ADR-007 item 4).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { ActivityWire } from '../wire'
import { frameCapability } from './capabilities'
import { HOST_FRAME_SCHEMAS, SENSITIVE_FRAMES, type HostFrames } from './frames'

const DWARF = '01920000-0000-7000-9000-0000000000a1'

/** A 14 §3.6 `ActivityWire`. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dwarfId: DWARF,
    disclosureId: '01920000-0000-7000-9000-0000000000b1',
    open: true,
    stepCount: 2,
    summaries: ['Ran pnpm test', 'Edited src/parse.ts'],
    ...overrides
  }
}

describe('activity.changed payload (14 §3.5, B-F13)', () => {
  it('[ADR-007] the activity.changed schema is ActivityWire and carries summaries, never tool output fields', () => {
    expectTypeOf<HostFrames['activity.changed']>().toEqualTypeOf<ActivityWire>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['activity.changed']>>().toEqualTypeOf<
      HostFrames['activity.changed']
    >()

    const schema = HOST_FRAME_SCHEMAS['activity.changed']
    expect(schema.safeParse(payload()).success).toBe(true)
    expect(
      schema.safeParse(payload({ open: false, stepCount: 1, summaries: ['Ran ls'] })).success
    ).toBe(true)
    // A tool's output, its input or any other key never rides the frame.
    for (const key of ['output', 'toolOutput', 'stdout', 'stderr', 'input', 'result', 'extra']) {
      expect(schema.safeParse(payload({ [key]: 'secret text' })).success, key).toBe(false)
    }
    // A step is one summary line, not an object carrying more.
    expect(
      schema.safeParse(payload({ summaries: [{ summary: 'Ran ls', output: 'a\nb' }] })).success
    ).toBe(false)
    // A missing field, a negative or fractional count, a dwarf id that is not a UUIDv7.
    for (const missing of ['dwarfId', 'disclosureId', 'open', 'stepCount', 'summaries']) {
      const data = payload()
      delete data[missing]
      expect(schema.safeParse(data).success, missing).toBe(false)
    }
    expect(schema.safeParse(payload({ stepCount: -1 })).success).toBe(false)
    expect(schema.safeParse(payload({ stepCount: 1.5 })).success).toBe(false)
    expect(schema.safeParse(payload({ dwarfId: 'dwarf-1' })).success).toBe(false)

    // Its capability name (14 §1.3), and its summaries are never logged (14 §3.5 SENSITIVE_FRAMES).
    expect(frameCapability('activity.changed')).toBe('frame:activity.changed')
    expect((SENSITIVE_FRAMES as readonly string[]).includes('activity.changed')).toBe(true)
  })
})
