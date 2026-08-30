import { DWARF_SILENCE_WINDOW_MS } from '../../../shared/contracts'
import type {
  DwarfRole,
  DwarfStatus,
  Material,
  MaterialTotals,
  MineTier,
  WaitingReason
} from '../types'
import { WAITING_ON_HUMAN_REASON } from '../types'
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

/** Character budget for speech bubbles (truncated with an ellipsis). */
export const BUBBLE_MAX_CHARS = 70

/**
 * One painted dwarf pose. Each name maps to `assets/art/dwarf-<name>.png`,
 * and every pose shares one canvas and baseline (see scripts/build-art.mjs),
 * so swapping frames animates the drawing without moving the sprite.
 */
export type DwarfFrame =
  | 'idle'
  | 'pick-1'
  | 'pick-2'
  | 'walk-1'
  | 'walk-2'
  | 'rest-1'
  | 'rest-2'
  | 'foreman-idle'
  | 'foreman-check'

/** A frame loop: which poses to cycle, and how long each one holds. */
export interface DwarfAnimation {
  frames: readonly DwarfFrame[]
  frameMs: number
}

/**
 * The plain standing pose: the dwarf upright with his pickaxe over his
 * shoulder, tool in hand, not swinging.
 *
 * Deliberately absent from every RUNNING loop below, so showing it always reads
 * as a pause. It covers brief transitions such as the moment between clicking a
 * dwarf and its terminal taking focus — and, since issue #47, the silence pose,
 * which is what that reserve was being kept for: "supposed to be working, and
 * nothing is happening" is exactly what this drawing says, so the change needed
 * no new art at all.
 */
export const NEUTRAL_DWARF_FRAME: DwarfFrame = 'idle'

/** How long a leaving dwarf has to walk out, matching the runtime grace window. */
export const LEAVING_EXIT_MS = 16_000

const WORKING: Record<DwarfRole, DwarfAnimation> = {
  // A worker swings; slow enough to read as effort rather than a flicker.
  worker: { frames: ['pick-1', 'pick-2'], frameMs: 550 },
  // The foreman does not dig. He looks up from the log book now and then.
  foreman: { frames: ['foreman-idle', 'foreman-check'], frameMs: 1000 }
}

/**
 * Sleep is said ONCE, and the CSS `z z z` DwarfSprite floats over the sprite is
 * what says it (issue #72). `rest-2` differs from `rest-1` only by a painted
 * `z` — silhouette IoU 0.994, see docs/animation-loops.md — so the pair was
 * two indicators for one fact, and the "loop" was a single pose wearing a
 * loop's clothes.
 *
 * The overlay is the half that survives because it is the half that lets the
 * dwarf be still, which is what a sleeping dwarf is supposed to be: a one-frame
 * loop starts no timer at all (see DwarfSprite's watcher). The painted `z`
 * could only ever be shown by swapping images 43 times a minute to blink one
 * glyph, and it was dark for half of every cycle. `rest-2` stays in the art
 * table unplayed; the source painting lives outside this repository, so it
 * cannot be redrawn.
 *
 * This is a decision, not layering. Do not put a second sleep indicator back —
 * if the overlay ever has to go, its replacement is the painted frame, alone.
 *
 * `frameMs` is inert while the loop holds one frame, and is kept at the tempo
 * rest has always used so that a second frame landing later changes no cadence
 * by surprise (the same reason SILENT below keeps its own).
 */
const WAITING: Record<DwarfRole, DwarfAnimation> = {
  worker: { frames: ['rest-1'], frameMs: 1400 },
  // Temporary (issue #34): a blocked foreman reuses the worker rest pose so a
  // waiting session reads as visibly paused instead of a foreman still on
  // duty. Dedicated foreman-waiting art is deferred and must not block —
  // swap these frames when it lands.
  foreman: { frames: ['rest-1'], frameMs: 1400 }
}

/**
 * The pose of a dwarf that is supposed to be working and has produced nothing
 * for its whole window (issue #47).
 *
 * One frame each, and each rank stands the way its own art already stands: the
 * worker shoulders the pick instead of swinging it, the foreman stops looking
 * up from the log book. That completes the visual language rather than adding
 * to it — swinging, standing, sat down, walking out — and needs no new asset.
 *
 * `frameMs` is inert here: the sprite starts no timer at all for a single-frame
 * loop, so a dwarf we suspect is dead costs LESS to draw than a live one, which
 * is quietly the right way round. Each borrows the tempo of the loop it
 * replaces so that adding a second frame later would not change the cadence by
 * surprise.
 */
const SILENT: Record<DwarfRole, DwarfAnimation> = {
  worker: { frames: [NEUTRAL_DWARF_FRAME], frameMs: WORKING.worker.frameMs },
  foreman: { frames: ['foreman-idle'], frameMs: WORKING.foreman.frameMs }
}

/**
 * The pose of a dwarf whose provider proved a human has been asked a question
 * and has not answered (issue #60): the dwarf holding an open parchment or one
 * hand raised toward the viewer, then glancing back at the page.
 *
 * ATTENTIVE, NOT ASLEEP, and that is the whole reason it is a loop of its own.
 * A blocked session already rests (issue #34) and a silent one already stands
 * still (issue #47); neither says "I need you", and a sleep overlay would say
 * the opposite. Two frames, because every current active loop is a two-frame
 * pair and a single frozen pose reads as the silence pose.
 *
 * THE PAINTINGS DO NOT EXIST YET. Until they do this points at the rest loop,
 * exactly as #34's foreman-waiting art does, so the panel promises nothing it
 * cannot draw — swap these frames when the poses land and nothing else moves.
 * Only the FOREMAN pose is worth commissioning: a worker has no evidence that
 * could ever select this loop, since a Claude subagent's sidecar records no
 * status at all and Codex writes no blocked record, so the worker entry here is
 * structural rather than something anybody will see.
 */
export const AWAITING_ANSWER_ANIMATION: Record<DwarfRole, DwarfAnimation> = {
  // Copies of the rest loops rather than aliases of them, so that "this loop
  // was selected" and "this loop currently looks like resting" stay two
  // separate facts — one is the wiring, the other is the placeholder, and the
  // tests can hold each without the other.
  worker: { ...WAITING.worker },
  foreman: { ...WAITING.foreman }
}

/**
 * The walk cycle. Leaving is a walk regardless of rank — the foreman uses the
 * same door — and since issue #19 every dwarf also walks *to* the painted
 * feature its status calls for, so the same two frames cover both journeys and
 * the scene needs no new art to move anyone around.
 */
export const WALK_ANIMATION: DwarfAnimation = { frames: ['walk-1', 'walk-2'], frameMs: 350 }

/**
 * Has this dwarf gone quiet for long enough to be worth showing as such?
 *
 * The windows are the PROVIDER's own (DWARF_SILENCE_WINDOW_MS, shared with
 * issue #40's staleness rule) and are read rather than restated, so the panel
 * can never call a dwarf busy while the provider is already counting it out.
 * A window that has exactly elapsed reads as silent, the same side of the
 * boundary the provider picks.
 *
 * `undefined` is the absence of evidence — a provider that keeps no per-agent
 * transcript — and is never treated as silence.
 */
export function isDwarfSilent(role: DwarfRole, silentForMs: number | undefined): boolean {
  return silentForMs !== undefined && silentForMs >= DWARF_SILENCE_WINDOW_MS[role]
}

/**
 * Which poses to cycle for a dwarf in this state, and how fast.
 *
 * `silent` layers over `working` ALONE and is deliberately a separate argument
 * rather than a fourth status: a waiting dwarf is already provably blocked and
 * a leaving one is already on its way out, so neither needs a second reading of
 * the same fact — and keeping silence out of DwarfStatus is what stops it
 * leaking into the ledger, the delivery channels and the capability matrix,
 * every one of which keys off status (see Dwarf.silentForMs).
 *
 * `waitingReason` layers over a blocked dwarf the same way, and only its one
 * proven value picks a different loop (see WAITING_ON_HUMAN_REASON). An
 * approval and an open dialog rest exactly as they always have: the panel may
 * single a dwarf out for attention only where a provider proved a person was
 * asked, never on a reason that merely might mean one.
 */
export function dwarfAnimation(
  status: DwarfStatus,
  role: DwarfRole,
  silent = false,
  waitingReason?: WaitingReason
): DwarfAnimation {
  if (status === 'leaving') return WALK_ANIMATION
  if (status !== 'working') {
    return waitingReason === WAITING_ON_HUMAN_REASON
      ? AWAITING_ANSWER_ANIMATION[role]
      : WAITING[role]
  }
  return silent ? SILENT[role] : WORKING[role]
}

/**
 * The same choice, but aware that the dwarf may still be on its way there.
 *
 * A miner crossing the floor toward a vein must not be swinging a pick at thin
 * air, and a dwarf heading for the rest boulders must not already be asleep on
 * its feet: while travelling, everyone walks.
 */
export function sceneDwarfAnimation(
  status: DwarfStatus,
  role: DwarfRole,
  walking: boolean,
  silent = false,
  waitingReason?: WaitingReason
): DwarfAnimation {
  return walking ? WALK_ANIMATION : dwarfAnimation(status, role, silent, waitingReason)
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
 * Whether this pose is the moment the pick actually bites the rock.
 *
 * The swing is two frames and only the down-stroke is a hit, so sparks fire on
 * this one alone — otherwise the debris reads as a permanent glow around the
 * dwarf rather than as impacts.
 */
export function isPickImpact(frame: DwarfFrame): boolean {
  return frame === 'pick-2'
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

/**
 * Whether the sprite has to be mirrored. The art is painted facing right and
 * the scene exit is to the left, so only a leaving dwarf gets flipped.
 */
export function isSpriteFlipped(status: DwarfStatus): boolean {
  return status === 'leaving'
}
