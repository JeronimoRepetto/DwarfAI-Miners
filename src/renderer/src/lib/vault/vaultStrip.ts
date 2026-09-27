/*
 * The vault strip (#635), `molecules/vault-strip` in the design: a row of ore capsules, a mine's
 * footer or the map's totals plate. Each capsule is one material's own counter in its own units;
 * nothing here converts one material into another or adds units across them (vault.ts).
 */
import { MATERIALS, type Material } from '../../types'

/** What the strip reads with every counter at zero. */
export const VAULT_EMPTY = 'No ore yet'

export interface VaultStripOre {
  material: Material
  units: number
}

/**
 * The capsules to draw, poorest first, a material at zero left out. `max` keeps only the richest
 * materials when the strip is narrow — richest by grain, the order MATERIALS declares, never by a
 * sum of units, which would weigh one ore against another.
 */
export function vaultStripOre(ore: readonly VaultStripOre[], max?: number): VaultStripOre[] {
  const present = MATERIALS.flatMap((material) =>
    ore.filter((o) => o.material === material && o.units > 0)
  )
  return max === undefined ? present : present.slice(Math.max(0, present.length - max))
}

export function vaultStripClasses(plate: boolean): string[] {
  return plate ? ['dm-vault', 'dm-vault--plate', 'm-mat', 'm-wood'] : ['dm-vault']
}
