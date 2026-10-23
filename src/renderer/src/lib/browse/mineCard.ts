/*
 * What one mine card shows (#635), `molecules/mine-card` in the design: the tier chip and name,
 * one ore capsule per material, the crew line of pills, and the way to the next tier at full
 * width. The card component draws a MineCardView; this builds it from a browse row and the board.
 *
 * ## What a card may claim
 *
 * Every refusal of the card this replaces still holds (browseCards.ts, #41, #90, #165). The tier
 * a card DRAWS may be a placeholder: a mine nobody has measured wears Bronze, as the design rules
 * for a mine just added ("starts Bronze, score 0, state Measuring"). That is `tierOf()`'s
 * provisional bronze, for drawing only — it never reaches anything that records a decision. A
 * mine measured before is measuring too while it is re-measured, and keeps its last tier, which
 * is known rather than a placeholder (PANEL-QUESTIONS 29). The progress bar, the ore and the crew
 * claim only what was measured or seen: no score, no bar; no ore on the board, no capsules; a live
 * mine the board has not caught up with, no pills at all.
 *
 * The list row says a mine's tier (`mines.list`, 14 B-M19); the board says everything else the
 * Host knows of it — its ore (`MineWire.totals`), its score (`MineWire.score`, AMENDMENT-26) and
 * whether it is being measured (`MineWire.state`) — so the card reads those off the board.
 *
 * Units are per material and never summed or converted (vault.ts).
 */
import { vaultRows } from '../vault/vault'
import { designTierLabel } from '../presentation'
import { dwarfNeedsYou } from '../shell/panelNav'
import { sceneDwarfStatus } from '../scene/sceneDwarf'
import { needsYouCount } from '../shell/navSlot'
import type { TierProgressOptions } from './tierProgress'
import { cardTierFor } from './browseCards'
import type { PillTone } from '../dwarf/badge'
import type { MenuItem } from '../overlay/menu'
import { MINE_TIERS } from '../../types'
import type { BrowseRow, Dwarf, Material, Mine, MineTier } from '../../types'

export { dwarfNeedsYou }

/** The design's four card states: m.state in its mine-card.js. */
export type MineCardState = 'active' | 'measuring' | 'unrecorded' | 'unenterable'

export interface CrewPill {
  text: string
  tone?: PillTone
  /** The needs-you pill's "?" plate. */
  ask?: boolean
}

export interface MineCardView {
  id: string
  name: string
  /** The tier the card draws: measured where there is a measurement, the Bronze placeholder else. */
  tier: MineTier
  /** Whether that tier was measured: only a measured tier answers a tier filter (#41). */
  measured: boolean
  state: MineCardState
  ore: { material: Material; units: number }[]
  crew: CrewPill[]
  /** Whether any of the crew waits on the person: the heavy outline. */
  needs: boolean
  /** How many of the crew wait on the person, which the needs-you order sorts by. */
  needsCount: number
  /** The tier progress, or nothing where there is no measurement to show. */
  progress?: TierProgressOptions
  /** Why a not-enterable mine cannot be entered. */
  reason?: string
  enterable: boolean
  /** Whether the store holds a row the removal can flag (#169). */
  removable: boolean
  /** The measured weight in KB, which the tier order sorts by within a tier. */
  score?: number
}

/**
 * The crew line: "N working", "N need you", "N asleep", each only when non-zero; "No dwarfs" for
 * no crew; one "idle", with no count, when nobody is working, asking or asleep (components.md,
 * Mine card, As built). Asleep is a session at rest that asked nobody anything. Each dwarf is
 * bucketed by the status the scene draws (sceneDwarfStatus: the Host's own word, so an idle or
 * asking dwarf is never counted asleep; VQA-04).
 */
export function crewPills(dwarfs: readonly Dwarf[]): CrewPill[] {
  if (dwarfs.length === 0) return [{ text: 'No dwarfs' }]
  let working = 0
  let needs = 0
  let asleep = 0
  for (const dwarf of dwarfs) {
    const status = sceneDwarfStatus(dwarf)
    if (status === 'asking') needs++
    else if (status === 'working') working++
    else if (status === 'asleep') asleep++
  }
  const pills: CrewPill[] = []
  if (working) pills.push({ text: working + ' working' })
  if (needs) pills.push({ text: needsYouCount(needs), tone: 'needs', ask: true })
  if (asleep) pills.push({ text: asleep + ' asleep' })
  return pills.length ? pills : [{ text: 'idle' }]
}

/*
 * The tier progress, off the board's mine (AMENDMENT-26, owner-approved 2026-10-23): the Host's score, in KB, over
 * the next tier's KB floor under the Host's active thresholds, which the renderer cannot know (06 §4.1: environment
 * overrides). The next tier is the one after the mine's own; the top tier has none and reads "Max tier" with its
 * score. No board mine or no score, no bar: a bar with an invented denominator is worse than none (#90).
 */
function progressFor(
  onBoard: Mine | undefined,
  state: MineCardState
): TierProgressOptions | undefined {
  if (state === 'measuring') return { measuring: true }
  const score = onBoard?.score
  if (onBoard === undefined || score === undefined) return undefined
  const value = Math.round(score.kb)
  if (score.nextTierKb === null) return { maxTier: true, value }
  const nextTier = MINE_TIERS[MINE_TIERS.indexOf(onBoard.tier) + 1]
  return { value, max: score.nextTierKb, ...(nextTier === undefined ? {} : { nextTier }) }
}

/*
 * Why a mine cannot be entered, and the one reason there is (PANEL-QUESTIONS 6, design lead ruling
 * 2026-09-27): its folder no longer exists (`folderMissing`, which main asks the disk).
 */
export const MINE_UNENTERABLE_REASON = 'Folder not found. It was moved or deleted.'

/** The toast a press on a mine that cannot be entered raises: "<name>: <reason>". */
export function mineRefusalToast(name: string): string {
  return name + ': ' + MINE_UNENTERABLE_REASON
}

export function mineCardView(row: BrowseRow, mines: readonly Mine[]): MineCardView {
  const onBoard = mines.find((mine) => mine.id === row.id)
  // Measuring is the Host's `MineWire.state` (US-MINES-008.AC03, AC04), which the board carries.
  const state: MineCardState = row.folderMissing
    ? 'unenterable'
    : row.unrecorded
      ? 'unrecorded'
      : onBoard?.measuring === true
        ? 'measuring'
        : 'active'
  // Not live: nobody is working it, which the board can say. Live but not on the board yet: the
  // board is a poll behind, and a count it does not have is not a count of zero.
  const crew = !row.live ? crewPills([]) : onBoard ? crewPills(onBoard.dwarfs) : []
  const needsCount = onBoard
    ? onBoard.dwarfs.filter((dwarf) => sceneDwarfStatus(dwarf) === 'asking').length
    : 0
  return {
    id: row.id,
    name: row.name,
    tier: cardTierFor(row) ?? MINE_TIERS[0]!,
    measured: cardTierFor(row) !== undefined,
    state,
    // The ore is the board's `MineWire.totals`, per material and never summed (INV-93); a list row carries none.
    ore: vaultRows(onBoard?.materials ?? row.materials).map(({ material, units }) => ({
      material,
      units
    })),
    crew,
    needs: needsCount > 0,
    needsCount,
    progress:
      state === 'unrecorded' || state === 'unenterable' ? undefined : progressFor(onBoard, state),
    // Only a missing folder refuses entry (PANEL-QUESTIONS 5 and 6, design lead ruling 2026-09-27):
    // a remembered mine nobody is working opens too, onto the empty roster and + Dwarf.
    enterable: state !== 'unenterable',
    ...(state === 'unenterable' ? { reason: MINE_UNENTERABLE_REASON } : {}),
    removable: row.unrecorded !== true,
    ...(onBoard?.score === undefined ? {} : { score: onBoard.score.kb })
  }
}

/** The card button's name: "Open <name>, <tier>", and ", not enterable" when it cannot be. */
export function mineCardLabel(view: MineCardView): string {
  return (
    'Open ' +
    view.name +
    ', ' +
    designTierLabel(view.tier) +
    (view.state === 'unenterable' ? ', not enterable' : '')
  )
}

/**
 * The ⋯ menu: Remove mine…, which confirms. The design's "Fold worktrees" is left out: the app
 * already folds every worktree into its project's mine (#348), so the item would have nothing to
 * do, and the nav rule is that nothing points at an action that does not exist.
 */
export function mineCardMenu(view: MineCardView): MenuItem[] {
  return [{ label: 'Remove mine…', danger: true, ...(view.removable ? {} : { disabled: true }) }]
}
