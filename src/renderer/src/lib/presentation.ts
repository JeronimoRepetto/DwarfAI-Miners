import type { DwarfAttendance, DwarfRole, Material, MineTier } from '../types'
import { dwarfSilenceWindowMs } from '../types'
import { formatTokens } from './vault/economy'
import { materialUnits } from './vault/vault'

/**
 * A material's name as the panel writes it: "Coal", "Uranium".
 *
 * Kept separate from tierLabel even though the five tier materials are spelled
 * exactly like the tiers that produce them, because they are different things
 * the panel says differently — a "Gold mine" is a tier, "Gold ore" is a
 * material — and because two of the materials (coal today, iron eventually)
 * belong to no tier at all.
 */
export function materialLabel(material: Material): string {
  return material.slice(0, 1).toUpperCase() + material.slice(1)
}

export function tierLabel(tier: MineTier): string {
  return materialLabel(tier)
}

/**
 * The tier names the REDESIGNED surfaces put on screen (#90).
 *
 * REVERSED (#165, 2026-09-03): this table spelled the copper tier `Cropper`
 * from #90 until this correction, on the design source's own claim — since
 * withdrawn — that the misspelling was confirmed and deliberate. The
 * maintainer ruled the opposite: it was never meant to survive, and the
 * English word is `Copper`. Do not "fix" this back to `Cropper` from
 * `foundations.md`'s corrections table or any other stale doc — that table
 * is itself what the maintainer is amending; it is the thing that was wrong,
 * not evidence this table is.
 *
 * Kept apart from `tierLabel` above as two functions, not because the two
 * spellings still differ — they no longer do — but because they serve
 * different rebuild stages: `tierLabel` serves the cave and the parts of the
 * panel the rebuild has not reached yet, this one the redesigned surfaces,
 * and collapsing them would make a future screen-specific correction here
 * reach back into a screen this table was never meant to answer for. It
 * moved here from
 * `browse/browseCards.ts` when the map became the second rebuilt surface to
 * need it (#136); a cross-family import from map into browse would have been
 * the worse half of that choice.
 */
const DESIGN_TIER_LABELS: Record<MineTier, string> = {
  bronze: 'Bronze',
  copper: 'Copper',
  silver: 'Silver',
  gold: 'Gold',
  uranium: 'Uranium'
}

export function designTierLabel(tier: MineTier): string {
  return DESIGN_TIER_LABELS[tier]
}

/*
 * WHERE THE FRAME LOOPS WENT (issues #74, #87).
 *
 * Nine painted poses used to be named here and cycled by name: `DwarfFrame`,
 * `DwarfAnimation`, the WORKING / WAITING / SILENT / AWAITING_ANSWER records,
 * `WALK_ANIMATION`, `dwarfAnimation`, `sceneDwarfAnimation`,
 * `stillDwarfAnimation`, `NEUTRAL_DWARF_FRAME` and `isPickImpact`. Each frame
 * was its own ~195 KB PNG keyed in art.ts.
 *
 * The hand-drawn dwarfs arrive as packed strips instead, so an animation is a
 * FILE rather than a list of pose names and there is nothing left for a pose
 * union to name. All of it now lives in `lib/sprite/`: the frame arithmetic in
 * spriteSheet.ts, which strips exist in dwarfSheets.ts, and which of them a
 * dwarf plays in dwarfSequence.ts, tested beside each.
 *
 * Two things stayed behind on purpose. `isDwarfSilent` below is a rule about
 * the provider's windows rather than about drawing, and is unchanged — what
 * changed is that no sheet has been drawn for a silent dwarf yet, so nothing
 * currently selects a picture from it (#74 will).
 *
 * REMOVED for #635, with the scene they served: `statusAnimationClass`, `LEAVING_EXIT_MS` and
 * `BUBBLE_MAX_CHARS` (the old sprite's status class, its departure fade and the talk bubble's
 * budget), `describeSilence` (the old tooltip's sentence; the redesigned tooltip writes
 * `compactSilence`, lib/dwarf/dwarfTip.ts) and `vaultLabel` (the retired vault chip's name).
 */

/**
 * Has this dwarf gone quiet for long enough to be worth showing as such?
 *
 * The windows are the PROVIDER's own (dwarfSilenceWindowMs, shared with issue
 * #40's staleness rule) and are read rather than restated, so the panel can
 * never call a dwarf busy while the provider is already counting it out. A
 * window that has exactly elapsed reads as silent, the same side of the
 * boundary the provider picks.
 *
 * `attendance` is what picks between the two windows, not the rank (issue
 * #68): the long one exists for a session a human may be typing into, and a
 * headless run is the root of its own tree and therefore a foreman too. Absent
 * — a provider that has not been taught to report it — keeps the long window,
 * so nothing about such a dwarf changes until somebody actually answers.
 *
 * `silentForMs` being `undefined` is the absence of the other evidence — a
 * provider that keeps no per-agent transcript — and is never treated as
 * silence.
 */
export function isDwarfSilent(
  role: DwarfRole,
  silentForMs: number | undefined,
  attendance?: DwarfAttendance
): boolean {
  return silentForMs !== undefined && silentForMs >= dwarfSilenceWindowMs(role, attendance)
}

/**
 * What one ore pile says when the pointer rests on it, and what a screen reader
 * is told it is.
 *
 * The owner's verdict on the old CSS heap was that it read as grey balls nobody
 * recognises, and painted nuggets alone would not have fixed that: a picture of
 * a stone still does not say how much has been mined. So the affordance is the
 * words, and the words live here rather than in the template — which is exactly
 * why they survived the art swap unchanged.
 *
 * It takes a MATERIAL, not a tier: a pile is a pile of one material, counted at
 * that material's own grain size. Coal has no tier and never will.
 */
export function orePileLabel(material: Material, tokens: number): string {
  const units = materialUnits(tokens, material)
  if (units === 0) return `${materialLabel(material)} ore — none mined yet`
  return `${materialLabel(material)} ore — ${units} mined (${formatTokens(tokens)} tokens)`
}

/*
 * REMOVED HERE: `isSpriteFlipped(status)` (#156).
 *
 * It mirrored a leaving dwarf and nothing else, on the strength of a sentence
 * carried since #131 flagged it as unconfirmed — "the art is painted facing
 * right". The art is painted facing LEFT, which is measured off the committed
 * sheets in lib/sprite/sheetFacing.test.ts, and the exit slide runs left. So a
 * leaver reaches the exit by being drawn exactly as painted, every other status
 * was already drawn that way, and there was no case left for this to decide.
 *
 * What replaces it is the scene's own facing, which DwarfSprite already had:
 * `facesLeft` from the station a dwarf stands at, or from the leg it is walking.
 * The mirror lives beside it, in the one component that draws a sprite.
 */

/**
 * A whole number as the redesigned surfaces write it: comma thousands ("1,630 / 2,048",
 * "Coal: 280,612"). Spelled out rather than through `toLocaleString`, because the design fixes
 * the shape and the locale of the machine must not change it (#635).
 */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
