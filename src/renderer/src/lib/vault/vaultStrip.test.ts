import { describe, expect, it } from 'vitest'
import { VAULT_EMPTY, vaultStripClasses, vaultStripOre } from './vaultStrip'

const ORE = [
  { material: 'coal' as const, units: 548 },
  { material: 'bronze' as const, units: 90 },
  { material: 'copper' as const, units: 31 },
  { material: 'silver' as const, units: 4 }
]

describe('vaultStripOre', () => {
  it('keeps every material, poorest first, when nothing caps it', () => {
    expect(vaultStripOre(ORE).map((o) => o.material)).toEqual([
      'coal',
      'bronze',
      'copper',
      'silver'
    ])
  })

  /*
   * The mine footer's "richest three": richest by grain — the material order — never by a sum of
   * units across materials, which would convert one ore into another (components.md, Vault strip).
   */
  it('keeps only the richest materials by grain when capped, still poorest first', () => {
    expect(vaultStripOre(ORE, 3).map((o) => o.material)).toEqual(['bronze', 'copper', 'silver'])
  })

  it('leaves out a material at zero', () => {
    expect(vaultStripOre([...ORE, { material: 'gold', units: 0 }]).map((o) => o.material)).toEqual([
      'coal',
      'bronze',
      'copper',
      'silver'
    ])
  })

  it('reads "No ore yet" when every counter is zero', () => {
    expect(vaultStripOre([])).toEqual([])
    expect(VAULT_EMPTY).toBe('No ore yet')
  })
})

describe('vaultStripClasses', () => {
  it('is a bare strip, or a wood plate for the map totals', () => {
    expect(vaultStripClasses(false)).toEqual(['dm-vault'])
    expect(vaultStripClasses(true)).toEqual(['dm-vault', 'dm-vault--plate', 'm-mat', 'm-wood'])
  })
})
