import { describe, expect, it } from 'vitest'
import { formatTokens, oreCount, TOKENS_PER_ORE } from './economy'

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1234, '1.2K'],
    [2_500_000, '2.5M'],
    [1_000_000_000, '1B']
  ])('formats %d as %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it('clamps negative input to 0', () => {
    expect(formatTokens(-50)).toBe('0')
  })
})

describe('oreCount', () => {
  it('divides tokens by TOKENS_PER_ORE, rounded down', () => {
    expect(oreCount(0)).toBe(0)
    expect(oreCount(TOKENS_PER_ORE - 1)).toBe(0)
    expect(oreCount(TOKENS_PER_ORE)).toBe(1)
    expect(oreCount(TOKENS_PER_ORE * 3 + 500)).toBe(3)
  })

  it('never goes negative', () => {
    expect(oreCount(-1000)).toBe(0)
  })
})

/*
 * The two orePileStep tests that stood here went with the function itself when
 * the cave's layered CSS heap was replaced by painted nuggets (see #22). Their
 * subject — how a pile grows, and that its growth is bounded — did not go with
 * them: it is covered against the real layout in lib/nuggetPile.test.ts, where
 * `pileNuggetCount` pins the render cap and `pileScale` pins the swell past it.
 */
