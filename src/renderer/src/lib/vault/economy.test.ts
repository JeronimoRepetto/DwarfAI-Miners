import { describe, expect, it } from 'vitest'
import { formatTokens } from './economy'

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

/*
 * The two orePileStep tests that stood here went with the function itself when
 * the cave's layered CSS heap was replaced by painted nuggets (see #22). Their
 * subject — how a pile grows, and that its growth is bounded — did not go with
 * them: it is covered against the real layout in lib/nuggetPile.test.ts, where
 * `pileNuggetCount` pins the render cap and `pileScale` pins the swell past it.
 *
 * The oreCount()/TOKENS_PER_ORE tests that stood here went with the functions
 * themselves once the map badge — their last caller — moved onto the
 * per-material ledger (#48). Their subject, a whole-unit count rounded down
 * from a token total, lives on as materialUnits() and is covered against
 * every material's own grain size in lib/vault.test.ts.
 */
