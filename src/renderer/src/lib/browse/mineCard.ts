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
 * provisional bronze, for drawing only — it never reaches anything that records a decision. The
 * progress bar, the ore and the crew claim only what was measured or seen: no weight, no bar; no
 * ledger row, no capsules; a live mine the board has not caught up with, no pills at all.
 *
 * Units are per material and never summed or converted (vault.ts).
 */
import { vaultRows } from '../vault/vault'
import { designTierLabel } from '../presentation'
import { dwarfNeedsYou } from '../shell/panelNav'
import type { TierProgressOptions } from './tierProgress'
import { cardTierFor, isMeasuring, nextLevelFor } from './browseCards'
import type { PillTone } from '../dwarf/badge'
import type { MenuItem } from '../overlay/menu'
import { MINE_TIERS, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'
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
 * The crew line: "N working", "N needs you", "N asleep", each only when non-zero; "No dwarfs" for
 * no crew; one "idle", with no count, when nobody is working, asking or asleep (components.md,
 * Mine card, As built). Asleep is a session at rest that asked nobody anything.
 */
export function crewPills(dwarfs: readonly Dwarf[]): CrewPill[] {
  if (dwarfs.length === 0) return [{ text: 'No dwarfs' }]
  let working = 0
  let needs = 0
  let asleep = 0
  for (const dwarf of dwarfs) {
    if (dwarfNeedsYou(dwarf)) needs++
    else if (dwarf.status === 'working') working++
    else if (dwarf.status === 'waiting') asleep++
  }
  const pills: CrewPill[] = []
  if (working) pills.push({ text: working + ' working' })
  if (needs) pills.push({ text: needs + ' needs you', tone: 'needs', ask: true })
  if (asleep) pills.push({ text: asleep + ' asleep' })
  return pills.length ? pills : [{ text: 'idle' }]
}

// The tier whose floor a boundary is, so the bar is filled in the colour of the tier it leads to.
function tierAtFloor(floorKb: number): MineTier | undefined {
  const { copperKb, silverKb, goldKb, uraniumKb } = TIER_WEIGHT_THRESHOLDS_KB
  const floors: Record<number, MineTier> = {
    [copperKb]: 'copper',
    [silverKb]: 'silver',
    [goldKb]: 'gold',
    [uraniumKb]: 'uranium'
  }
  return floors[floorKb]
}

function progressFor(row: BrowseRow, state: MineCardState): TierProgressOptions | undefined {
  if (state === 'measuring') return { measuring: true }
  const level = nextLevelFor(row.weightBytes)
  if (level === undefined) return undefined
  if (level.nextBoundaryKb === undefined) return { maxTier: true, value: level.currentKb }
  const nextTier = tierAtFloor(level.nextBoundaryKb)
  return {
    value: level.currentKb,
    max: level.nextBoundaryKb,
    ...(nextTier === undefined ? {} : { nextTier })
  }
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
  const state: MineCardState = row.folderMissing
    ? 'unenterable'
    : row.unrecorded
      ? 'unrecorded'
      : isMeasuring(row)
        ? 'measuring'
        : 'active'
  const onBoard = mines.find((mine) => mine.id === row.id)
  // Not live: nobody is working it, which the board can say. Live but not on the board yet: the
  // board is a poll behind, and a count it does not have is not a count of zero.
  const crew = !row.live ? crewPills([]) : onBoard ? crewPills(onBoard.dwarfs) : []
  const needsCount = onBoard ? onBoard.dwarfs.filter(dwarfNeedsYou).length : 0
  return {
    id: row.id,
    name: row.name,
    tier: cardTierFor(row) ?? MINE_TIERS[0]!,
    measured: cardTierFor(row) !== undefined,
    state,
    ore: vaultRows(row.materials).map(({ material, units }) => ({ material, units })),
    crew,
    needs: needsCount > 0,
    needsCount,
    progress:
      state === 'unrecorded' || state === 'unenterable' ? undefined : progressFor(row, state),
    // Only a mine on the board can be entered (#85): opening one nobody is working opens nothing.
    enterable: row.live && state !== 'unenterable',
    ...(state === 'unenterable' ? { reason: MINE_UNENTERABLE_REASON } : {}),
    removable: row.unrecorded !== true,
    ...(row.weightBytes === undefined ? {} : { score: row.weightBytes / 1024 })
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
