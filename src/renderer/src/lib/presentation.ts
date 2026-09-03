import type {
  DwarfAttendance,
  DwarfRole,
  DwarfStatus,
  Material,
  MaterialTotals,
  MineTier
} from '../types'
import { dwarfSilenceWindowMs } from '../types'
import { formatTokens } from './vault/economy'
import { materialUnits, vaultRows } from './vault/vault'

/** CSS modifier class driving each dwarf animation state. */
export type DwarfAnimationClass = 'is-working' | 'is-waiting' | 'is-leaving'

const STATUS_CLASS: Record<DwarfStatus, DwarfAnimationClass> = {
  working: 'is-working',
  waiting: 'is-waiting',
  leaving: 'is-leaving'
}

export function statusAnimationClass(status: DwarfStatus): DwarfAnimationClass {
  return STATUS_CLASS[status]
}

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

/** Character budget for speech bubbles (truncated with an ellipsis). */
export const BUBBLE_MAX_CHARS = 70

/**
 * How long a leaving dwarf takes to leave the screen (#153).
 *
 * It used to be 16 seconds, chosen to fill the runtime's own 20-second grace
 * window (`dwarfLeaveGraceS` in main/config) — and the fade held full opacity
 * for the first 85% of it, so a dwarf reached its exit and then stood there for
 * the best part of fourteen seconds. That is what the maintainer saw.
 *
 * The two clocks are separate now, because they answer different questions. How
 * long a departed session stays in the board is main's: it is a claim about the
 * session, and shortening it would start dropping dwarfs that are only briefly
 * quiet. How long the dwarf takes to LEAVE is the panel's, and prompt is the
 * only honest answer — the session is already gone.
 */
export const LEAVING_EXIT_MS = 1_200

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
 * currently selects a picture from it (#74 will). And `statusAnimationClass`
 * and `LEAVING_EXIT_MS` never named a frame at all.
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
 * How long this dwarf has produced nothing, as the tooltip says it out loud:
 * "no output for 25 minutes".
 *
 * The wording is the affordance, which is why it lives here rather than in the
 * template — the sprite can only say "something is wrong with this one", and
 * the sentence is what turns that into something a person can act on. A user
 * who has read "no output for 25 minutes" needs no explanation when the dwarf
 * leaves at thirty.
 *
 * It rounds DOWN throughout and never counts seconds: claiming more silence
 * than was observed would be the app arguing on the pessimistic side, and no
 * one reads a figure that ticks every second anyway.
 */
export function describeSilence(silentForMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, silentForMs) / 60_000)
  if (totalMinutes < 1) return 'no output for less than a minute'

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`)
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`)
  return `no output for ${parts.join(' ')}`
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

/**
 * The vault chip's accessible name: every material the vault holds, one by one.
 *
 * It lists and never sums. Adding the units up would produce a single figure
 * that only means anything if a coal nugget can be traded for a gold one, and
 * the whole point of the material vault is that it cannot (see vault.ts). The
 * token count is a separate sentence for the same reason — tokens are the raw
 * substance underneath every pile, not a currency the piles convert into.
 */
export function vaultLabel(totals: MaterialTotals | undefined, tokensObserved: number): string {
  const rows = vaultRows(totals)
  const mined =
    rows.length === 0
      ? 'nothing mined yet'
      : rows.map((row) => `${row.units} ${row.material}`).join(', ')
  return `Vault: ${mined}. ${formatTokens(tokensObserved)} tokens observed.`
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
