/**
 * The vault, as the panel has to draw it: one independent pile per material.
 *
 * The single rule this module exists to protect (see #22 and the MaterialTotals
 * comment in shared/contracts.ts): materials NEVER convert into one another.
 * Coal stays coal and silver stays silver for the life of the vault, and a mine
 * that changes tier keeps every unit it already produced. So there is
 * deliberately no function here that adds two materials together — every
 * operation below touches one material's own counter, and the panel renders a
 * row per material rather than a single combined figure, because one merged
 * number would imply exactly the exchange rate the design refuses.
 *
 * MATERIAL_TOKENS_PER_UNIT is a per-material GRAIN SIZE, not a rate of
 * exchange: it says how many tokens one drawn nugget stands for, and therefore
 * how common that ore is. Dividing gold's tokens by gold's grain is the only
 * thing it is ever used for.
 */
import {
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  type Material,
  type MaterialTotals,
  type MineTier
} from '../types'
import { formatTokens } from './economy'

/**
 * A fresh breakdown with every material at zero. Never shared between callers.
 *
 * The main process has its own twin in domain/materials.ts. They are not shared
 * because the only module the two processes have in common is the contract, and
 * that file is deliberately data-only — types and tables, no behaviour.
 */
export function emptyMaterialTotals(): MaterialTotals {
  const totals = {} as MaterialTotals
  for (const material of MATERIALS) totals[material] = 0
  return totals
}

/**
 * Whole drawn nuggets that many tokens of ONE material represents.
 *
 * Rounded down, the same idle-game currency floor oreCount() has always used,
 * so a partially-mined nugget never shows up until it is complete. Mirrors
 * materialUnits() in the main process's domain/materials.ts — the panel cannot
 * import across the process boundary, and re-deriving it from the shared rate
 * table is cheaper than shipping the number over IPC.
 */
export function materialUnits(tokens: number, material: Material): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.floor(tokens / MATERIAL_TOKENS_PER_UNIT[material])
}

/** One material's own pile: its own tokens, and its own nuggets. */
export interface VaultRow {
  material: Material
  /** Tokens accrued in this material, and this material alone. */
  tokens: number
  /** Nuggets those tokens are drawn as, at this material's grain size. */
  units: number
}

/**
 * The breakdown to render, poorest material first — the order MATERIALS itself
 * declares, so the panel and the contract can never disagree about it.
 *
 * A material that has not yet reached one whole nugget is left out rather than
 * shown as a zero: a labelled row with nothing in it claims a pile that is not
 * there, and the raw token gauge beside the breakdown already accounts for
 * every token, complete nugget or not.
 *
 * `totals` is optional because the wire field is (see Mine.materials): a
 * snapshot published before the ledger finished loading carries none, and that
 * is an empty vault, not a fault.
 */
export function vaultRows(totals: MaterialTotals | undefined): VaultRow[] {
  if (totals === undefined) return []
  const rows: VaultRow[] = []
  for (const material of MATERIALS) {
    const tokens = totals[material]
    const units = materialUnits(tokens, material)
    if (units > 0) rows.push({ material, tokens, units })
  }
  return rows
}

/**
 * The one row for the material a mine's CURRENT tier yields (see #48).
 *
 * A map badge has room for exactly one figure, but a mine that has changed
 * tier holds several materials in its ledger (see #22) — so the badge shows
 * the tier in force now rather than a sum across the others, which is exactly
 * the conversion this module's rule refuses. `tier` doubles as the lookup key
 * directly: materialForTier() in the main process is the identity function
 * today (a copper mine yields copper), and MineTier is already a subset of
 * Material, so no separate mapping is needed here.
 *
 * undefined when this material has not yet reached one whole unit — a mine
 * freshly promoted to a new tier, for instance, before it has mined anything
 * at that tier's own grain size yet. The badge hides rather than show a "0"
 * for a pile that, at this material, is not there.
 */
export function currentMaterialRow(
  totals: MaterialTotals | undefined,
  tier: MineTier
): VaultRow | undefined {
  return vaultRows(totals).find((row) => row.material === tier)
}

/**
 * Compact display of a nugget count — the same compaction the token gauge uses,
 * because a pile past the render cap can hold hundreds of thousands of nuggets
 * and "428913" in a 12px badge is not a number anybody reads.
 */
export function formatUnits(units: number): string {
  return formatTokens(units)
}
