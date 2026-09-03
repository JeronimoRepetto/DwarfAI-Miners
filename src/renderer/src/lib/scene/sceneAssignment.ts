/**
 * Which dwarf stands where in the mine.
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
  clampToPainting,
  type SceneAnchor,
  type SceneAnchorKind,
  type SceneLayout,
  type ScenePoint
} from './sceneLayout'

/**
 * How far apart two dwarfs sharing one workstation stand, in image percent.
 *
 * Sized off the design rather than by eye: the sprite sheet's frame is 36px and
 * the design draws it at 1x inside a 245px interior, so a whole frame is 14.7%
 * of the painting's width. Ten percent puts a sharing pair about two thirds of
 * a frame apart — overlapping at the transparent edges, which is what two
 * miners at one vein look like, and not the same silhouette drawn twice.
 */
export const SHARE_SPREAD_X = 10

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
 *
 * A waiting dwarf no longer goes anywhere. The cave had a painted rest area and
 * sent him to it; the design's spatial map has no such class — it draws spawn
 * circles, worker triangles and foreman diamonds, and nothing else a dwarf
 * stands on. So resting happens where the work is, which is also what the
 * sleeping frames draw: a dwarf asleep at his post, not one who walked away
 * from it (#137).
 */
export function anchorKindFor(status: DwarfStatus, role: DwarfRole): SceneAnchorKind {
  /*
   * A spawn point is where a dwarf enters, so it is also where one leaves.
   * The design marks three of them and they are NOT all at the entrance — one
   * near the top of the shaft, one on the left mid-way down, one at the pool at
   * the bottom — so "leaving" means heading for the nearest way out rather than
   * trooping down to a single door.
   */
  if (status === 'leaving') return 'spawn'
  // The foreman does not dig — he has his own spot and his own frames.
  return role === 'foreman' ? 'foreman' : 'worker'
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
          point: sharedPoint(anchor, shareIndex, sorted.length),
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
 * the workstation, so it stays the centre of attention however many dwarfs
 * crowd onto it, and a lone dwarf lands exactly on it.
 */
function sharedPoint(anchor: SceneAnchor, shareIndex: number, shareCount: number): ScenePoint {
  const offset = (shareIndex - (shareCount - 1) / 2) * SHARE_SPREAD_X
  return clampToPainting({ x: anchor.x + offset, y: anchor.y })
}
