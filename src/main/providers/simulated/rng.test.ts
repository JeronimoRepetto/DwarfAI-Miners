import { describe, expect, it } from 'vitest'
import { hashInt, hashPick, hashString } from './rng'

/*
 * Test vectors computed with an independent FNV-1a 32 reference, NOT with the
 * implementation under test: the whole point of this module is that it is the
 * SAME hash the renderer's placement.ts uses, so the vectors have to come from
 * the algorithm rather than from our own code agreeing with itself.
 */
const FNV1A_VECTORS: ReadonlyArray<readonly [string, number]> = [
  ['', 2166136261],
  ['a', 3826002220],
  ['dwarfai', 559354021],
  ['mine:0', 887033148],
  ['sim:0:1', 1773430071]
]

describe('hashString', () => {
  it.each(FNV1A_VECTORS)('hashes %j to the FNV-1a 32 value', (value, expected) => {
    expect(hashString(value)).toBe(expected)
  })

  it('starts from the FNV offset basis, so the empty string is not zero', () => {
    expect(hashString('')).toBe(0x811c9dc5)
  })

  it('returns the same value every call', () => {
    expect(hashString('anvil-forge')).toBe(hashString('anvil-forge'))
  })

  it('stays inside the unsigned 32-bit range', () => {
    for (const value of ['', 'a', 'sim:19:11:status', 'ÿþ', 'x'.repeat(500)]) {
      const hash = hashString(value)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('spreads path-like ids that differ only in their last character', () => {
    const hashes = new Set(
      Array.from({ length: 32 }, (_, index) => hashString(`/simulated/gold/mine-${index}`))
    )
    expect(hashes.size).toBe(32)
  })
})

describe('hashInt', () => {
  it('maps into [0, bound)', () => {
    for (let index = 0; index < 200; index++) {
      const value = hashInt(`seed:${index}`, 7)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(7)
    }
  })

  it('is deterministic for the same key', () => {
    expect(hashInt('sim:3:4', 13)).toBe(hashInt('sim:3:4', 13))
  })

  it('returns 0 for a non-positive bound rather than NaN', () => {
    expect(hashInt('anything', 0)).toBe(0)
    expect(hashInt('anything', -4)).toBe(0)
  })
})

describe('hashPick', () => {
  it('picks a member of the list, deterministically', () => {
    const options = ['pick', 'shovel', 'lantern', 'cart'] as const
    const picked = hashPick('sim:2:5', options)
    expect(options).toContain(picked)
    expect(hashPick('sim:2:5', options)).toBe(picked)
  })

  it('reaches every option across enough keys', () => {
    const options = ['a', 'b', 'c'] as const
    const seen = new Set(
      Array.from({ length: 100 }, (_, index) => hashPick(`key:${index}`, options))
    )
    expect(seen).toEqual(new Set(options))
  })
})
