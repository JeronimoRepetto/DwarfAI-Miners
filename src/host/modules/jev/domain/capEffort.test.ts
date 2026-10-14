import { describe, expect, it } from 'vitest'
import { capEffort, type CappedEffort } from './capEffort'
import { PROVIDER_EFFORT_LEVELS } from './capabilities/effortLadders'

// A seeded property run (17 §1.1 `FC_SEED`; no generator library in the repo, the crew status
// property test's idiom): every case is reproducible from the seed.
const FC_SEED = 190
const RANDOM_CASES = 2_000

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

/** Every subset of `ladder`, each in a shuffled order (the allowed list's order must not matter). */
function subsetsOf(ladder: readonly string[], random: () => number): string[][] {
  const subsets: string[][] = []
  for (let mask = 0; mask < 1 << ladder.length; mask += 1) {
    const subset = ladder.filter((_, index) => (mask & (1 << index)) !== 0)
    for (let i = subset.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[subset[i], subset[j]] = [subset[j]!, subset[i]!]
    }
    subsets.push(subset)
  }
  return subsets
}

/** The property of ADR-028 item 1, checked against the ladder (never a second implementation). */
function expectCapped(
  result: CappedEffort,
  ladder: readonly string[],
  allowed: readonly string[],
  mapped: string
): void {
  const ceiling = ladder.indexOf(mapped)
  const atOrBelow = allowed.filter((level) => ladder.indexOf(level) <= ceiling)
  if (atOrBelow.length === 0) {
    expect(result, `allowed ${JSON.stringify(allowed)}, mapped ${mapped}`).toEqual({ kind: 'none' })
    return
  }
  expect(result.kind, `allowed ${JSON.stringify(allowed)}, mapped ${mapped}`).toBe('level')
  if (result.kind !== 'level') return
  const index = ladder.indexOf(result.effort)
  expect(allowed, `the result ${result.effort} is one of the allowed levels`).toContain(
    result.effort
  )
  expect(index, `never above the mapped level ${mapped}`).toBeLessThanOrEqual(ceiling)
  for (const level of atOrBelow) {
    expect(
      ladder.indexOf(level),
      `${level} is allowed and at or below ${mapped}, so ${result.effort} is not the highest`
    ).toBeLessThanOrEqual(index)
  }
}

describe('capEffort (ADR-028 item 1)', () => {
  it('[US-LAUNCH-003.AC12, INV-86, ADR-028] capEffort never returns a level whose ladder index is above the mapped one and returns the highest such level', () => {
    const random = prng(FC_SEED)
    // Every catalog ladder, every non-empty allowed subset, every mapped level on the ladder.
    for (const ladder of Object.values(PROVIDER_EFFORT_LEVELS)) {
      for (const allowed of subsetsOf(ladder, random)) {
        if (allowed.length === 0) continue
        for (const mapped of ladder) {
          expectCapped(capEffort(ladder, allowed, mapped), ladder, allowed, mapped)
        }
      }
    }
    // Seeded random ladders beyond the catalog: any length, any subset, any order.
    for (let n = 0; n < RANDOM_CASES; n += 1) {
      const length = 1 + Math.floor(random() * 10)
      const ladder = Array.from({ length }, (_, index) => `level-${index}`)
      const allowed = ladder.filter(() => random() < 0.5).sort(() => random() - 0.5)
      if (allowed.length === 0) continue
      const mapped = ladder[Math.floor(random() * length)]!
      expectCapped(capEffort(ladder, allowed, mapped), ladder, allowed, mapped)
    }
  })

  it('[ADR-028] capEffort returns omit for a model with no effort levels and the mapped level when every level is allowed', () => {
    for (const ladder of Object.values(PROVIDER_EFFORT_LEVELS)) {
      for (const mapped of ladder) {
        expect(capEffort(ladder, [], mapped)).toEqual({ kind: 'omit' })
        expect(capEffort(ladder, 'all', mapped)).toEqual({ kind: 'level', effort: mapped })
      }
    }
  })

  it('[ADR-028] capEffort returns none, never the first allowed level, when the mapped level is not on the ladder', () => {
    const ladder = ['low', 'medium', 'high']
    expect(capEffort(ladder, ['low', 'high'], 'ultra')).toEqual({ kind: 'none' })
    expect(capEffort(ladder, ['medium'], '')).toEqual({ kind: 'none' })
  })
})
