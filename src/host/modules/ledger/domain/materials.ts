// The ledger's value objects (06 §13.1): six materials, poorest first, each counted on its own.
// Pure: no I/O, no clock read (05 §2.2, R1).
//
// - A `MaterialAmount` carries tokens only; its units are derived, never stored apart from the
//   credit that computed them: `units = floor(tokens / TOKENS_PER_UNIT[material])` (06 §13.1).
// - Materials are never converted into, exchanged for, or summed with each other (INV-93,
//   ADR-029 #3, BR-15). Nothing in this module adds two materials together or maps one onto
//   another: a `MaterialTotals` is six separate counts, and the only arithmetic is within one
//   material.
// - A live credit is always one of the five tiers (`LiveMaterial`); coal is paid only by the
//   coal backfill (INV-95, later: ISSUE-077).

/** 06 §13.1 `Material`, poorest first. */
export type Material = 'coal' | 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/** Every material, poorest first (the order of the ore capsules). */
export const MATERIALS: readonly Material[] = Object.freeze([
  'coal',
  'bronze',
  'copper',
  'silver',
  'gold',
  'uranium'
])

/** The material of a measured mine's tier: what a live credit pays (INV-94). Never coal (INV-95). */
export type LiveMaterial = Exclude<Material, 'coal'>

/** 06 §13.1 `MaterialAmount`: a non-negative integer of tokens; units are derived. */
export interface MaterialAmount {
  tokens: number
}

/** One mine's `MaterialLedger.totals`: six separate counts, never summed (INV-93). */
export type MaterialTotals = Record<Material, MaterialAmount>

/** 06 §13.1 `TOKENS_PER_UNIT` (US-MINES-007 copy; today's `MATERIAL_TOKENS_PER_UNIT`). */
export const TOKENS_PER_UNIT: Readonly<Record<Material, number>> = Object.freeze({
  coal: 2_500,
  bronze: 10_000,
  copper: 25_000,
  silver: 50_000,
  gold: 100_000,
  uranium: 250_000
})

/** Whole units of `material` in `tokens`, by that material's own figure (06 §13.1). */
export function unitsOf(tokens: number, material: Material): number {
  return Math.floor(tokens / TOKENS_PER_UNIT[material])
}

/** A mine nothing was credited to: every material at zero. A new object per call. */
export function zeroTotals(): MaterialTotals {
  return {
    coal: { tokens: 0 },
    bronze: { tokens: 0 },
    copper: { tokens: 0 },
    silver: { tokens: 0 },
    gold: { tokens: 0 },
    uranium: { tokens: 0 }
  }
}
