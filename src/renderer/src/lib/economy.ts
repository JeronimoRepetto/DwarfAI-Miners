/**
 * Tokens-to-ore visual economy: tokens the AI sessions burn are shown as the
 * gold/ore the dwarfs have mined. Deliberately a rough idle-game metaphor,
 * not exact billing (see Dwarf.tokensObserved in shared/contracts.ts).
 */

/** Tokens that make up one visible ore nugget. */
export const TOKENS_PER_ORE = 10_000

/** Ore nuggets a token count represents, rounded down (an idle-game currency floor). */
export function oreCount(tokensObserved: number): number {
  return Math.floor(Math.max(0, tokensObserved) / TOKENS_PER_ORE)
}

const COMPACT_UNITS: readonly [threshold: number, suffix: string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K']
]

/** Compact display of a raw token count: 0 -> '0', 1234 -> '1.2K', 2_500_000 -> '2.5M'. */
export function formatTokens(n: number): string {
  const value = Math.max(0, n)
  for (const [threshold, suffix] of COMPACT_UNITS) {
    if (value >= threshold) return `${trimTrailingZero((value / threshold).toFixed(1))}${suffix}`
  }
  return String(Math.trunc(value))
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * Ore counts at which the pile visibly thickens by one more layer. Coarse and
 * hand-picked (idle-game growth, not a precise gauge) — see orePileStep.
 */
const PILE_STEP_THRESHOLDS = [1, 5, 20, 50, 150] as const

/** How many stacked ore-pile layers a mine's ore count should render (0..MAX_PILE_STEP). */
export const MAX_PILE_STEP = PILE_STEP_THRESHOLDS.length

/**
 * How many stacked ore-pile layers to show for an ore count. The pile grows
 * in a small number of discrete visible steps rather than tracking every
 * nugget one-for-one, so a mound near the mine entrance visibly thickens as
 * its crew burns through more tokens, built entirely from layered CSS shapes.
 */
export function orePileStep(ore: number): number {
  let step = 0
  for (const threshold of PILE_STEP_THRESHOLDS) {
    if (ore >= threshold) step++
  }
  return step
}
