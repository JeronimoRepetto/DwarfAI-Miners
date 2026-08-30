import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenePoint } from './sceneLayout'
import {
  ARRIVAL_EPSILON,
  MAX_WALK_MS,
  MIN_WALK_MS,
  createWalkBoard,
  prefersReducedMotion,
  walkDurationMs,
  walkFacesLeft
} from './sceneMotion'

function targets(entries: Record<string, ScenePoint>): Map<string, ScenePoint> {
  return new Map(Object.entries(entries))
}

describe('walkDurationMs', () => {
  it('takes no time at all to walk to the spot a dwarf is already standing on', () => {
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 40, y: 70 })).toBe(0)
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 40 + ARRIVAL_EPSILON / 2, y: 70 })).toBe(0)
  })

  it('takes longer the farther a dwarf has to cross the gallery', () => {
    const short = walkDurationMs({ x: 40, y: 70 }, { x: 50, y: 70 })
    const long = walkDurationMs({ x: 20, y: 79 }, { x: 79, y: 79 })
    expect(long).toBeGreaterThan(short)
  })

  it('keeps every walk inside a readable range, never a twitch and never a trek', () => {
    expect(walkDurationMs({ x: 40, y: 70 }, { x: 41, y: 70 })).toBeGreaterThanOrEqual(MIN_WALK_MS)
    expect(walkDurationMs({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeLessThanOrEqual(MAX_WALK_MS)
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
    const to = { x: 40 - ARRIVAL_EPSILON / 2, y: 70 }
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

  /*
    A dwarf appearing for the first time materialises at its spot. Walking it in
    from wherever the board happened to have nothing would be a sprint across
    the cave every time a session connects.
  */
  it('does not walk a dwarf that has only just appeared', () => {
    const seen: ReadonlySet<string>[] = []
    const board = createWalkBoard((walking) => seen.push(walking))
    board.sync(targets({ a: { x: 36, y: 70 } }))
    expect(seen.every((set) => set.size === 0)).toBe(true)
  })

  it('walks a dwarf whose spot moved, and stops it on arrival', () => {
    let walking: ReadonlySet<string> = new Set()
    const board = createWalkBoard((next) => {
      walking = next
    })
    const from = { x: 36, y: 70 }
    const to = { x: 21, y: 79 }
    board.sync(targets({ a: from }))
    board.sync(targets({ a: to }))
    expect(walking.has('a')).toBe(true)

    vi.advanceTimersByTime(walkDurationMs(from, to) - 1)
    expect(walking.has('a')).toBe(true)
    vi.advanceTimersByTime(2)
    expect(walking.has('a')).toBe(false)
  })

  it('leaves a dwarf alone when the poll reports the same spot again', () => {
    let emissions = 0
    const board = createWalkBoard(() => {
      emissions++
    })
    board.sync(targets({ a: { x: 36, y: 70 } }))
    const before = emissions
    board.sync(targets({ a: { x: 36, y: 70 } }))
    board.sync(targets({ a: { x: 36, y: 70 } }))
    expect(emissions).toBe(before)
  })

  it('re-aims a dwarf that is redirected mid-walk instead of dropping it', () => {
    let walking: ReadonlySet<string> = new Set()
    const board = createWalkBoard((next) => {
      walking = next
    })
    board.sync(targets({ a: { x: 36, y: 70 } }))
    board.sync(targets({ a: { x: 64, y: 70 } }))
    vi.advanceTimersByTime(MIN_WALK_MS)
    board.sync(targets({ a: { x: 21, y: 79 } }))
    expect(walking.has('a')).toBe(true)
    vi.advanceTimersByTime(MAX_WALK_MS)
    expect(walking.has('a')).toBe(false)
  })

  it('forgets a dwarf that left the mine, mid-walk or not', () => {
    let walking: ReadonlySet<string> = new Set()
    const board = createWalkBoard((next) => {
      walking = next
    })
    board.sync(targets({ a: { x: 36, y: 70 } }))
    board.sync(targets({ a: { x: 79, y: 79 } }))
    expect(walking.has('a')).toBe(true)
    board.sync(targets({}))
    expect(walking.has('a')).toBe(false)
  })

  it('stops emitting and cancels its timers once disposed', () => {
    let emissions = 0
    const board = createWalkBoard(() => {
      emissions++
    })
    board.sync(targets({ a: { x: 36, y: 70 } }))
    board.sync(targets({ a: { x: 79, y: 79 } }))
    const afterWalkStarted = emissions
    board.dispose()
    vi.advanceTimersByTime(MAX_WALK_MS * 2)
    board.sync(targets({ a: { x: 21, y: 79 } }))
    expect(emissions).toBe(afterWalkStarted)
  })
})
