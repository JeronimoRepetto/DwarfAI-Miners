import { describe, expect, it } from 'vitest'
import { MAP_SLOTS, assignSlots, hashString } from './placement'

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

describe('MAP_SLOTS', () => {
  it('provides at least 12 slots with percentage coordinates', () => {
    expect(MAP_SLOTS.length).toBeGreaterThanOrEqual(12)
    for (const slot of MAP_SLOTS) {
      expect(slot.x).toBeGreaterThanOrEqual(0)
      expect(slot.x).toBeLessThanOrEqual(100)
      expect(slot.y).toBeGreaterThanOrEqual(0)
      expect(slot.y).toBeLessThanOrEqual(100)
    }
  })

  it('never stacks two slots on the same point', () => {
    const keys = MAP_SLOTS.map((slot) => `${slot.x},${slot.y}`)
    expect(new Set(keys).size).toBe(MAP_SLOTS.length)
  })
})

describe('assignSlots', () => {
  it('assigns every mine a slot index within range', () => {
    const slots = assignSlots(IDS)
    expect(slots.size).toBe(IDS.length)
    for (const index of slots.values()) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(MAP_SLOTS.length)
    }
  })

  it('produces no collisions for up to 12 mines', () => {
    for (let count = 1; count <= 12; count++) {
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

  it('keeps a mine on its hash-preferred slot when nothing contests it', () => {
    const slots = assignSlots(IDS)
    const preferred = new Map(IDS.map((id) => [id, hashString(id) % MAP_SLOTS.length]))
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

  it('still returns a slot for every mine when there are more mines than slots', () => {
    const many = [...IDS, ...IDS.map((id) => `${id}/overflow`)]
    const slots = assignSlots(many)
    expect(slots.size).toBe(many.length)
    for (const index of slots.values()) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(MAP_SLOTS.length)
    }
  })

  it('handles the empty landscape', () => {
    expect(assignSlots([]).size).toBe(0)
  })
})
