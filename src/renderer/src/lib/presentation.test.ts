import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus, MineTier } from '../types'
import {
  BUBBLE_MAX_CHARS,
  LEAVING_EXIT_MS,
  NEUTRAL_DWARF_FRAME,
  WALK_ANIMATION,
  dwarfAnimation,
  isPickImpact,
  isSpriteFlipped,
  orePileLabel,
  sceneDwarfAnimation,
  statusAnimationClass,
  tierLabel
} from './presentation'

describe('statusAnimationClass', () => {
  it('maps every dwarf status to its animation class', () => {
    const expected: Record<DwarfStatus, string> = {
      working: 'is-working',
      waiting: 'is-waiting',
      leaving: 'is-leaving'
    }
    for (const status of Object.keys(expected) as DwarfStatus[]) {
      expect(statusAnimationClass(status)).toBe(expected[status])
    }
  })
})

describe('tierLabel', () => {
  it('capitalizes each tier for display', () => {
    const cases: Record<MineTier, string> = {
      bronze: 'Bronze',
      copper: 'Copper',
      silver: 'Silver',
      gold: 'Gold',
      uranium: 'Uranium'
    }
    for (const tier of Object.keys(cases) as MineTier[]) {
      expect(tierLabel(tier)).toBe(cases[tier])
    }
  })
})

describe('BUBBLE_MAX_CHARS', () => {
  it('keeps speech bubbles around seventy characters', () => {
    expect(BUBBLE_MAX_CHARS).toBe(70)
  })
})

describe('dwarfAnimation', () => {
  it('swings the pickaxe while a worker is working', () => {
    expect(dwarfAnimation('working', 'worker')).toEqual({
      frames: ['pick-1', 'pick-2'],
      frameMs: 550
    })
  })

  it('rests a waiting worker on a much slower cycle', () => {
    expect(dwarfAnimation('waiting', 'worker')).toEqual({
      frames: ['rest-1', 'rest-2'],
      frameMs: 1400
    })
  })

  it('has the foreman check the log book while working', () => {
    expect(dwarfAnimation('working', 'foreman')).toEqual({
      frames: ['foreman-idle', 'foreman-check'],
      frameMs: 1000
    })
  })

  it('rests a waiting foreman on the worker rest frames until foreman art exists', () => {
    // Issue #34: dedicated foreman-waiting artwork is explicitly deferred, so a
    // blocked foreman temporarily reuses the worker sleeping/rest animation —
    // it must read as paused, not as a foreman still checking the log book.
    expect(dwarfAnimation('waiting', 'foreman')).toEqual({
      frames: ['rest-1', 'rest-2'],
      frameMs: 1400
    })
    expect(dwarfAnimation('waiting', 'foreman')).toEqual(dwarfAnimation('waiting', 'worker'))
  })

  it('walks anyone who is leaving, foreman included', () => {
    const walking = { frames: ['walk-1', 'walk-2'], frameMs: 350 }
    expect(dwarfAnimation('leaving', 'worker')).toEqual(walking)
    expect(dwarfAnimation('leaving', 'foreman')).toEqual(walking)
  })

  it('covers every status and role combination with at least one frame', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        const animation = dwarfAnimation(status, role)
        expect(animation.frames.length).toBeGreaterThan(0)
        expect(animation.frameMs).toBeGreaterThan(0)
      }
    }
  })
})

describe('NEUTRAL_DWARF_FRAME', () => {
  it('is the plain standing pose used for brief transitions', () => {
    expect(NEUTRAL_DWARF_FRAME).toBe('idle')
  })

  it('is never part of a running animation, so it reads as a pause', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        expect(dwarfAnimation(status, role).frames).not.toContain(NEUTRAL_DWARF_FRAME)
      }
    }
  })
})

describe('isSpriteFlipped', () => {
  it('mirrors only a leaving dwarf, because the art faces right and the exit is left', () => {
    expect(isSpriteFlipped('leaving')).toBe(true)
    expect(isSpriteFlipped('working')).toBe(false)
    expect(isSpriteFlipped('waiting')).toBe(false)
  })
})

describe('LEAVING_EXIT_MS', () => {
  it('matches the runtime grace window a leaving dwarf has to walk out', () => {
    expect(LEAVING_EXIT_MS).toBe(16_000)
  })
})

/*
 * Issue #19 — the cave stopped being a backdrop. A dwarf now walks to the
 * painted feature its status calls for, so the frame loops have to cover the
 * journey as well as the destination.
 */
describe('WALK_ANIMATION', () => {
  it('reuses the painted walk cycle, so crossing the floor needs no new art', () => {
    expect(WALK_ANIMATION).toEqual({ frames: ['walk-1', 'walk-2'], frameMs: 350 })
    expect(WALK_ANIMATION).toEqual(dwarfAnimation('leaving', 'worker'))
  })
})

describe('sceneDwarfAnimation', () => {
  it('walks any dwarf that is mid-crossing, whatever it is on its way to do', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        expect(sceneDwarfAnimation(status, role, true), `${status}/${role}`).toEqual(WALK_ANIMATION)
      }
    }
  })

  it('hands back to the status loop the moment the dwarf arrives', () => {
    expect(sceneDwarfAnimation('working', 'worker', false)).toEqual(
      dwarfAnimation('working', 'worker')
    )
    expect(sceneDwarfAnimation('waiting', 'foreman', false)).toEqual(
      dwarfAnimation('waiting', 'foreman')
    )
  })
})

describe('isPickImpact', () => {
  it('marks the down-stroke of the swing — the frame whose hit throws sparks', () => {
    expect(isPickImpact('pick-2')).toBe(true)
  })

  it('marks no other pose, so nothing sparks while resting or walking past', () => {
    for (const frame of ['idle', 'pick-1', 'walk-1', 'walk-2', 'rest-1', 'rest-2'] as const) {
      expect(isPickImpact(frame), frame).toBe(false)
    }
  })
})

/*
 * The CSS nuggets read as anonymous grey balls, so the pile has to say what it
 * is. Painted per-material art is coming later; the wording is what has to
 * survive that swap, which is why it lives here and not in the template.
 */
describe('orePileLabel', () => {
  it('names the material and the amount rather than leaving a nameless heap', () => {
    expect(orePileLabel('gold', 125_000)).toBe('Gold ore — 12 mined (125K tokens)')
    expect(orePileLabel('uranium', 10_000)).toBe('Uranium ore — 1 mined (10K tokens)')
  })

  it('says plainly that nothing has been mined instead of implying a pile', () => {
    expect(orePileLabel('bronze', 0)).toBe('Bronze ore — none mined yet')
    expect(orePileLabel('bronze', 9_999)).toBe('Bronze ore — none mined yet')
  })
})
