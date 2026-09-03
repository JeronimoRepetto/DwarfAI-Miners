/**
 * What one row of a project browse says on a card, and what it refuses to say
 * (#92).
 *
 * The refusals are the point: a browse spans projects nobody has walked and
 * projects nobody is working, and a card that filled either gap with a
 * plausible value would be inventing history.
 */
import type { Mine, MineTier, ProjectSummary } from '../../types'
import { MINE_TIERS, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'
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
 * The tier a card may state, or nothing at all.
 *
 * ## Why this is a derivation and not just a field (#153)
 *
 * A declared folder's card drew the level bar with no tier and no art beside it,
 * and the cause was a join. The bar reads `weightBytes`, which the tier walk's
 * own cache publishes for anything it has ever weighed; the label and the
 * painting read `knownTier`, which the projects store only fills while a mine is
 * actually being WORKED. So a card could say how far a mine had climbed while
 * refusing to say which tier it was climbing in — half a fact, which reads as a
 * bug rather than as restraint.
 *
 * A measured weight IS a classification: it is the same number `tierForBytes`
 * classifies in main, against the same canonical table. So the weight answers
 * when the store has not. `knownTier` still wins where it exists — it is the
 * store's own record of a walk's verdict, and a derivation must never overrule
 * one — and absence still claims nothing at all, which is #41's rule intact:
 * `tierOf()`'s provisional bronze is for DRAWING a mound, never for stating a
 * fact on a card.
 */
export function cardTierFor(project: ProjectSummary): MineTier | undefined {
  if (project.knownTier !== undefined) return project.knownTier
  if (project.weightBytes === undefined) return undefined
  return tierForWeightBytes(project.weightBytes)
}

/**
 * The canonical classification of a byte weight.
 *
 * Mirrors `tierForBytes` in main/tier/tierService.ts — the same bracket order
 * and the same `>=` comparisons against the same shared table — so the two stay
 * one honest reading of one measurement rather than two classifications that
 * could disagree about the same folder. `nextBoundaryKbFor` below already
 * mirrors it for the bar's denominator; this is the tier that bar is climbing
 * out of, and keeping both here means the card has exactly one source.
 */
function tierForWeightBytes(weightBytes: number): MineTier {
  const { copperKb, silverKb, goldKb, uraniumKb } = TIER_WEIGHT_THRESHOLDS_KB
  if (weightBytes >= uraniumKb * BYTES_PER_KB) return 'uranium'
  if (weightBytes >= goldKb * BYTES_PER_KB) return 'gold'
  if (weightBytes >= silverKb * BYTES_PER_KB) return 'silver'
  if (weightBytes >= copperKb * BYTES_PER_KB) return 'copper'
  return 'bronze'
}

/** The tier to print on a card, or nothing at all — see cardTierFor. */
export function cardTierLabel(project: ProjectSummary): string | undefined {
  const tier = cardTierFor(project)
  return tier === undefined ? undefined : browseTierLabel(tier)
}

/** The entrance painting of that tier; no painting for a project nobody has weighed. */
export function cardArtFor(project: ProjectSummary): string | undefined {
  const tier = cardTierFor(project)
  return tier === undefined ? undefined : MOUND_SRC[tier]
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

/** The two markers a card can raise in its lower-right corner. */
export interface CardStatus {
  /** An agent on this project has asked its user something nothing has answered. */
  asking: boolean
  /** An agent on this project is resting rather than working. */
  resting: boolean
}

/**
 * What a card says about its crew beyond how many there are, or nothing at all.
 *
 * Joined off the board exactly as activeAgentsFor is, and absent for exactly
 * the same reasons: a project that is not live, or one whose mine the panel's
 * snapshot does not carry yet, is an absence of evidence. Two false markers
 * would be a claim about a crew nobody has looked at.
 *
 * Neither fact is derived here. `asking` is the provider's own structured
 * record of an ask (see Dwarf.pendingQuestion) — the same field the message
 * panel answers from, and never prose that reads like a question. `resting` is
 * `status === 'waiting'`, which is precisely what floats the `z z z` over a
 * dwarf in DwarfSprite. Both markers therefore mean on a card exactly what
 * they already mean inside the mine, which is the whole point of reading them
 * from the same two places rather than inventing a browse-only rule.
 */
export function cardStatusFor(
  project: ProjectSummary,
  mines: readonly Mine[]
): CardStatus | undefined {
  if (!project.live) return undefined
  const mine = mines.find((candidate) => candidate.id === project.id)
  if (mine === undefined) return undefined
  return {
    asking: mine.dwarfs.some((dwarf) => dwarf.pendingQuestion !== undefined),
    resting: mine.dwarfs.some((dwarf) => dwarf.status === 'waiting')
  }
}

/**
 * One kibibyte in bytes — this module's own conversion for reading the wire's
 * byte-weight field against a KB-denominated table (see ProjectSummary.
 * weightBytes and TIER_WEIGHT_THRESHOLDS_KB in shared/contracts.ts). Nothing
 * upstream does this conversion for the renderer; it belongs here, once.
 */
const BYTES_PER_KB = 1024

/**
 * What a card draws for the progress bar and its `Next level: <cur>/<max>`
 * label — the seam #135's rebuild left and #140 supplies the wire field for
 * (#90). `nextBoundaryKb` is undefined once a mine has already reached
 * uranium: the topmost tier has no further boundary to climb toward, which
 * the mock states as `infinite` rather than a number.
 */
export interface LevelProgress {
  /** weightBytes rounded to the nearest whole KB (Math.round — ties round up). */
  currentKb: number
  /** The next tier's KB threshold; undefined at/above uranium. */
  nextBoundaryKb: number | undefined
  /** How full the bar draws, clamped to [0,1] against the rounding above. */
  ratio: number
}

/**
 * The next tier's KB boundary a mine at this byte weight is climbing toward.
 *
 * Mirrors tierForBytes' own bracket order and >= comparisons
 * (main/tier/tierService.ts) so the two stay one honest reading of one
 * measurement rather than two classifications that could disagree. The
 * boundaries themselves are the CLEAN TIER_WEIGHT_THRESHOLDS_KB figures
 * (100/500/2048/8192) — the design mock's own printed maximums (99/499) are
 * one short of these for bronze/copper and already match for silver/gold, an
 * inconsistency the foundations table's canonical ranges resolve in the clean
 * numbers' favour (#90).
 */
function nextBoundaryKbFor(weightBytes: number): number | undefined {
  const { copperKb, silverKb, goldKb, uraniumKb } = TIER_WEIGHT_THRESHOLDS_KB
  if (weightBytes >= uraniumKb * BYTES_PER_KB) return undefined
  if (weightBytes >= goldKb * BYTES_PER_KB) return uraniumKb
  if (weightBytes >= silverKb * BYTES_PER_KB) return goldKb
  if (weightBytes >= copperKb * BYTES_PER_KB) return silverKb
  return copperKb
}

/**
 * The bar/label a card draws for a mine's progress toward its next tier, or
 * undefined for a project no walk has weighed yet — a bar with an invented
 * denominator is worse than no bar at all, so absence draws nothing rather
 * than a guess, same as every other unmeasured field on this card (#90).
 */
export function nextLevelFor(weightBytes: number | undefined): LevelProgress | undefined {
  if (weightBytes === undefined) return undefined
  const currentKb = Math.round(weightBytes / BYTES_PER_KB)
  const nextBoundaryKb = nextBoundaryKbFor(weightBytes)
  const ratio =
    nextBoundaryKb === undefined ? 0 : Math.min(1, Math.max(0, currentKb / nextBoundaryKb))
  return { currentKb, nextBoundaryKb, ratio }
}
