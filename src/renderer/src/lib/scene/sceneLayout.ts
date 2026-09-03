/**
 * The mine interior as places a dwarf can be: which workstation is which, and
 * which way a dwarf standing on one faces.
 *
 * This is the interior's answer to `mapSites.ts`, and since #137 it authors
 * nothing itself. Every point comes from `interiorMap.ts` — the design's own
 * work-point overlay, re-anchored onto the production painting — so a
 * workstation is where the designer drew a blue triangle rather than where
 * somebody read a percent grid. What is left here is the small amount of
 * meaning the extraction has no way to carry: which classes a dwarf may
 * occupy, which way it faces, and what order the scene paints them in.
 *
 * ## The coordinate space
 *
 * Percentages of the PAINTING, not of the rendered box — see
 * `.claude/rules/coordinates.md` and `sceneGeometry.ts`. The interior is a
 * 1184 x 3622 tower drawn into a 245px column, so a box-percent point would sit
 * on a different gallery at every column height.
 *
 * ## The five tiers
 *
 * `screens/mine.md`: "Each interior variant shares the same symmetric logical
 * map; only the visual style changes" — confirmed by the extraction rather than
 * assumed, since all five panels produced identical per-class marker counts. So
 * one layout serves all five, and `SCENE_LAYOUTS` stays keyed by tier only so a
 * future repaint of a single interior can diverge without touching a caller.
 */
import type { MineTier } from '../../types'
import { INTERIOR_STATIONS, type InteriorPoint } from './interiorMap'
import { paintingDistance } from './interiorRoute'

/** A point on the painting, in percent of the painting's own canvas. */
export type ScenePoint = InteriorPoint

/**
 * The classes of workstation a DWARF occupies.
 *
 * A subset of what the design's spatial map draws: ladders and ramps are in
 * `interiorMap` too, but they are corridor features the route already runs
 * through, not places anyone stands. Spawn doubles as the way out — the
 * entrance is the exit, which is one fewer fiction than the cave's separate
 * "exit passage" was.
 */
export type SceneAnchorKind = 'spawn' | 'worker' | 'foreman'

/** Every kind, so a layout can be checked for gaps rather than trusted. */
export const SCENE_ANCHOR_KINDS: readonly SceneAnchorKind[] = ['spawn', 'worker', 'foreman']

/** One extracted workstation, at the dwarf's feet. */
export interface SceneAnchor extends ScenePoint {
  id: string
  kind: SceneAnchorKind
  /**
   * Whether a dwarf parked here faces left — the facing itself, never the
   * mirror. The sheets are painted facing LEFT (#156), so it is a dwarf facing
   * RIGHT that DwarfSprite mirrors.
   *
   * READ from the map, never decided here (#153). It used to be derived — "a
   * dwarf faces the middle of the shaft, so one on the right-hand wall turns to
   * face it" — and the maintainer's acceptance run found that wrong for thirteen
   * of the eighteen worker stations: a dwarf faces the WALL it is picking, and
   * which wall that is depends on the rock, not on which half of the painting
   * the station sits in. They then authored an arrow on every workstation across
   * all five tier panels, and `interiorMap.ts` carries the transcription.
   */
  facesLeft: boolean
}

export interface SceneLayout {
  /** In the extraction's own order — see the ordering note on the constant. */
  anchors: readonly [SceneAnchor, ...SceneAnchor[]]
}

const OCCUPIABLE = new Set<string>(SCENE_ANCHOR_KINDS)

/**
 * The workstations, in the order `interiorMap` carries them.
 *
 * The order is load-bearing exactly as `MINE_SITES`' is: an anchor's INDEX
 * within its kind is the stable identity `assignSlots` hashes a dwarf id onto,
 * so re-ordering this list moves every dwarf in every mine. It is not sorted
 * here for that reason — the scene sorts its own painting order by depth, which
 * is a separate question with a separate answer.
 */
const [FIRST_ANCHOR, ...REST_ANCHORS] = INTERIOR_STATIONS.filter((station) =>
  OCCUPIABLE.has(station.kind)
).map<SceneAnchor>((station) => ({
  id: station.id,
  kind: station.kind as SceneAnchorKind,
  x: station.x,
  y: station.y,
  facesLeft: station.facesLeft
}))
if (!FIRST_ANCHOR) throw new Error('the interior map carries no workstation a dwarf can occupy')
const INTERIOR_ANCHORS: readonly [SceneAnchor, ...SceneAnchor[]] = [FIRST_ANCHOR, ...REST_ANCHORS]

/** The one extracted interior, shared by all five redressed tier paintings. */
export const INTERIOR_LAYOUT: SceneLayout = { anchors: INTERIOR_ANCHORS }

/** Per-tier layouts, so one interior can be re-authored without touching callers. */
export const SCENE_LAYOUTS: Record<MineTier, SceneLayout> = {
  bronze: INTERIOR_LAYOUT,
  copper: INTERIOR_LAYOUT,
  silver: INTERIOR_LAYOUT,
  gold: INTERIOR_LAYOUT,
  uranium: INTERIOR_LAYOUT
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
 * A re-extracted interior that dropped a kind still has to put its dwarfs
 * somewhere, so the whole anchor list stands in. Returning a non-empty tuple is
 * what lets callers index without a runtime guard: an interior with no
 * workstations at all is a data bug, not a state the renderer has to survive.
 */
export function anchorPool(
  layout: SceneLayout,
  kind: SceneAnchorKind
): readonly [SceneAnchor, ...SceneAnchor[]] {
  const [first, ...rest] = anchorsOfKind(layout, kind)
  return first ? [first, ...rest] : layout.anchors
}

/**
 * The spawn point a dwarf arriving for this station comes in at (#153).
 *
 * The nearest one, in PAINTING PIXELS — the interior is three times taller than
 * it is wide, so a percent-space hypotenuse would send a dwarf working the top
 * gallery in through the entrance pool at the bottom because it happens to be
 * closer in y. Distances are the corridor module's, for exactly that reason.
 *
 * The design does not say which of the three entrances an agent uses; it says
 * only that a launched worker "appears at an available spawn point". Nearest is
 * the reading that makes the walk mean something — a dwarf coming in for the
 * ceiling gallery uses the top entrance, not a trek up the whole tower.
 */
export function nearestSpawn(layout: SceneLayout, point: ScenePoint): SceneAnchor {
  const spawns = anchorPool(layout, 'spawn')
  let best = spawns[0]
  let bestSpan = paintingDistance(point, best)
  for (const spawn of spawns) {
    const span = paintingDistance(point, spawn)
    if (span >= bestSpan) continue
    best = spawn
    bestSpan = span
  }
  return best
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Hold a point on the painting.
 *
 * The cave had a walkable trapezoid to clamp into; this interior has no such
 * thing, because it is not one floor seen in perspective but a tower of
 * galleries whose walkable ground is the route network itself. The only
 * universal bound left is the canvas, and the only thing that goes outside it
 * is a sharing offset pushed off the edge.
 */
export function clampToPainting(point: ScenePoint): ScenePoint {
  return { x: clamp(point.x, 0, 100), y: clamp(point.y, 0, 100) }
}

/** The z-index band the scene paints into. Modals own 90-100, so depth stays low. */
const DEPTH_Z_MIN = 10
const DEPTH_Z_MAX = 40

/**
 * Painting order for one height in the painting: lower on the art paints over
 * higher, because the interior is drawn isometrically and a dwarf on the
 * gallery below is nearer the viewer.
 *
 * Deliberately confined to a low band — App.vue's overlay and FeedModal already
 * claim 90-100, and a dwarf must never paint over a dialog.
 */
export function depthOrder(y: number): number {
  const t = clamp(y, 0, 100) / 100
  return Math.round(DEPTH_Z_MIN + (DEPTH_Z_MAX - DEPTH_Z_MIN) * t)
}
