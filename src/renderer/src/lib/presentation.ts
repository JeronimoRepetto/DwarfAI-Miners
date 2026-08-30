import type { DwarfRole, DwarfStatus, Material, MaterialTotals, MineTier } from '../types'
import { formatTokens } from './economy'
import { materialUnits, vaultRows } from './vault'

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
 * The plain standing pose. Deliberately absent from every running loop below,
 * so showing it always reads as a pause — it covers brief transitions such as
 * the moment between clicking a dwarf and its terminal taking focus.
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

const WAITING: Record<DwarfRole, DwarfAnimation> = {
  worker: { frames: ['rest-1', 'rest-2'], frameMs: 1400 },
  // Temporary (issue #34): a blocked foreman reuses the worker rest loop so a
  // waiting session reads as visibly paused instead of a foreman still on
  // duty. Dedicated foreman-waiting art is deferred and must not block —
  // swap these frames when it lands.
  foreman: { frames: ['rest-1', 'rest-2'], frameMs: 1400 }
}

/**
 * The walk cycle. Leaving is a walk regardless of rank — the foreman uses the
 * same door — and since issue #19 every dwarf also walks *to* the painted
 * feature its status calls for, so the same two frames cover both journeys and
 * the scene needs no new art to move anyone around.
 */
export const WALK_ANIMATION: DwarfAnimation = { frames: ['walk-1', 'walk-2'], frameMs: 350 }

/** Which poses to cycle for a dwarf in this state, and how fast. */
export function dwarfAnimation(status: DwarfStatus, role: DwarfRole): DwarfAnimation {
  if (status === 'leaving') return WALK_ANIMATION
  return status === 'working' ? WORKING[role] : WAITING[role]
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
  walking: boolean
): DwarfAnimation {
  return walking ? WALK_ANIMATION : dwarfAnimation(status, role)
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
