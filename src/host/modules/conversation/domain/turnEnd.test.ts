// layer: L1
// L1 (17 §1.1): the ADR-021 turn-end rules — which end a consumer may announce (item 3) and the
// session capability that caps an end's reliability (item 2) — as tables and as a seeded property.
// No clock, no I/O: every value is passed in.
//
// TC-100-02 (no inferred or app-cancelled end is announceable).
import { describe, expect, it } from 'vitest'
import type { TurnEnded, TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import { announceable, downgrade } from './turnEnd'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const KINDS: readonly TurnEndKind[] = ['concluded', 'capped', 'errored', 'interrupted']

function end(overrides: Partial<TurnEnded> = {}): TurnEnded {
  return {
    dwarfId: DWARF,
    turnKey: 'turn-1',
    kind: 'concluded',
    at: 1_790_000_000_000,
    reliability: 'reliable',
    cancelledFromApp: false,
    ...overrides
  }
}

// A seeded property run (no generator library in the repo, as in attention's level-3 properties):
// every case reproduces from the seed printed with a failure.
const CASES = 500

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)] as T
}

describe('turn end rules', () => {
  it('[ADR-021] only a reliable end not cancelled from the app is announceable, for every kind', () => {
    for (const kind of KINDS) {
      expect(announceable(end({ kind })), kind).toBe(true)
      expect(announceable(end({ kind, cancelledFromApp: true })), kind).toBe(false)
      expect(announceable(end({ kind, reliability: 'inferred' })), kind).toBe(false)
      expect(
        announceable(end({ kind, reliability: 'inferred', cancelledFromApp: true })),
        kind
      ).toBe(false)
    }
  })

  it('[ADR-021, INV-67, FM-081] property: no inferred end is ever announceable, whatever its kind, detail or cancelledFromApp', () => {
    const details = [undefined, '', 'end_turn', 'refusal', 'synthetic_unknown_reason']
    for (let seed = 1; seed <= CASES; seed += 1) {
      const next = prng(seed)
      const detail = pick(next, details)
      const inferred = end({
        turnKey: `turn-${Math.floor(next() * 1_000_000)}`,
        kind: pick(next, KINDS),
        at: Math.floor(next() * 2_000_000_000_000),
        reliability: 'inferred',
        cancelledFromApp: next() < 0.5,
        ...(detail === undefined ? {} : { detail })
      })
      expect(announceable(inferred), `seed ${seed}`).toBe(false)
      // An inferred end stays inferred whatever the session's capability (ADR-021 item 1).
      expect(
        downgrade(inferred, pick(next, ['reliable', 'none'] as const)),
        `seed ${seed}`
      ).toEqual(inferred)
    }
  })

  it('[ADR-021] a reliable end on a session whose turnEnd capability is none is downgraded to inferred', () => {
    for (const kind of KINDS) {
      const reliable = end({ kind, detail: 'end_turn' })

      const capped = downgrade(reliable, 'none')
      expect(capped).toEqual({ ...reliable, reliability: 'inferred' })
      expect(announceable(capped)).toBe(false)
      // The end handed in is not changed.
      expect(reliable.reliability).toBe('reliable')

      // A session that may report reliable ends keeps them (ADR-021 item 2).
      expect(downgrade(reliable, 'reliable')).toEqual(reliable)
    }
  })
})
