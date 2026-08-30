import { describe, expect, it } from 'vitest'
import { MATERIALS, MATERIAL_TOKENS_PER_UNIT, type Material } from '../../shared/contracts'
import {
  emptyMaterialTotals,
  addMaterialTokens,
  materialForTier,
  materialUnits,
  mergeMaterialTotals,
  sumMaterialTotals,
  totalMaterialTokens
} from './materials'

describe('MATERIAL_TOKENS_PER_UNIT', () => {
  it('names a rate for every material', () => {
    for (const material of MATERIALS) {
      expect(MATERIAL_TOKENS_PER_UNIT[material]).toBeGreaterThan(0)
    }
  })

  it('anchors bronze on the renderer TOKENS_PER_ORE so a starting mine reads unchanged', () => {
    expect(MATERIAL_TOKENS_PER_UNIT.bronze).toBe(10_000)
  })

  it('makes each richer tier denser than the one below it', () => {
    const ladder: Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']
    for (let i = 1; i < ladder.length; i++) {
      expect(MATERIAL_TOKENS_PER_UNIT[ladder[i]!]).toBeGreaterThan(
        MATERIAL_TOKENS_PER_UNIT[ladder[i - 1]!]
      )
    }
  })

  it('prices coal below bronze so the historical pile reads as abundant', () => {
    expect(MATERIAL_TOKENS_PER_UNIT.coal).toBeLessThan(MATERIAL_TOKENS_PER_UNIT.bronze)
  })
})

describe('materialForTier', () => {
  it('yields the raw material of the tier in force', () => {
    expect(materialForTier('bronze')).toBe('bronze')
    expect(materialForTier('copper')).toBe('copper')
    expect(materialForTier('silver')).toBe('silver')
    expect(materialForTier('gold')).toBe('gold')
    expect(materialForTier('uranium')).toBe('uranium')
  })

  it('never yields coal, which no mine tier produces', () => {
    const tiers = ['bronze', 'copper', 'silver', 'gold', 'uranium'] as const
    for (const tier of tiers) expect(materialForTier(tier)).not.toBe('coal')
  })
})

describe('emptyMaterialTotals', () => {
  it('starts every material at zero', () => {
    const totals = emptyMaterialTotals()
    for (const material of MATERIALS) expect(totals[material]).toBe(0)
  })

  it('returns a fresh object each call, so one mine cannot mutate another', () => {
    const a = emptyMaterialTotals()
    const b = emptyMaterialTotals()
    a.gold = 5
    expect(b.gold).toBe(0)
  })
})

describe('addMaterialTokens', () => {
  it('credits tokens to one material without touching the others', () => {
    const next = addMaterialTokens(emptyMaterialTotals(), 'silver', 300)
    expect(next.silver).toBe(300)
    expect(next.gold).toBe(0)
  })

  it('accumulates across calls', () => {
    const once = addMaterialTokens(emptyMaterialTotals(), 'copper', 100)
    expect(addMaterialTokens(once, 'copper', 50).copper).toBe(150)
  })

  it('does not mutate its input', () => {
    const base = emptyMaterialTotals()
    addMaterialTokens(base, 'gold', 900)
    expect(base.gold).toBe(0)
  })

  it('ignores a negative or non-finite credit rather than eroding the vault', () => {
    const base = addMaterialTokens(emptyMaterialTotals(), 'gold', 100)
    expect(addMaterialTokens(base, 'gold', -50).gold).toBe(100)
    expect(addMaterialTokens(base, 'gold', Number.NaN).gold).toBe(100)
  })
})

describe('mergeMaterialTotals', () => {
  it('adds two breakdowns material by material', () => {
    const a = addMaterialTokens(emptyMaterialTotals(), 'coal', 10)
    const b = addMaterialTokens(addMaterialTokens(emptyMaterialTotals(), 'coal', 5), 'gold', 7)
    const merged = mergeMaterialTotals(a, b)
    expect(merged.coal).toBe(15)
    expect(merged.gold).toBe(7)
  })
})

describe('sumMaterialTotals', () => {
  it('folds a list into one breakdown', () => {
    const summed = sumMaterialTotals([
      addMaterialTokens(emptyMaterialTotals(), 'copper', 1),
      addMaterialTokens(emptyMaterialTotals(), 'copper', 2),
      addMaterialTokens(emptyMaterialTotals(), 'uranium', 4)
    ])
    expect(summed.copper).toBe(3)
    expect(summed.uranium).toBe(4)
  })

  it('returns an empty breakdown for no entries', () => {
    expect(sumMaterialTotals([])).toEqual(emptyMaterialTotals())
  })
})

describe('materialUnits', () => {
  it('floors tokens into whole units at that material rate', () => {
    expect(materialUnits(29_999, 'bronze')).toBe(2)
    expect(materialUnits(30_000, 'bronze')).toBe(3)
  })

  it('makes one gold unit stand for more tokens than one bronze unit', () => {
    const tokens = 1_000_000
    expect(materialUnits(tokens, 'gold')).toBeLessThan(materialUnits(tokens, 'bronze'))
  })

  it('floors a negative or non-finite count to zero', () => {
    expect(materialUnits(-1, 'gold')).toBe(0)
    expect(materialUnits(Number.NaN, 'gold')).toBe(0)
  })
})

describe('totalMaterialTokens', () => {
  it('sums every material back to the raw token count underneath', () => {
    const totals = addMaterialTokens(
      addMaterialTokens(emptyMaterialTotals(), 'coal', 400),
      'silver',
      600
    )
    expect(totalMaterialTokens(totals)).toBe(1_000)
  })
})
