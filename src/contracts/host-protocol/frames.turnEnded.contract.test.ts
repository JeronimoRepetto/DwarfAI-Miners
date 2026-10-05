// layer: L6
// L6 (17 §1.6): the B-F14 `turn.ended` frame of seam B (14 §2.4, §3.5, frozen; ADR-021; ADR-018
// D8 level-2 cue) and its strict() schema (14 §1.4). The payload is the 14 §3.5 subset of ADR-021
// `TurnEnded`: no `at`, no `detail`.
//
// TC-100-04.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { DwarfId } from '../wire'
import { frameCapability } from './capabilities'
import { HOST_FRAME_SCHEMAS, SENSITIVE_FRAMES, type HostFrames } from './frames'
import type { TurnEndKind } from './params/conversation'

const DWARF = '01920000-0000-7000-9000-0000000000a1'

/** A 14 §3.5 `turn.ended` payload. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dwarfId: DWARF,
    turnKey: 'codex:codex:session-1:turn-1',
    kind: 'concluded',
    reliability: 'reliable',
    cancelledFromApp: false,
    ...overrides
  }
}

describe('turn.ended payload (14 §3.5, B-F14)', () => {
  it('[ADR-021] the turn.ended frame schema accepts the 14 §3.5 payload and rejects an extra key or an unknown kind', () => {
    expectTypeOf<HostFrames['turn.ended']>().toEqualTypeOf<{
      dwarfId: DwarfId
      turnKey: string
      kind: TurnEndKind
      reliability: 'reliable' | 'inferred'
      cancelledFromApp: boolean
    }>()
    expectTypeOf<TurnEndKind>().toEqualTypeOf<'concluded' | 'capped' | 'errored' | 'interrupted'>()
    expectTypeOf<z.infer<(typeof HOST_FRAME_SCHEMAS)['turn.ended']>>().toEqualTypeOf<
      HostFrames['turn.ended']
    >()

    const schema = HOST_FRAME_SCHEMAS['turn.ended']
    for (const kind of ['concluded', 'capped', 'errored', 'interrupted']) {
      for (const reliability of ['reliable', 'inferred']) {
        for (const cancelledFromApp of [true, false]) {
          expect(
            schema.safeParse(payload({ kind, reliability, cancelledFromApp })).success,
            `${kind} ${reliability} ${String(cancelledFromApp)}`
          ).toBe(true)
        }
      }
    }
    // An extra key, also one of ADR-021 `TurnEnded` that 14 §3.5 leaves out.
    expect(schema.safeParse(payload({ extra: 1 })).success).toBe(false)
    expect(schema.safeParse(payload({ at: 1_790_000_000_000 })).success).toBe(false)
    expect(schema.safeParse(payload({ detail: 'refusal' })).success).toBe(false)
    // An unknown kind or reliability, a missing or blank field, a dwarf id that is not a UUIDv7.
    expect(schema.safeParse(payload({ kind: 'finished' })).success).toBe(false)
    expect(schema.safeParse(payload({ reliability: 'probable' })).success).toBe(false)
    expect(schema.safeParse(payload({ cancelledFromApp: 'no' })).success).toBe(false)
    expect(schema.safeParse(payload({ turnKey: '' })).success).toBe(false)
    expect(schema.safeParse(payload({ dwarfId: 'dwarf-1' })).success).toBe(false)
    const missing = payload()
    delete missing['cancelledFromApp']
    expect(schema.safeParse(missing).success).toBe(false)

    // Its capability name (14 §1.3), and it is not a sensitive frame (14 §3.5 SENSITIVE_FRAMES).
    expect(frameCapability('turn.ended')).toBe('frame:turn.ended')
    expect((SENSITIVE_FRAMES as readonly string[]).includes('turn.ended')).toBe(false)
  })
})
