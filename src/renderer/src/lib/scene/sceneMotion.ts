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
import type { ScenePoint } from './sceneLayout'

/**
 * How fast a dwarf crosses the painting, in image-percent units per second.
 * The gallery is about 60 units wide, so a corner-to-corner walk lands near
 * three and a half seconds: unhurried, and slow enough to be read as walking.
 */
export const WALK_SPEED_PER_SEC = 18

/** A twitch shorter than this reads as a glitch, not a step. */
export const MIN_WALK_MS = 240

/** Nothing in one cave is far enough to justify a longer march than this. */
export const MAX_WALK_MS = 3200

/**
 * Two points closer than this are the same spot. Guards the whole module
 * against floating-point noise in the share offsets restarting a walk, and
 * against a re-poll that reports identical coordinates twitching the sprite.
 */
export const ARRIVAL_EPSILON = 0.5

function distance(from: ScenePoint, to: ScenePoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

/** How long this crossing should take. Zero when there is nowhere to go. */
export function walkDurationMs(from: ScenePoint, to: ScenePoint): number {
  const span = distance(from, to)
  if (span < ARRIVAL_EPSILON) return 0
  const raw = (span / WALK_SPEED_PER_SEC) * 1000
  return Math.min(Math.max(raw, MIN_WALK_MS), MAX_WALK_MS)
}

/**
 * Which way to mirror the sprite. The art is painted facing right, so this is
 * what turns a dwarf to face where it is going — and, once it has arrived and
 * there is no travel direction left to read, to face what its anchor faces.
 */
export function walkFacesLeft(from: ScenePoint, to: ScenePoint, parkedFacesLeft: boolean): boolean {
  const dx = to.x - from.x
  if (Math.abs(dx) < ARRIVAL_EPSILON) return parkedFacesLeft
  return dx < 0
}

/** The narrow slice of `window` the reduced-motion query needs. */
export interface MediaQueryView {
  matchMedia?: (query: string) => { matches: boolean }
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
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches === true
}

export interface WalkBoard {
  /** Reconcile with the latest target per dwarf; a moved target starts a walk. */
  sync(targets: ReadonlyMap<string, ScenePoint>): void
  /** Cancel every pending arrival; the board stops emitting. */
  dispose(): void
}

interface TrackedWalk {
  target: ScenePoint
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Framework-agnostic walk tracker, shaped like `createBubbleBoard`: `onChange`
 * receives a fresh snapshot of who is mid-walk every time that set changes, so
 * a Vue component can mirror it into a ref.
 *
 * A dwarf seen for the first time is recorded at its target without walking —
 * a session that just connected should appear at its rock, not sprint in from
 * wherever the board had nothing.
 */
export function createWalkBoard(onChange: (walking: ReadonlySet<string>) => void): WalkBoard {
  const tracked = new Map<string, TrackedWalk>()
  const walking = new Set<string>()
  let disposed = false

  function emit(): void {
    if (!disposed) onChange(new Set(walking))
  }

  function arriveLater(id: string, entry: TrackedWalk, durationMs: number): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (walking.delete(id)) emit()
    }, durationMs)
  }

  function drop(id: string): boolean {
    const entry = tracked.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    tracked.delete(id)
    return walking.delete(id)
  }

  return {
    sync(targets) {
      if (disposed) return
      let changed = false

      for (const [id, target] of targets) {
        const entry = tracked.get(id)
        if (!entry) {
          tracked.set(id, { target })
          continue
        }
        const durationMs = walkDurationMs(entry.target, target)
        entry.target = target
        // An unchanged target must not re-arm anything: the panel re-polls
        // constantly and would otherwise hold every dwarf permanently walking.
        if (durationMs === 0) continue
        arriveLater(id, entry, durationMs)
        if (!walking.has(id)) {
          walking.add(id)
          changed = true
        }
      }

      for (const id of [...tracked.keys()]) {
        if (!targets.has(id) && drop(id)) changed = true
      }

      if (changed) emit()
    },
    dispose() {
      disposed = true
      for (const entry of tracked.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      tracked.clear()
      walking.clear()
    }
  }
}
