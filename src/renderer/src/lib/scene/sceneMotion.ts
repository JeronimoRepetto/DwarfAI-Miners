/**
 * Getting a dwarf from where it is to where it belongs.
 *
 * `sceneAssignment.ts` answers *where* each dwarf should stand; this answers
 * *how it gets there*. The move itself is a CSS transition on the sprite's
 * `left`/`bottom` — deliberately not a transform, because a transform on an
 * ancestor becomes the containing block for `position: fixed` descendants and
 * DwarfSprite's tooltip, action bar and expanded bubble are all fixed and
 * clamped to the viewport. Animating the offsets keeps those popovers landing
 * where `computeTooltipPlacement` put them.
 *
 * What is left for this module is the bookkeeping CSS cannot do: how long a
 * given crossing should take, which way the sprite should face while making it,
 * and — the part that actually needs state — *which dwarfs are mid-walk right
 * now*, so the sprite can play the walk cycle instead of swinging a pick at
 * thin air on its way to the rock.
 */
import { INTERIOR_PAINTING_SIZE } from './interiorMap'
import { paintingDistance, polylineLength } from './interiorRoute'
import type { ScenePoint } from './sceneLayout'

const PAINTING_WIDTH = INTERIOR_PAINTING_SIZE.width

/**
 * How fast a dwarf walks, in pixels of the PAINTING per second.
 *
 * Painting pixels rather than image percent, because the interior is three
 * times taller than it is wide and a percent of height is three times a percent
 * of width: a speed in percent would have dwarfs sprinting up ladders and
 * dawdling along galleries. At the design's 245px column the painting is drawn
 * at 0.207x, so 300 here is about 62 screen pixels a second — a quarter of the
 * column's width, which reads as walking rather than sliding.
 */
export const WALK_SPEED_PX_PER_SEC = 300

/** A twitch shorter than this reads as a glitch, not a step. */
export const MIN_WALK_MS = 240

/**
 * The longest a single journey may take.
 *
 * Much longer than the cave's 3.2 seconds, and it has to be: the full height of
 * this painting is 3622 pixels, so a dwarf summoned from the entrance to the
 * ceiling gallery has a genuinely long climb, and hurrying it to fit an old
 * ceiling would have him skating up the ladders.
 */
export const MAX_WALK_MS = 12_000

/**
 * Two points closer together than this are the same spot, in painting pixels.
 *
 * Guards the whole module against floating-point noise in the share offsets
 * restarting a walk, and against a re-poll that reports identical coordinates
 * twitching the sprite. Six painting pixels is about one screen pixel at the
 * design's column width — below anything a viewer could see move.
 */
export const ARRIVAL_EPSILON_PX = 6

/** How long this crossing should take. Zero when there is nowhere to go. */
export function walkDurationMs(from: ScenePoint, to: ScenePoint): number {
  return pathDurationMs([from, to])
}

/**
 * How long a whole route should take, walked end to end.
 *
 * The clamps are on the JOURNEY and not on each leg of it, which is the point:
 * an extracted corridor is a polyline of many short segments, and flooring each
 * of those at `MIN_WALK_MS` would have a dwarf crawling round every corner.
 */
export function pathDurationMs(path: readonly ScenePoint[]): number {
  const span = polylineLength(path)
  if (span < ARRIVAL_EPSILON_PX) return 0
  const raw = (span / WALK_SPEED_PX_PER_SEC) * 1000
  return Math.min(Math.max(raw, MIN_WALK_MS), MAX_WALK_MS)
}

/** One step of a route: where it ends, and how long the sprite takes to cross it. */
export interface WalkLeg {
  point: ScenePoint
  durationMs: number
}

/**
 * A route, cut into the legs a sprite is animated along.
 *
 * Each leg takes its own share of the journey's clamped duration, so the dwarf
 * moves at one steady pace all the way rather than pausing at every corner.
 */
export function pathLegs(path: readonly ScenePoint[]): readonly WalkLeg[] {
  const total = polylineLength(path)
  const journeyMs = pathDurationMs(path)
  if (path.length < 2 || total <= 0 || journeyMs === 0) return []
  const legs: WalkLeg[] = []
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1] as ScenePoint
    const to = path[index] as ScenePoint
    legs.push({ point: to, durationMs: journeyMs * (paintingDistance(from, to) / total) })
  }
  return legs
}

/**
 * Which way a walking dwarf faces: where it is going — and, once it has arrived
 * and there is no travel direction left to read, whatever its anchor faces.
 *
 * The facing itself, never the mirror. The sheets are painted facing LEFT
 * (#156), so DwarfSprite mirrors the ones this answers `false` for.
 */
export function walkFacesLeft(from: ScenePoint, to: ScenePoint, parkedFacesLeft: boolean): boolean {
  const dx = ((to.x - from.x) / 100) * PAINTING_WIDTH
  if (Math.abs(dx) < ARRIVAL_EPSILON_PX) return parkedFacesLeft
  return dx < 0
}

/** The one query every reduced-motion site in the app asks. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * The narrow slice of a media query list this module uses. Listening is
 * optional because answering is the part every platform manages: one that can
 * report the preference but not its changing still gives a correct first
 * answer, which is all the app had before it started watching.
 */
export interface ReducedMotionQuery {
  matches: boolean
  addEventListener?: (type: 'change', listener: () => void) => void
  removeEventListener?: (type: 'change', listener: () => void) => void
}

/** The narrow slice of `window` the reduced-motion query needs. */
export interface MediaQueryView {
  matchMedia?: (query: string) => ReducedMotionQuery
}

/**
 * Whether the viewer asked for less movement, in which case the scene falls
 * back to placing everyone statically instead of walking them around.
 *
 * Takes the view explicitly so it is testable without a DOM, and tolerates its
 * absence: `matchMedia` is missing in the test environment and during the very
 * first render, and neither is a reason to refuse to draw the cave.
 */
export function prefersReducedMotion(
  view: MediaQueryView | undefined = globalThis.window
): boolean {
  if (!view || typeof view.matchMedia !== 'function') return false
  return view.matchMedia(REDUCED_MOTION_QUERY).matches === true
}

/**
 * The same preference, watched rather than sampled: `onChange` fires whenever
 * the viewer's answer changes, and the returned function stops it.
 *
 * Sampling once is enough for anything settled before the first paint, which is
 * what MineScene does with it. It is not enough for the sprite's frame timer
 * (issue #71): a viewer who turns the setting on with the panel already open
 * would otherwise keep a dwarf changing pose 109 times a minute until they
 * relaunched the app.
 *
 * Tolerates every absence `prefersReducedMotion` does and one more — a query
 * carrying no change event — by reporting nothing rather than throwing, which
 * leaves the startup answer standing.
 */
export function watchReducedMotion(
  onChange: (reduced: boolean) => void,
  view: MediaQueryView | undefined = globalThis.window
): () => void {
  const unwatched = (): void => {}
  if (!view || typeof view.matchMedia !== 'function') return unwatched
  const query = view.matchMedia(REDUCED_MOTION_QUERY)
  if (typeof query.addEventListener !== 'function') return unwatched

  const listener = (): void => onChange(query.matches === true)
  query.addEventListener('change', listener)
  return () => query.removeEventListener?.('change', listener)
}

/** Where a dwarf is right now, and how it is getting to where it is going. */
export interface WalkState {
  /** The point the sprite is animating towards — its current leg's end. */
  point: ScenePoint
  /** How long that leg takes, so the sprite's CSS transition can match it. */
  legMs: number
  /** True while there are legs left to walk. */
  walking: boolean
  /** Which way the sprite faces while making this leg. */
  facesLeft: boolean
}

export interface WalkBoard {
  /**
   * Reconcile with the latest target per dwarf. A moved target asks `route` for
   * the line to walk and starts the dwarf down it; an unchanged one is left
   * alone, because the panel re-polls constantly and re-routing every time
   * would hold the whole crew permanently on its way somewhere.
   *
   * `spawnAt` says where an ARRIVAL comes in — see the rule on
   * `createWalkBoard`. Omit it and an unseen dwarf is simply placed, which is
   * what a sprite mounted outside a scene wants.
   */
  sync(
    targets: ReadonlyMap<string, ScenePoint>,
    route: (from: ScenePoint, to: ScenePoint) => readonly ScenePoint[],
    spawnAt?: (target: ScenePoint) => ScenePoint
  ): void
  /** Cancel every pending leg; the board stops emitting. */
  dispose(): void
}

interface TrackedWalk {
  /** Where the dwarf has been sent. */
  target: ScenePoint
  /** Where it is at this instant. */
  at: ScenePoint
  legs: readonly WalkLeg[]
  next: number
  facesLeft: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Framework-agnostic walk tracker, shaped like `createBubbleBoard`: `onChange`
 * receives a fresh snapshot of where everybody is every time that changes, so a
 * Vue component can mirror it into a ref.
 *
 * The board walks a ROUTE rather than a straight line (#137). A dwarf crossing
 * this interior has to follow the painted stairs and ladders, so the journey
 * arrives as a polyline and the board steps along it one leg at a time —
 * setting each leg as the sprite's target and arming a timer for its own
 * duration. The component animates one leg; the board owns which leg that is.
 *
 * ## Who walks in, and who was already here (#153)
 *
 * A dwarf the board has never seen used to be recorded at its target without
 * walking, whatever snapshot it turned up in — so a session that connected while
 * somebody was watching simply materialised at its workstation, which is what
 * the maintainer saw.
 *
 * The rule that makes both halves right is WHICH SNAPSHOT it first appeared in.
 * The first sync is the mine being opened: everyone in it was already at work
 * before anybody looked, and walking them in would parade a whole crew across
 * the interior on every open. Every sync after that is a genuine arrival, and it
 * comes in at the spawn point `spawnAt` names and walks its route to its
 * station, exactly as the launch flow's own worker does.
 *
 * Reduced motion never reaches here at all: MineScene places the crew statically
 * and does not sync the board, so an arrival appears in place.
 */
export function createWalkBoard(
  onChange: (state: ReadonlyMap<string, WalkState>) => void
): WalkBoard {
  const tracked = new Map<string, TrackedWalk>()
  let disposed = false
  /** False until the first sync has landed — see the arrivals rule above. */
  let opened = false

  function snapshot(): ReadonlyMap<string, WalkState> {
    const state = new Map<string, WalkState>()
    for (const [id, entry] of tracked) {
      const leg = entry.legs[entry.next]
      state.set(id, {
        point: leg ? leg.point : entry.at,
        legMs: leg ? leg.durationMs : 0,
        walking: leg !== undefined,
        facesLeft: entry.facesLeft
      })
    }
    return state
  }

  function emit(): void {
    if (!disposed) onChange(snapshot())
  }

  function step(id: string, entry: TrackedWalk): void {
    const leg = entry.legs[entry.next]
    if (!leg) {
      entry.timer = undefined
      return
    }
    entry.facesLeft = walkFacesLeft(entry.at, leg.point, entry.facesLeft)
    entry.timer = setTimeout(() => {
      entry.at = leg.point
      entry.next += 1
      step(id, entry)
      emit()
    }, leg.durationMs)
  }

  function drop(id: string): void {
    const entry = tracked.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    tracked.delete(id)
  }

  return {
    sync(targets, route, spawnAt) {
      if (disposed) return
      let changed = false

      for (const [id, target] of targets) {
        const entry = tracked.get(id)
        if (!entry) {
          // The opening crew is placed; anyone who turns up later walks in.
          const from = opened && spawnAt ? spawnAt(target) : target
          const arrival: TrackedWalk = { target, at: from, legs: [], next: 0, facesLeft: false }
          tracked.set(id, arrival)
          if (paintingDistance(from, target) >= ARRIVAL_EPSILON_PX) {
            arrival.legs = pathLegs(route(from, target))
            if (arrival.legs.length === 0) arrival.at = target
            step(id, arrival)
          }
          changed = true
          continue
        }
        if (paintingDistance(entry.target, target) < ARRIVAL_EPSILON_PX) continue
        if (entry.timer) clearTimeout(entry.timer)
        entry.target = target
        entry.legs = pathLegs(route(entry.at, target))
        entry.next = 0
        if (entry.legs.length === 0) entry.at = target
        step(id, entry)
        changed = true
      }

      for (const id of [...tracked.keys()]) {
        if (!targets.has(id)) {
          drop(id)
          changed = true
        }
      }

      // Set unconditionally, and after the loop: a mine opened empty has still
      // been opened, and the first crew to arrive in it walks in.
      opened = true
      if (changed) emit()
    },
    dispose() {
      disposed = true
      for (const entry of tracked.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      tracked.clear()
    }
  }
}
