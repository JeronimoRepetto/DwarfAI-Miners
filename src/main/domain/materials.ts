import {
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  type Material,
  type MaterialTotals,
  type MineTier
} from './types'

/**
 * Pure arithmetic over material breakdowns (see #22).
 *
 * Everything here is total-in, total-out with no mutation, so the ledger can
 * treat a breakdown as an immutable value and the accrual logic stays provable
 * without a filesystem or a clock.
 */

/**
 * The material a mine on `tier` is currently yielding.
 *
 * Today this is the identity: a copper mine yields copper. It stays a function
 * rather than an inlined cast because it is the ONE place the mapping lives —
 * the issue leaves open whether the lowest tier should eventually yield stone
 * instead of bronze, and that would be a one-line change here rather than a
 * hunt through the accrual code.
 *
 * It can never return 'coal': no tier produces coal, only the historical
 * backfill does.
 */
export function materialForTier(tier: MineTier): Material {
  return tier
}

/** A fresh breakdown with every material at zero. Never shared between callers. */
export function emptyMaterialTotals(): MaterialTotals {
  const totals = {} as MaterialTotals
  for (const material of MATERIALS) totals[material] = 0
  return totals
}

/**
 * `totals` plus `tokens` of `material`, as a new breakdown.
 *
 * A negative or non-finite credit is dropped rather than applied: the vault is
 * cumulative by definition, and the only way such a value can arrive is a bug
 * or a hand-edited file — neither of which should be able to erode totals the
 * user has already been shown.
 */
export function addMaterialTokens(
  totals: MaterialTotals,
  material: Material,
  tokens: number
): MaterialTotals {
  if (!Number.isFinite(tokens) || tokens <= 0) return { ...totals }
  return { ...totals, [material]: totals[material] + tokens }
}

/** Two breakdowns added material by material. */
export function mergeMaterialTotals(a: MaterialTotals, b: MaterialTotals): MaterialTotals {
  const merged = emptyMaterialTotals()
  for (const material of MATERIALS) merged[material] = a[material] + b[material]
  return merged
}

/** Every breakdown in the list folded into one. */
export function sumMaterialTotals(list: readonly MaterialTotals[]): MaterialTotals {
  return list.reduce<MaterialTotals>(mergeMaterialTotals, emptyMaterialTotals())
}

/**
 * Whole visible units `tokens` of `material` represents, rounded down — the
 * same idle-game currency floor the renderer's oreCount() has always used, so
 * a partially-mined unit never shows up until it is complete.
 */
export function materialUnits(tokens: number, material: Material): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.floor(tokens / MATERIAL_TOKENS_PER_UNIT[material])
}

/** The raw token count underneath a whole breakdown. */
export function totalMaterialTokens(totals: MaterialTotals): number {
  return MATERIALS.reduce((sum, material) => sum + totals[material], 0)
}
