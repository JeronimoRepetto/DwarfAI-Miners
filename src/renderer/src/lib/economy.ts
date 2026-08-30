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

/*
 * orePileStep()/MAX_PILE_STEP used to live here: five hand-picked ore counts
 * (1/5/20/50/150) at which the cave's layered CSS heap thickened by one more
 * circle. Both are gone with the heap itself (see #22) — the cave now draws one
 * painted nugget per whole unit, laid out by lib/nuggetPile.ts, so growth is
 * the real count up to the mound's capacity and a scale factor past it rather
 * than five coarse steps standing in for it.
 */
