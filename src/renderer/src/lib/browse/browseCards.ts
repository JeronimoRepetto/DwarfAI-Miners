/**
 * What one row of a project browse says on a card, and what it refuses to say
 * (#92).
 *
 * AMENDED for #635 (PR2): the redesigned card is built in mineCard.ts, on top of the three facts
 * kept here (the tier a card may state, whether it is being measured, its way to the next tier).
 * The helpers only the retired card and panel read went with them: browseTierLabel (the redesign's
 * tier words are presentation.ts's designTierLabel), TIER_CHIPS (the page's chips), cardTierLabel
 * and cardArtFor (the card draws its tier and mound from mineCardView), activeAgentsFor and
 * cardStatusFor (the crew line of pills, crewPills in mineCard.ts).
 *
 * The refusals are the point: a browse spans projects nobody has walked and
 * projects nobody is working, and a card that filled either gap with a
 * plausible value would be inventing history.
 */
import type { MineTier, ProjectSummary } from '../../types'
import { TIER_WEIGHT_THRESHOLDS_KB } from '../../types'

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

/**
 * Whether this card is a mine still being measured (#165).
 *
 * The third acceptance run's fourth correction. The maintainer declared a
 * folder and its card sat bare for as long as the tier walk took — no tier, no
 * entrance, no bar. Every one of those absences was right on its own (#41
 * forbids claiming a tier nobody has measured), but three of them at once read
 * as a broken card rather than as work in progress. This is the card saying
 * which it is, and it says nothing about the outcome: it is the absence of a
 * measurement plus the presence of a reason to expect one.
 *
 * Declared only. A discovered row has no walk promised to it, so an unmeasured
 * one is a project nobody has looked at rather than one being looked at now —
 * and "Measuring the mine..." on a card nothing is measuring would be exactly
 * the invention the rest of this module refuses.
 *
 * AMENDED for #635 (PANEL-QUESTIONS 29, design lead ruling 2026-09-27): a mine
 * measured before is measuring too while it is re-measured, and it KEEPS its
 * tier. So this reads the weight rather than the tier. `weightBytes` is this
 * run's reading, off TierService's in-memory cache, and main's own read of it
 * schedules the walk that fills it; `knownTier` is the store's record of an
 * earlier run's verdict. A stored tier with no weight is therefore a mine
 * measured before whose walk this run still owes — a stale reading, which
 * still counts as known (#41), so the card states it and ranks by it. Only a
 * row with neither is "never walked": no tier, the Bronze placeholder, last.
 * A declared mine with no tier to state is still always measuring, so no card
 * is left bare with neither a tier nor the pill.
 */
export function isMeasuring(project: ProjectSummary): boolean {
  return project.declared && project.weightBytes === undefined
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
