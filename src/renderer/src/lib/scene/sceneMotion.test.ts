import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paintingDistance } from './interiorRoute'
import type { ScenePoint } from './sceneLayout'
import {
  ARRIVAL_EPSILON_PX,
  MAX_WALK_MS,
  MIN_WALK_MS,
  WALK_SPEED_PX_PER_SEC,
  createWalkBoard,
  pathDurationMs,
  pathLegs,
  prefersReducedMotion,
  walkDurationMs,
  watchReducedMotion,
  walkFacesLeft
} from './sceneMotion'

function targets(entries: Record<string, ScenePoint>): Map<string, ScenePoint> {
  return new Map(Object.entries(entries))
}

/** The straight line a test wants when it is not testing routing. */
const straight = (from: ScenePoint, to: ScenePoint): readonly ScenePoint[] => [from, to]

describe('walkDurationMs', () => {
  it('takes no time at all to walk to the spot a dwarf is already standing on', () => {
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 40, y: 70 })).toBe(0)
    // Half the arrival epsilon, expressed back in percent of the painting's width.
    const nudge = (ARRIVAL_EPSILON_PX / 2 / 1184) * 100
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 40 + nudge, y: 70 })).toBe(0)
  })

  it('takes longer the farther a dwarf has to cross the mine', () => {
    const short = walkDurationMs({ x: 40, y: 70 }, { x: 50, y: 70 })
    const long = walkDurationMs({ x: 20, y: 20 }, { x: 79, y: 79 })
    expect(long).toBeGreaterThan(short)
  })

  /*
   * The painting is three times taller than it is wide, so the same number of
   * percent means three times as far vertically. A duration measured in percent
   * would have a dwarf climb the whole mine in the time it takes to cross one
   * gallery — which is what a screen-space speed always gets wrong on art this
   * shape, and it looks like sliding rather than like a bug.
   */
  it('counts a percent of height as three times a percent of width', () => {
    const across = walkDurationMs({ x: 0, y: 50 }, { x: 10, y: 50 })
    const down = walkDurationMs({ x: 50, y: 0 }, { x: 50, y: 10 })
    expect(down / across).toBeCloseTo(3622 / 1184, 1)
  })

  it('keeps every walk inside a readable range, never a twitch and never a trek', () => {
    // One percent of the painting's width: 12 pixels, past the arrival epsilon
    // and well inside the distance the floor covers.
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 41, y: 70 })).toBeGreaterThanOrEqual(MIN_WALK_MS)
    expect(walkDurationMs({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeLessThanOrEqual(MAX_WALK_MS)
  })
})

describe('pathDurationMs', () => {
  it('walks the route rather than the line between its ends', () => {
    const dogleg = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 20 }
    ]
    expect(pathDurationMs(dogleg)).toBeGreaterThan(
      walkDurationMs(dogleg[0] as ScenePoint, dogleg[2] as ScenePoint)
    )
  })

  it('holds one steady pace, so a long route simply takes longer', () => {
    const path = [
      { x: 20, y: 20 },
      { x: 40, y: 30 }
    ]
    const span = paintingDistance(path[0] as ScenePoint, path[1] as ScenePoint)
    expect(pathDurationMs(path)).toBeCloseTo((span / WALK_SPEED_PX_PER_SEC) * 1000, 3)
  })
})

describe('pathLegs', () => {
  const path = [
    { x: 10, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 }
  ]

  it('gives each leg its own share of the journey, so nobody pauses at a corner', () => {
    const legs = pathLegs(path)
    expect(legs.map((leg) => leg.point)).toEqual([path[1], path[2]])
    const total = legs.reduce((sum, leg) => sum + leg.durationMs, 0)
    expect(total).toBeCloseTo(pathDurationMs(path), 3)
    // The vertical leg is three times the horizontal one on this art, so it
    // takes three times as long — the same pace, not the same time.
    expect((legs[1] as { durationMs: number }).durationMs).toBeGreaterThan(
      (legs[0] as { durationMs: number }).durationMs
    )
  })

  /*
   * The clamps are on the journey, not on each leg. An extracted corridor is a
   * polyline of many short segments, and flooring each of those at MIN_WALK_MS
   * would turn a smooth walk into a stutter round every corner.
   */
  it('never floors a single leg at the journey minimum', () => {
    const wiggly = [
      { x: 10, y: 10 },
      { x: 10.1, y: 10 },
      { x: 10.2, y: 10 },
      { x: 60, y: 10 }
    ]
    const legs = pathLegs(wiggly)
    expect((legs[0] as { durationMs: number }).durationMs).toBeLessThan(MIN_WALK_MS)
  })

  it('has no legs to walk when there is nowhere to go', () => {
    expect(pathLegs([])).toEqual([])
    expect(pathLegs([{ x: 5, y: 5 }])).toEqual([])
    expect(
      pathLegs([
        { x: 5, y: 5 },
        { x: 5, y: 5 }
      ])
    ).toEqual([])
  })
})

describe('walkFacesLeft', () => {
  it('turns a dwarf the way it is actually travelling', () => {
    expect(walkFacesLeft({ x: 60, y: 70 }, { x: 20, y: 79 }, false)).toBe(true)
    expect(walkFacesLeft({ x: 20, y: 79 }, { x: 60, y: 70 }, true)).toBe(false)
  })

  /*
    A dwarf that has arrived is no longer travelling, so its facing comes from
    the anchor instead — which is what turns a miner to face the rock rather
    than whichever way he happened to walk in from.
  */
  it('falls back to the anchor facing once there is no travel left to read', () => {
    expect(walkFacesLeft({ x: 40, y: 70 }, { x: 40, y: 70 }, true)).toBe(true)
    expect(walkFacesLeft({ x: 40, y: 70 }, { x: 40, y: 70 }, false)).toBe(false)
  })

  it('ignores a nudge too small to read as a direction', () => {
    const from = { x: 40, y: 70 }
    const to = { x: 40 - (ARRIVAL_EPSILON_PX / 2 / 1184) * 100, y: 70 }
    expect(walkFacesLeft(from, to, false)).toBe(false)
  })
})

describe('prefersReducedMotion', () => {
  function view(matches: boolean): { matchMedia: (query: string) => { matches: boolean } } {
    return { matchMedia: () => ({ matches }) }
  }

  it('reports the viewer preference when the platform exposes it', () => {
    expect(prefersReducedMotion(view(true))).toBe(true)
    expect(prefersReducedMotion(view(false))).toBe(false)
  })

  it('assumes motion is welcome where the query cannot be asked at all', () => {
    expect(prefersReducedMotion(undefined)).toBe(false)
    expect(prefersReducedMotion({})).toBe(false)
  })
})

describe('createWalkBoard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** The board's latest word on one dwarf. */
  function watch(): {
    board: ReturnType<typeof createWalkBoard>
    walking: (id: string) => boolean
    at: (id: string) => ScenePoint | undefined
    emissions: () => number
  } {
    let state: ReadonlyMap<string, { point: ScenePoint; walking: boolean }> = new Map()
    let emissions = 0
    const board = createWalkBoard((next) => {
      state = next
      emissions++
    })
    return {
      board,
      walking: (id) => state.get(id)?.walking === true,
      at: (id) => state.get(id)?.point,
      emissions: () => emissions
    }
  }

  /*
    AMENDED for #153's eleventh correction. This case read "does not walk a dwarf
    that has only just appeared" and covered BOTH openings at once: the first
    snapshot of a mine already full of agents, and a session that connects while
    somebody is watching. The maintainer ruled they are different — an arrival
    must enter through a spawn point and WALK to its station — and the first
    reading is exactly why it must not become "walk everybody in", because a mine
    opened with five agents at work would parade all five across it.

    So the FIRST sync still materialises everyone where they belong, and it keeps
    this case; the arrivals it now excludes are covered directly below.
  */
  it('does not walk the crew that was already at work when the mine opened', () => {
    const seen = watch()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    expect(seen.walking('a')).toBe(false)
    expect(seen.at('a')).toEqual({ x: 36, y: 70 })
  })

  /*
   * #153's eleventh correction: "a new dwarf materialized at its workstation.
   * Arrivals must enter via a spawn point and WALK to their station."
   *
   * The rule that makes both halves true is which SNAPSHOT the dwarf first
   * appeared in. The first one is the board being opened — everyone in it was
   * already working before anybody looked, and walking them in would be a lie
   * about five sessions at once. Everything after it is a genuine arrival.
   */
  describe('arrivals', () => {
    const SPAWN = { x: 44, y: 22 }
    const STATION = { x: 80, y: 80 }
    const spawnAt = (): ScenePoint => SPAWN

    it('starts an arrival at the spawn point and walks it to its station', () => {
      const seen = watch()
      seen.board.sync(targets({ a: STATION }), straight, spawnAt)
      // The opening crew: still placed, not walked.
      expect(seen.walking('a')).toBe(false)

      seen.board.sync(targets({ a: STATION, b: STATION }), straight, spawnAt)
      expect(seen.walking('b')).toBe(true)
      // Mid-walk it is heading for the station, having left the spawn behind.
      expect(seen.at('b')).toEqual(STATION)
      expect(seen.walking('a')).toBe(false)
    })

    /*
     * #156's ninth correction, and the case the first-snapshot rule alone can
     * never get right.
     *
     * A mine with no crew is not on the board at all, so its interior is not
     * mounted and this board does not exist. Launch the first agent and the
     * scene mounts WITH that agent already in it — which the rule above reads as
     * "was already at work before anybody looked", and the maintainer watched
     * his foreman materialise on the spot. The second launch walked, because by
     * then the board had been alive to see the mine empty.
     *
     * So the exemption is per-DWARF-SET rather than per-first-sync: the panel
     * has been polling all along and knows which dwarfs were not on the previous
     * snapshot, and one of those is an arrival whenever this board first sees
     * it. A crew that was on the board before the panel opened its mine is not.
     */
    it('walks in a dwarf the panel reports as newly arrived, even on the first sync', () => {
      const seen = watch()
      seen.board.sync(targets({ b: STATION }), straight, spawnAt, new Set(['b']))
      expect(seen.walking('b')).toBe(true)
    })

    it('still places the opening crew when the panel reports no arrival', () => {
      // Switching from one mine to another mounts a fresh board over a crew
      // that has been at work for hours; nothing about that is an arrival.
      const seen = watch()
      seen.board.sync(targets({ a: STATION }), straight, spawnAt, new Set())
      expect(seen.walking('a')).toBe(false)
    })

    it('places the rest of a crew that arrived beside one newcomer', () => {
      const seen = watch()
      seen.board.sync(targets({ a: STATION, b: SPAWN }), straight, spawnAt, new Set(['b']))
      expect(seen.walking('a')).toBe(false)
      expect(seen.walking('b')).toBe(false) // already standing on its own spawn
      expect(seen.at('a')).toEqual(STATION)
    })

    it('leaves the arrival standing at its station once it gets there', () => {
      const seen = watch()
      seen.board.sync(targets({}), straight, spawnAt)
      seen.board.sync(targets({ b: STATION }), straight, spawnAt)
      expect(seen.walking('b')).toBe(true)
      vi.advanceTimersByTime(MAX_WALK_MS)
      expect(seen.walking('b')).toBe(false)
      expect(seen.at('b')).toEqual(STATION)
    })

    it('walks an arrival along the ROUTE, not through the rock', () => {
      const seen = watch()
      const corner = { x: 44, y: 80 }
      const viaCorner = (from: ScenePoint, to: ScenePoint): readonly ScenePoint[] => [
        from,
        corner,
        to
      ]
      seen.board.sync(targets({}), viaCorner, spawnAt)
      seen.board.sync(targets({ b: STATION }), viaCorner, spawnAt)
      // The first leg ends at the corridor's corner, not at the station.
      expect(seen.at('b')).toEqual(corner)
    })

    it('places an arrival outright when nothing tells it where to come in', () => {
      // No spawn provider is the sprite-on-its-own case, and the honest answer
      // there is the old one: appear where you belong.
      const seen = watch()
      seen.board.sync(targets({}), straight)
      seen.board.sync(targets({ b: STATION }), straight)
      expect(seen.walking('b')).toBe(false)
      expect(seen.at('b')).toEqual(STATION)
    })

    it('walks a dwarf back in that left and came back', () => {
      const seen = watch()
      seen.board.sync(targets({ a: STATION }), straight, spawnAt)
      seen.board.sync(targets({}), straight, spawnAt)
      seen.board.sync(targets({ a: STATION }), straight, spawnAt)
      expect(seen.walking('a')).toBe(true)
    })
  })

  it('walks a dwarf whose spot moved, and stops it on arrival', () => {
    const seen = watch()
    const from = { x: 36, y: 70 }
    const to = { x: 21, y: 79 }
    seen.board.sync(targets({ a: from }), straight)
    seen.board.sync(targets({ a: to }), straight)
    expect(seen.walking('a')).toBe(true)

    vi.advanceTimersByTime(walkDurationMs(from, to) - 1)
    expect(seen.walking('a')).toBe(true)
    vi.advanceTimersByTime(2)
    expect(seen.walking('a')).toBe(false)
    expect(seen.at('a')).toEqual(to)
  })

  /*
    The point of #137's routing: the board is handed the LINE a dwarf walks,
    not just its two ends, and steps along it a corner at a time. A board that
    animated straight to the target would send him through the rock.
  */
  it('steps a dwarf through every corner of the route it was given', () => {
    const seen = watch()
    const corner = { x: 60, y: 20 }
    const end = { x: 60, y: 60 }
    seen.board.sync(targets({ a: { x: 20, y: 20 } }), straight)
    seen.board.sync(targets({ a: end }), (from, to) => [from, corner, to])

    expect(seen.at('a')).toEqual(corner)
    expect(seen.walking('a')).toBe(true)
    vi.advanceTimersByTime(MAX_WALK_MS)
    expect(seen.at('a')).toEqual(end)
    expect(seen.walking('a')).toBe(false)
  })

  it('leaves a dwarf alone when the poll reports the same spot again', () => {
    const seen = watch()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    const before = seen.emissions()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    expect(seen.emissions()).toBe(before)
  })

  it('re-aims a dwarf that is redirected mid-walk instead of dropping it', () => {
    const seen = watch()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    seen.board.sync(targets({ a: { x: 64, y: 70 } }), straight)
    vi.advanceTimersByTime(MIN_WALK_MS)
    seen.board.sync(targets({ a: { x: 21, y: 20 } }), straight)
    expect(seen.walking('a')).toBe(true)
    vi.advanceTimersByTime(MAX_WALK_MS)
    expect(seen.walking('a')).toBe(false)
    expect(seen.at('a')).toEqual({ x: 21, y: 20 })
  })

  it('forgets a dwarf that left the mine, mid-walk or not', () => {
    const seen = watch()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    seen.board.sync(targets({ a: { x: 79, y: 20 } }), straight)
    expect(seen.walking('a')).toBe(true)
    seen.board.sync(targets({}), straight)
    expect(seen.at('a')).toBeUndefined()
  })

  it('stops emitting and cancels its timers once disposed', () => {
    const seen = watch()
    seen.board.sync(targets({ a: { x: 36, y: 70 } }), straight)
    seen.board.sync(targets({ a: { x: 79, y: 20 } }), straight)
    const afterWalkStarted = seen.emissions()
    seen.board.dispose()
    vi.advanceTimersByTime(MAX_WALK_MS * 2)
    seen.board.sync(targets({ a: { x: 21, y: 79 } }), straight)
    expect(seen.emissions()).toBe(afterWalkStarted)
  })
})

/*
 * Issue #71 — the preference is not only read at startup any more. A viewer
 * who turns it on while the panel is open must not have to relaunch to be
 * listened to, which means subscribing rather than sampling.
 */
describe('watchReducedMotion', () => {
  /** A media query that can actually change its mind, as a real one can. */
  function listenable(initial: boolean) {
    const listeners = new Set<() => void>()
    const query = {
      matches: initial,
      addEventListener: (_type: 'change', listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) =>
        void listeners.delete(listener)
    }
    return {
      view: { matchMedia: () => query },
      flip(next: boolean): void {
        query.matches = next
        for (const listener of [...listeners]) listener()
      },
      get listenerCount(): number {
        return listeners.size
      }
    }
  }

  it('reports the preference changing under a panel that is already open', () => {
    const media = listenable(false)
    const seen: boolean[] = []
    watchReducedMotion((reduced) => seen.push(reduced), media.view)

    media.flip(true)
    media.flip(false)
    expect(seen).toEqual([true, false])
  })

  it('hands back a way to stop listening, and stops', () => {
    const media = listenable(false)
    const seen: boolean[] = []
    const stop = watchReducedMotion((reduced) => seen.push(reduced), media.view)
    expect(media.listenerCount).toBe(1)

    stop()
    expect(media.listenerCount).toBe(0)
    media.flip(true)
    expect(seen).toEqual([])
  })

  it('stays silent rather than throwing where the query cannot be asked at all', () => {
    // jsdom leaves window.matchMedia undefined, and so does the very first
    // render — neither is a reason to refuse to draw a dwarf.
    const seen: boolean[] = []
    for (const view of [undefined, {}]) {
      expect(() => watchReducedMotion((reduced) => seen.push(reduced), view)()).not.toThrow()
    }
    expect(seen).toEqual([])
  })

  it('stays silent rather than throwing where the query cannot be listened to', () => {
    // An older platform answers the query but has no change event on it. The
    // answer it gave at startup still stands; nothing else is promised.
    const seen: boolean[] = []
    const stop = watchReducedMotion((reduced) => seen.push(reduced), {
      matchMedia: () => ({ matches: true })
    })
    expect(() => stop()).not.toThrow()
    expect(seen).toEqual([])
  })
})
