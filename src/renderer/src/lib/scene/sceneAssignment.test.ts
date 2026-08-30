import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus } from '../../types'
import { SHARE_SPREAD_X, anchorKindFor, assignScene, type SceneOccupant } from './sceneAssignment'
import { CAVE_LAYOUT, anchorsOfKind, isWalkable, type SceneLayout } from './sceneLayout'

function occupant(
  id: string,
  status: DwarfStatus = 'working',
  role: DwarfRole = 'worker'
): SceneOccupant {
  return { id, status, role }
}

function anchorIds(placements: Map<string, { anchor: { id: string } }>): Record<string, string> {
  return Object.fromEntries([...placements].map(([id, place]) => [id, place.anchor.id]))
}

describe('anchorKindFor', () => {
  it('sends a working miner to a vein and a working foreman to his post', () => {
    expect(anchorKindFor('working', 'worker')).toBe('vein')
    expect(anchorKindFor('working', 'foreman')).toBe('post')
  })

  it('sends anyone who is waiting to the rest area, foreman included', () => {
    expect(anchorKindFor('waiting', 'worker')).toBe('rest')
    expect(anchorKindFor('waiting', 'foreman')).toBe('rest')
  })

  /*
    Today a leaving dwarf fades where it stands. The exit is a real painted
    place, so leaving has to mean walking to it (issue #19).
  */
  it('sends anyone who is leaving to the exit, whatever their rank', () => {
    expect(anchorKindFor('leaving', 'worker')).toBe('exit')
    expect(anchorKindFor('leaving', 'foreman')).toBe('exit')
  })
})

describe('assignScene', () => {
  it('places every dwarf it is given', () => {
    const crew = [
      occupant('claude:a'),
      occupant('claude:b', 'waiting'),
      occupant('claude:c', 'leaving'),
      occupant('claude:d', 'working', 'foreman')
    ]
    const placements = assignScene(crew, CAVE_LAYOUT)
    expect(placements.size).toBe(4)
    for (const dwarf of crew) expect(placements.has(dwarf.id), dwarf.id).toBe(true)
  })

  it('places nobody for an empty crew', () => {
    expect(assignScene([], CAVE_LAYOUT).size).toBe(0)
  })

  it('gives each dwarf an anchor of the kind its status calls for', () => {
    const crew = [
      occupant('claude:a'),
      occupant('claude:b', 'waiting'),
      occupant('claude:c', 'leaving'),
      occupant('claude:d', 'working', 'foreman')
    ]
    const placements = assignScene(crew, CAVE_LAYOUT)
    expect(placements.get('claude:a')?.anchor.kind).toBe('vein')
    expect(placements.get('claude:b')?.anchor.kind).toBe('rest')
    expect(placements.get('claude:c')?.anchor.kind).toBe('exit')
    expect(placements.get('claude:d')?.anchor.kind).toBe('post')
  })

  it('stands a dwarf that has its anchor to itself exactly on the painted feature', () => {
    const placements = assignScene([occupant('claude:only')], CAVE_LAYOUT)
    const placement = placements.get('claude:only')
    expect(placement?.shareCount).toBe(1)
    expect(placement?.point).toEqual({ x: placement?.anchor.x, y: placement?.anchor.y })
    expect(placement?.facesLeft).toBe(placement?.anchor.facesLeft)
  })

  it('keeps every dwarf on the walkable floor', () => {
    const crew = Array.from({ length: 14 }, (_, index) => occupant(`claude:w${index}`))
    for (const placement of assignScene(crew, CAVE_LAYOUT).values()) {
      expect(isWalkable(CAVE_LAYOUT.band, placement.point), placement.anchor.id).toBe(true)
    }
  })

  /*
    The panel re-polls every couple of seconds and hands the renderer a brand
    new list each time. Anything but a pure function of the ids would make
    dwarfs teleport between polls (the same reason `assignSlots` exists for
    mines on the map).
  */
  describe('determinism', () => {
    const crew = ['claude:a', 'codex:b', 'claude:c', 'codex:d', 'claude:e'].map((id) =>
      occupant(id)
    )

    it('returns the same anchors for the same crew every time', () => {
      expect(anchorIds(assignScene(crew, CAVE_LAYOUT))).toEqual(
        anchorIds(assignScene(crew, CAVE_LAYOUT))
      )
    })

    it('ignores the order the poll happened to deliver the crew in', () => {
      const shuffled = [...crew].reverse()
      expect(anchorIds(assignScene(shuffled, CAVE_LAYOUT))).toEqual(
        anchorIds(assignScene(crew, CAVE_LAYOUT))
      )
    })

    it('does not move a working miner when a foreman or a leaver appears', () => {
      const before = anchorIds(assignScene(crew, CAVE_LAYOUT))
      const after = anchorIds(
        assignScene(
          [...crew, occupant('claude:boss', 'working', 'foreman'), occupant('codex:z', 'leaving')],
          CAVE_LAYOUT
        )
      )
      for (const dwarf of crew) expect(after[dwarf.id], dwarf.id).toBe(before[dwarf.id])
    })
  })

  /*
    There are four veins and a mine can easily run more sessions than that, so
    sharing has to be graceful rather than a pile-up on one rock.
  */
  describe('sharing a work spot', () => {
    const veinCount = anchorsOfKind(CAVE_LAYOUT, 'vein').length
    const crew = Array.from({ length: veinCount * 2 }, (_, index) => occupant(`claude:w${index}`))
    const placements = assignScene(crew, CAVE_LAYOUT)

    it('fills every vein before doubling up on any of them', () => {
      const used = new Set([...placements.values()].map((place) => place.anchor.id))
      expect(used.size).toBe(veinCount)
    })

    it('tells each sharer how many are on the rock with it', () => {
      for (const placement of placements.values()) {
        expect(placement.shareCount).toBe(2)
        expect(placement.shareIndex).toBeGreaterThanOrEqual(0)
        expect(placement.shareIndex).toBeLessThan(placement.shareCount)
      }
    })

    it('spreads sharers sideways so two dwarfs never occupy one spot', () => {
      const byAnchor = new Map<string, number[]>()
      for (const placement of placements.values()) {
        byAnchor.set(placement.anchor.id, [
          ...(byAnchor.get(placement.anchor.id) ?? []),
          placement.point.x
        ])
      }
      for (const [anchorId, xs] of byAnchor) {
        expect(xs.length, anchorId).toBe(2)
        expect(new Set(xs).size, anchorId).toBe(xs.length)
        const [low = 0, high = 0] = [...xs].sort((a, b) => a - b)
        expect(high - low, anchorId).toBeCloseTo(SHARE_SPREAD_X)
      }
    })

    it('keeps the sharers centred on the feature rather than drifting off it', () => {
      for (const placement of placements.values()) {
        expect(Math.abs(placement.point.x - placement.anchor.x)).toBeLessThanOrEqual(SHARE_SPREAD_X)
        expect(placement.point.y).toBe(placement.anchor.y)
      }
    })
  })

  it('falls back to any anchor rather than dropping a dwarf a layout has no spot for', () => {
    // A hypothetical re-authored interior with no foreman post must still place
    // the foreman somewhere on its floor, not leave him unrendered.
    const postless: SceneLayout = {
      band: CAVE_LAYOUT.band,
      anchors: anchorsOfKind(CAVE_LAYOUT, 'vein') as unknown as SceneLayout['anchors']
    }
    const placements = assignScene([occupant('claude:boss', 'working', 'foreman')], postless)
    expect(placements.size).toBe(1)
    for (const placement of placements.values()) {
      expect(isWalkable(postless.band, placement.point)).toBe(true)
    }
  })
})
