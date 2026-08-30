/**
 * Which dwarf stands where in the cave.
 *
 * The panel re-polls every couple of seconds and is handed a brand new dwarf
 * list each time, in whatever order the providers produced it. So placement has
 * to be a pure function of the dwarf ids: anything else — insertion order, a
 * counter, a random pick — makes a dwarf teleport across the gallery between
 * two polls that reported exactly the same crew.
 *
 * That is the same problem `assignSlots` already solves for mines on the map,
 * so this module reuses it rather than growing a second solver: hash each id to
 * a preferred slot, let uncontested holders keep theirs, probe forward in
 * sorted-id order for the rest, and let the overflow share a slot when there
 * are more dwarfs than places. Only the "what happens after two dwarfs land on
 * one rock" part is new, and it lives here.
 */
import type { DwarfRole, DwarfStatus } from '../../types'
import { assignSlots } from '../placement'
import {
  anchorPool,
  clampToBand,
  type SceneAnchor,
  type SceneAnchorKind,
  type SceneLayout,
  type ScenePoint
} from './sceneLayout'

/**
 * How far apart two dwarfs sharing one anchor stand, in image percent.
 *
 * Sized so a shared work spot still reads as two miners at one rock rather than
 * one sprite drawn twice. `sceneLayout.test.ts` holds the authored anchors to
 * half this much clearance from the rock wall, so a sharing pair is never
 * squeezed into the stone.
 */
export const SHARE_SPREAD_X = 9

/** The slice of a dwarf placement cares about. */
export interface SceneOccupant {
  id: string
  status: DwarfStatus
  role: DwarfRole
}

export interface ScenePlacement {
  anchor: SceneAnchor
  /** Where the dwarf actually stands: the anchor, nudged sideways when shared. */
  point: ScenePoint
  /** This dwarf's index among those sharing the anchor, in sorted-id order. */
  shareIndex: number
  /** How many dwarfs are on this anchor. 1 means it has the feature to itself. */
  shareCount: number
  facesLeft: boolean
}

/**
 * Which kind of place a dwarf in this state belongs at.
 *
 * Straight off the existing status model, which is the point: no new state to
 * keep in sync, the scene simply reads what the providers already report.
 */
export function anchorKindFor(status: DwarfStatus, role: DwarfRole): SceneAnchorKind {
  if (status === 'leaving') return 'exit'
  if (status === 'waiting') return 'rest'
  // The foreman does not dig — he has his own spot and his own frames.
  return role === 'foreman' ? 'post' : 'vein'
}

/**
 * Place a whole crew. Each kind is solved independently, so a foreman arriving
 * or a dwarf walking out can never shuffle the miners still at the rock face.
 */
export function assignScene(
  occupants: readonly SceneOccupant[],
  layout: SceneLayout
): Map<string, ScenePlacement> {
  const placements = new Map<string, ScenePlacement>()

  const idsByKind = new Map<SceneAnchorKind, string[]>()
  for (const occupant of occupants) {
    const kind = anchorKindFor(occupant.status, occupant.role)
    idsByKind.set(kind, [...(idsByKind.get(kind) ?? []), occupant.id])
  }

  for (const [kind, ids] of idsByKind) {
    // A re-authored interior that dropped a kind still has to put the dwarf
    // somewhere on its floor: an unplaced dwarf would simply not be drawn.
    const pool = anchorPool(layout, kind)
    const slots = assignSlots(ids, pool.length)

    const sharersBySlot = new Map<number, string[]>()
    for (const id of ids) {
      const slot = slots.get(id) ?? 0
      sharersBySlot.set(slot, [...(sharersBySlot.get(slot) ?? []), id])
    }

    for (const [slot, sharers] of sharersBySlot) {
      const anchor = pool[slot] ?? pool[0]
      // Sorted so a dwarf's side of a shared rock is stable across polls too,
      // not just which rock it went to.
      const sorted = [...sharers].sort()
      for (const [shareIndex, id] of sorted.entries()) {
        placements.set(id, {
          anchor,
          point: sharedPoint(layout, anchor, shareIndex, sorted.length),
          shareIndex,
          shareCount: sorted.length,
          facesLeft: anchor.facesLeft
        })
      }
    }
  }

  return placements
}

/**
 * Where one of several sharers stands: the group is spread symmetrically about
 * the anchor, so the feature stays the centre of attention however many dwarfs
 * crowd onto it, and a lone dwarf lands exactly on it.
 */
function sharedPoint(
  layout: SceneLayout,
  anchor: SceneAnchor,
  shareIndex: number,
  shareCount: number
): ScenePoint {
  const offset = (shareIndex - (shareCount - 1) / 2) * SHARE_SPREAD_X
  return clampToBand(layout.band, { x: anchor.x + offset, y: anchor.y })
}
