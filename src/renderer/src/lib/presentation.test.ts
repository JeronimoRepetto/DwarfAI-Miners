import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus, MineTier } from '../types'
import {
  BUBBLE_MAX_CHARS,
  LEAVING_EXIT_MS,
  NEUTRAL_DWARF_FRAME,
  dwarfAnimation,
  isSpriteFlipped,
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

  it('leaves a waiting foreman standing still, so only the zzz moves', () => {
    expect(dwarfAnimation('waiting', 'foreman')).toEqual({
      frames: ['foreman-idle'],
      frameMs: 1400
    })
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
