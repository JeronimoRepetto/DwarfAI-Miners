import { describe, expect, it } from 'vitest'
import type { MaterialTotals } from '../../types'
import { MATERIALS, MATERIAL_TOKENS_PER_UNIT } from '../../types'
import {
  currentMaterialRow,
  emptyMaterialTotals,
  formatUnits,
  materialUnits,
  vaultRows
} from './vault'

function totals(overrides: Partial<MaterialTotals> = {}): MaterialTotals {
  return { ...emptyMaterialTotals(), ...overrides }
}

describe('emptyMaterialTotals', () => {
  it('carries every material at zero, so a breakdown never has to check for absent keys', () => {
    const empty = emptyMaterialTotals()
    for (const material of MATERIALS) expect(empty[material]).toBe(0)
  })

  it('hands out a fresh object each time, so one vault cannot mutate another', () => {
    const first = emptyMaterialTotals()
    first.coal = 99
    expect(emptyMaterialTotals().coal).toBe(0)
  })
})

describe('materialUnits', () => {
  it('divides a material by ITS OWN grain size, never by another material rate', () => {
    expect(materialUnits(MATERIAL_TOKENS_PER_UNIT.coal * 4, 'coal')).toBe(4)
    expect(materialUnits(MATERIAL_TOKENS_PER_UNIT.gold * 4, 'gold')).toBe(4)
    // Same token count, different ore: the coarse ore simply shows fewer nuggets.
    expect(materialUnits(100_000, 'coal')).toBe(40)
    expect(materialUnits(100_000, 'gold')).toBe(1)
  })

  it('floors a partial unit, so a half-dug nugget never appears', () => {
    expect(materialUnits(MATERIAL_TOKENS_PER_UNIT.silver - 1, 'silver')).toBe(0)
    expect(materialUnits(MATERIAL_TOKENS_PER_UNIT.silver * 2 + 1, 'silver')).toBe(2)
  })

  it('treats negative and non-finite totals as nothing mined', () => {
    expect(materialUnits(-5_000, 'bronze')).toBe(0)
    expect(materialUnits(Number.NaN, 'bronze')).toBe(0)
  })
})

/*
 * The one rule this whole surface exists to protect (see #22): materials never
 * convert into one another, so the panel shows a row PER material and there is
 * deliberately no function here that adds two materials' units together.
 */
describe('vaultRows', () => {
  it('lists one row per material that has produced at least a whole unit', () => {
    const rows = vaultRows(totals({ coal: 25_000, gold: 300_000 }))
    expect(rows).toEqual([
      { material: 'coal', tokens: 25_000, units: 10 },
      { material: 'gold', tokens: 300_000, units: 3 }
    ])
  })

  it('orders rows poorest first, exactly as the shared contract lists them', () => {
    const rows = vaultRows(
      totals({ uranium: 500_000, coal: 5_000, silver: 100_000, bronze: 20_000 })
    )
    expect(rows.map((row) => row.material)).toEqual(['coal', 'bronze', 'silver', 'uranium'])
  })

  it('leaves out a material that has not yet reached one whole unit', () => {
    // 9_999 bronze tokens is not a bronze nugget yet, and a row reading "0" would
    // claim a pile that is not there.
    expect(vaultRows(totals({ bronze: 9_999 }))).toEqual([])
  })

  it('reports nothing for a vault that has mined nothing at all', () => {
    expect(vaultRows(emptyMaterialTotals())).toEqual([])
  })

  /*
   * `Mine.materials` and `MinesSnapshot.materials` are optional on the wire, so
   * a snapshot published before the ledger finished loading carries none. That
   * is an empty vault, not a crash.
   */
  it('treats an absent breakdown as an empty vault', () => {
    expect(vaultRows(undefined)).toEqual([])
  })

  it('keeps each material on its own counter — coal never becomes gold', () => {
    const rows = vaultRows(totals({ coal: 2_500, gold: 100_000 }))
    expect(rows.find((row) => row.material === 'coal')?.units).toBe(1)
    expect(rows.find((row) => row.material === 'gold')?.units).toBe(1)
    expect(rows).toHaveLength(2)
  })
})

describe('formatUnits', () => {
  it('shows a small pile as a plain number', () => {
    expect(formatUnits(0)).toBe('0')
    expect(formatUnits(37)).toBe('37')
  })

  it('compacts a pile too large to read digit by digit', () => {
    expect(formatUnits(1_200)).toBe('1.2K')
    expect(formatUnits(3_000_000)).toBe('3M')
  })
})

/*
 * The map badge (see #48) has room for exactly one figure, so it needs the row
 * for whichever material the mine's CURRENT tier yields — never a sum across
 * the several materials a tier-hopping mine can hold. materialForTier() in the
 * main process is the identity function today (a copper mine yields copper),
 * and MineTier is already a subset of Material, so the tier IS the lookup key.
 */
describe('currentMaterialRow', () => {
  it("returns the row for the mine's current tier once it has reached a whole unit", () => {
    expect(currentMaterialRow(totals({ copper: 50_000 }), 'copper')).toEqual({
      material: 'copper',
      tokens: 50_000,
      units: 2
    })
  })

  it('returns undefined once the current tier has not reached a whole unit yet, even with older materials in the ledger', () => {
    // A mine just promoted from bronze to silver: bronze has whole units, but
    // the badge must not fall back to them once the tier has moved on.
    expect(currentMaterialRow(totals({ bronze: 20_000, silver: 10_000 }), 'silver')).toBeUndefined()
  })

  it('treats an absent breakdown as nothing mined', () => {
    expect(currentMaterialRow(undefined, 'gold')).toBeUndefined()
  })

  it("returns only the current tier's own row, never a total across materials", () => {
    // bronze (2 units) + copper (2 units) would wrongly read "4" if this ever
    // summed; it must return copper's own row alone.
    const row = currentMaterialRow(totals({ bronze: 20_000, copper: 50_000 }), 'copper')
    expect(row).toEqual({ material: 'copper', tokens: 50_000, units: 2 })
  })
})
