/**
 * What one row of a project browse says on a card, and what it refuses to say
 * (#92).
 *
 * The refusals are the point: a browse spans projects nobody has walked and
 * projects nobody is working, and a card that filled either gap with a
 * plausible value would be inventing history.
 */
import type { Mine, MineTier, ProjectSummary } from '../../types'
import { MINE_TIERS } from '../../types'
import { MOUND_SRC } from '../art'
import { designTierLabel } from '../presentation'

/**
 * The tier names the redesign puts on screen.
 *
 * The table itself moved to `presentation.ts` as `designTierLabel` when the
 * rebuilt map needed the same spelling for its tooltip (#136) — one home for
 * the design's tier copy, rather than a browse module the map would have had to
 * reach across families into. The name stays here because the browse surface is
 * where it is read.
 */
export const browseTierLabel = designTierLabel

/** One chip of the type filter row; `tier: null` is All, which filters nothing. */
export interface TierChip {
  tier: MineTier | null
  label: string
}

/** All first, then every tier poorest first — the canonical progression. */
export const TIER_CHIPS: readonly TierChip[] = [
  { tier: null, label: 'All' },
  ...MINE_TIERS.map((tier) => ({ tier, label: browseTierLabel(tier) }))
]

/**
 * The tier to print on a card, or nothing at all.
 *
 * `knownTier` is absent until a walk has measured one, and absent means
 * unmeasured rather than bronze (#41). A card states a measurement or it states
 * nothing — the provisional bronze `tierOf()` hands the map is for DRAWING a
 * mound, and a label is a claim.
 */
export function cardTierLabel(project: ProjectSummary): string | undefined {
  return project.knownTier === undefined ? undefined : browseTierLabel(project.knownTier)
}

/** The entrance painting of the measured tier; no painting for an unmeasured project. */
export function cardArtFor(project: ProjectSummary): string | undefined {
  return project.knownTier === undefined ? undefined : MOUND_SRC[project.knownTier]
}

/**
 * How many agents are working a project right now, or nothing when the panel
 * cannot back a number.
 *
 * `live` is stamped by the poll that answered the browse, and the board the
 * panel holds may be one poll older, so a live project with no mine on the
 * board is a count we do not have — not a count of zero. A mine that IS on the
 * board with an empty crew is zero, which the board can honestly say.
 */
export function activeAgentsFor(
  project: ProjectSummary,
  mines: readonly Mine[]
): number | undefined {
  if (!project.live) return undefined
  return mines.find((mine) => mine.id === project.id)?.dwarfs.length
}
