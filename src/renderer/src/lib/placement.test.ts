import { describe, expect, it } from 'vitest'
import { MAP_SPAWN_SITE_COUNT } from '../types'
import { assignSlots, hashString } from './placement'

const IDS = [
  'C:/dev/alpha',
  'C:/dev/beta',
  'C:/dev/gamma',
  'C:/dev/delta',
  'C:/work/epsilon',
  'C:/work/zeta',
  'C:/work/eta',
  'C:/tools/theta',
  'C:/tools/iota',
  'C:/tools/kappa',
  'C:/tools/lambda',
  'C:/tools/mu'
]

describe('hashString', () => {
  it('is deterministic', () => {
    expect(hashString('C:/dev/alpha')).toBe(hashString('C:/dev/alpha'))
  })

  it('returns an unsigned 32-bit integer', () => {
    for (const id of IDS) {
      const hash = hashString(id)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('spreads distinct ids to distinct hashes', () => {
    expect(new Set(IDS.map(hashString)).size).toBe(IDS.length)
  })
})

describe('assignSlots', () => {
  it('assigns every mine an authored-site index within range', () => {
    const slots = assignSlots(IDS)
    expect(slots.size).toBe(IDS.length)
    for (const index of slots.values()) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(MAP_SPAWN_SITE_COUNT)
    }
  })

  it('produces no collisions while mines fit on the authored sites', () => {
    const limit = Math.min(IDS.length, MAP_SPAWN_SITE_COUNT)
    for (let count = 1; count <= limit; count++) {
      const slots = assignSlots(IDS.slice(0, count))
      expect(new Set(slots.values()).size).toBe(count)
    }
  })

  it('is stable across refreshes with the same ids', () => {
    expect(assignSlots(IDS)).toEqual(assignSlots(IDS))
  })

  it('ignores input order (push-based refreshes may reorder mines)', () => {
    const shuffled = [...IDS].reverse()
    expect(assignSlots(shuffled)).toEqual(assignSlots(IDS))
  })

  it('keeps a mine on its hash-preferred site when nothing contests it', () => {
    const slots = assignSlots(IDS)
    const preferred = new Map(IDS.map((id) => [id, hashString(id) % MAP_SPAWN_SITE_COUNT]))
    const contested = new Set<number>()
    const seen = new Set<number>()
    for (const index of preferred.values()) {
      if (seen.has(index)) contested.add(index)
      seen.add(index)
    }
    for (const id of IDS) {
      const want = preferred.get(id) as number
      if (!contested.has(want)) expect(slots.get(id)).toBe(want)
    }
  })

  it('still returns a site for every mine when there are more mines than sites', () => {
    const many = [...IDS, ...IDS.map((id) => `${id}/overflow`)]
    const slots = assignSlots(many)
    expect(slots.size).toBe(many.length)
    for (const index of slots.values()) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(MAP_SPAWN_SITE_COUNT)
    }
  })

  it('handles the empty landscape', () => {
    expect(assignSlots([]).size).toBe(0)
  })
})
