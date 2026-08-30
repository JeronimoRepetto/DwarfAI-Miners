/**
 * The cave interior as data: where the floor is, and which painted features a
 * dwarf can go and stand on.
 *
 * This is the interior's answer to `mapSites.ts`. Every anchor below is a real
 * thing in the painting — an ore shelf, the pick someone left leaning on a
 * rock, the lit passage at the back — rather than an arbitrary point on an
 * invisible line, so a dwarf reads as being *somewhere* in the cave instead of
 * hovering in front of a backdrop.
 *
 * ## The coordinate space
 *
 * Coordinates are percentages of the **painting**, not of the rendered box.
 * `sceneGeometry.ts` carries the long version of why; the short version is that
 * the art is tall portrait (1289 x 1600) shown in a squarer resizable panel
 * with `object-fit: cover; object-position: 50% 100%`, so the visible window is
 * always the bottom of the art and its height swings with the panel's shape.
 * Authoring against the painting and projecting at render time is what keeps an
 * anchor glued to the rock it names when the user drags the panel wider.
 *
 * ## The floor
 *
 * `WalkableBand` is the trapezoid of floor a dwarf may occupy: it runs from the
 * passage mouth at the back (`farY`, narrow — the tunnel is narrow) to the lip
 * of the foreground boulders at the front (`nearY`, wide). Below `nearY` the
 * painting is a dark out-of-focus rock ridge we look over, not ground; above
 * `farY` the floor has turned into the far tunnel. Both edges were read off a
 * percent grid laid over the art.
 *
 * ## The five tiers
 *
 * The five interiors are one painting redressed per tier: identical rock,
 * timber, beams and tunnel, with only the ore recoloured (amber, teal, white,
 * gold, green). They therefore share one authored layout. `SCENE_LAYOUTS` is
 * still keyed by tier so a future repaint of a single interior can diverge
 * without touching a single caller.
 */
import type { MineTier } from '../../types'

/** A point on the painting, in percent of the painting's own canvas. */
export interface ScenePoint {
  x: number
  y: number
}

/**
 * What a dwarf does at an anchor. The kinds map onto the existing status model
 * (`working` / `waiting` / `leaving`) plus the foreman, who does not dig.
 */
export type SceneAnchorKind = 'vein' | 'rest' | 'post' | 'exit' | 'deposit'

/** Every kind, so a layout can be checked for gaps rather than trusted. */
export const SCENE_ANCHOR_KINDS: readonly SceneAnchorKind[] = [
  'vein',
  'rest',
  'post',
  'exit',
  'deposit'
]

/** One authored place in the painting, at the dwarf's feet. */
export interface SceneAnchor extends ScenePoint {
  id: string
  kind: SceneAnchorKind
  /**
   * Names the painted feature this sits on, so a coordinate edit can be
   * sanity-checked against the art instead of nudged until it looks fine.
   */
  feature: string
  /**
   * Whether a dwarf parked here faces left. The art is painted facing right,
   * so this is what turns a miner to face the rock he is actually swinging at.
   */
  facesLeft: boolean
}

/**
 * The floor, as a trapezoid narrowing toward the back of the gallery, plus the
 * perspective scale a dwarf takes at each depth.
 */
export interface WalkableBand {
  /** The back edge of the floor: the mouth of the passage. */
  farY: number
  /** The front edge: the lip of the foreground boulders. */
  nearY: number
  /** The centre line the floor narrows toward. */
  centerX: number
  farHalfWidth: number
  nearHalfWidth: number
  /** Sprite scale at each edge, so a dwarf at the back is visibly farther away. */
  farScale: number
  nearScale: number
}

export interface SceneLayout {
  band: WalkableBand
  /** Ordered far to near (y ascending) — see the ordering note on the constant. */
  anchors: readonly [SceneAnchor, ...SceneAnchor[]]
}

/**
 * The floor of the gallery.
 *
 * Read off a percent grid over the art: open ground runs from the lit passage
 * mouth at image y 66 back to the foreground boulder lip at y 86, spanning
 * roughly x 36-64 at the back where the tunnel pinches and x 6-94 at the front.
 */
const CAVE_BAND: WalkableBand = {
  farY: 66,
  nearY: 86,
  centerX: 50,
  farHalfWidth: 14,
  nearHalfWidth: 44,
  farScale: 0.74,
  nearScale: 1.06
}

/**
 * The authored anchors, ordered far to near (y ascending).
 *
 * The order is load-bearing twice, exactly as `MINE_SITES` is: the scene paints
 * in this order so a nearer dwarf overlaps a farther one, and anchor *index*
 * within a kind is the stable identity slot assignment hashes onto — inserting
 * one in the middle reshuffles who stands where, so append or re-author
 * deliberately.
 */
const CAVE_ANCHORS: readonly [SceneAnchor, ...SceneAnchor[]] = [
  {
    id: 'exit-passage',
    kind: 'exit',
    x: 50,
    y: 67,
    facesLeft: false,
    feature: 'the lit passage mouth at the centre of the gallery, the way back up'
  },
  {
    id: 'vein-passage-left',
    kind: 'vein',
    x: 36,
    y: 70,
    facesLeft: true,
    feature: 'the ore rubble heaped against the left timber post of the passage'
  },
  {
    id: 'vein-passage-right',
    kind: 'vein',
    x: 64,
    y: 70,
    facesLeft: false,
    feature: 'the ore rubble heaped against the right timber post of the passage'
  },
  {
    id: 'vein-left-shelf',
    kind: 'vein',
    x: 21,
    y: 79,
    facesLeft: true,
    feature: 'the broad ore shelf banked against the left wall'
  },
  {
    id: 'vein-pick-outcrop',
    kind: 'vein',
    x: 79,
    y: 79,
    facesLeft: false,
    feature: 'the right-hand outcrop where a miner left his pick leaning on the rock'
  },
  {
    id: 'post-crossbeam-lantern',
    kind: 'post',
    x: 48,
    y: 80,
    facesLeft: false,
    feature: 'the open gallery floor under the lantern hung from the crossbeam'
  },
  {
    id: 'rest-left-boulder',
    kind: 'rest',
    x: 28,
    y: 85,
    facesLeft: false,
    feature: 'the foreground boulder on the left, low enough to sit against'
  },
  {
    id: 'rest-right-boulder',
    kind: 'rest',
    x: 72,
    y: 85,
    facesLeft: true,
    feature: 'the foreground boulder on the right, beside the fallen timber'
  },
  {
    /*
     * Deliberately past nearY, on the foreground rock rather than on the floor.
     * A deposit is the one anchor kind no dwarf stands on, so the walkable band
     * does not bind it — and keeping it on the floor put the heap among the
     * crew, where it buried a miner from the knees up. Down here it reads as
     * ore stacked at the mine's near lip, and being the nearest thing in the
     * scene it paints in front of everyone, which is where it belongs.
     *
     * Right in the corner, and unlike every other anchor it is allowed to be
     * cropped there. A dwarf clipped by a narrow panel's cover crop gets held
     * at the panel edge by clampToBox, which puts him somewhere he is not
     * standing on anything — a bug. A heap of ore held at the panel edge is
     * exactly where a corner heap belongs, so the crop doing that is the
     * desired outcome rather than a failure to avoid.
     *
     * Last anchor in the list because the array is ordered far to near.
     */
    id: 'deposit-near-left-rock',
    kind: 'deposit',
    x: 4,
    y: 97,
    facesLeft: false,
    feature: 'the foreground rock in the near left corner, below the boulder lip'
  }
]

/** The one authored interior, shared by all five redressed tier paintings. */
export const CAVE_LAYOUT: SceneLayout = { band: CAVE_BAND, anchors: CAVE_ANCHORS }

/** Per-tier layouts, so one interior can be re-authored without touching callers. */
export const SCENE_LAYOUTS: Record<MineTier, SceneLayout> = {
  bronze: CAVE_LAYOUT,
  copper: CAVE_LAYOUT,
  silver: CAVE_LAYOUT,
  gold: CAVE_LAYOUT,
  uranium: CAVE_LAYOUT
}

export function sceneLayout(tier: MineTier): SceneLayout {
  return SCENE_LAYOUTS[tier]
}

export function anchorsOfKind(layout: SceneLayout, kind: SceneAnchorKind): readonly SceneAnchor[] {
  return layout.anchors.filter((anchor) => anchor.kind === kind)
}

/**
 * The anchors of one kind, guaranteed non-empty.
 *
 * A re-authored interior that dropped a kind still has to put its dwarfs — or
 * its ore pile — somewhere on its floor, so the whole anchor list stands in.
 * Returning a non-empty tuple is what lets callers index without a runtime
 * guard: an interior with no anchors at all is an authoring bug, not a state
 * the renderer has to survive.
 */
export function anchorPool(
  layout: SceneLayout,
  kind: SceneAnchorKind
): readonly [SceneAnchor, ...SceneAnchor[]] {
  const [first, ...rest] = anchorsOfKind(layout, kind)
  return first ? [first, ...rest] : layout.anchors
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** How far along the floor, front to back, a depth sits. 0 at the back, 1 at the front. */
function depthFraction(band: WalkableBand, y: number): number {
  const span = band.nearY - band.farY
  if (span <= 0) return 0
  return clamp((y - band.farY) / span, 0, 1)
}

/**
 * Half the width of the floor at one depth. Clamps rather than extrapolating
 * past either edge: beyond the band there is no floor to widen onto.
 */
export function walkableHalfWidth(band: WalkableBand, y: number): number {
  const t = depthFraction(band, y)
  return band.farHalfWidth + (band.nearHalfWidth - band.farHalfWidth) * t
}

/** Whether a point is on the floor — inside the band, and inside it at that depth. */
export function isWalkable(band: WalkableBand, point: ScenePoint): boolean {
  if (point.y < band.farY || point.y > band.nearY) return false
  const halfWidth = walkableHalfWidth(band, point.y)
  return Math.abs(point.x - band.centerX) <= halfWidth
}

/** Pull a point onto the floor, keeping its depth and moving it in from the wall. */
export function clampToBand(band: WalkableBand, point: ScenePoint): ScenePoint {
  const y = clamp(point.y, band.farY, band.nearY)
  const halfWidth = walkableHalfWidth(band, y)
  return { x: clamp(point.x, band.centerX - halfWidth, band.centerX + halfWidth), y }
}

/**
 * Sprite scale at a depth. The gallery is painted in perspective, so a dwarf
 * at the passage mouth has to be smaller than one on the foreground floor or
 * the illusion collapses — the same reasoning as `MineSite.scale` on the map.
 */
export function depthScale(band: WalkableBand, y: number): number {
  const t = depthFraction(band, y)
  return band.farScale + (band.nearScale - band.farScale) * t
}

/** The z-index band the scene paints into. Modals own 90-100, so depth stays low. */
const DEPTH_Z_MIN = 10
const DEPTH_Z_MAX = 40

/**
 * Painting order for one depth: nearer overlaps farther. Deliberately confined
 * to a low band — App.vue's overlay, MineMound and FeedModal already claim
 * 90-100, and a dwarf must never paint over a dialog.
 */
export function depthOrder(band: WalkableBand, y: number): number {
  const t = depthFraction(band, y)
  return Math.round(DEPTH_Z_MIN + (DEPTH_Z_MAX - DEPTH_Z_MIN) * t)
}
