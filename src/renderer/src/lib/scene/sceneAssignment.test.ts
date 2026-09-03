import { describe, expect, it } from 'vitest'
import type { DwarfRole, DwarfStatus } from '../../types'
import { SHARE_SPREAD_X, anchorKindFor, assignScene, type SceneOccupant } from './sceneAssignment'
import { INTERIOR_LAYOUT, anchorsOfKind, type SceneLayout } from './sceneLayout'

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen: the two
 * cases that held every placement on the walkable floor ("keeps every dwarf on
 * the walkable floor", and the floor assertion inside "falls back to any anchor
 * rather than dropping a dwarf"), and "sends anyone who is waiting to the rest
 * area, foreman included". `isWalkable` and the trapezoid it tested went with
 * the perspective gallery, and the design's spatial map has no rest class — a
 * waiting dwarf now sleeps at his own workstation, which is what the sleeping
 * frames draw. What the floor cases guaranteed (a placement is always a real
 * point on the painting) did not go with them: `clampToPainting` is pinned in
 * sceneLayout.test.ts, and the fallback case below still checks that a dwarf a
 * layout has no spot for is placed rather than dropped.
 */

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
  it('sends a working miner to a worker station and a foreman to a foreman one', () => {
    expect(anchorKindFor('working', 'worker')).toBe('worker')
    expect(anchorKindFor('working', 'foreman')).toBe('foreman')
  })

  /*
    The design's spatial map draws no rest area, and the sleeping frames draw a
    dwarf asleep where he was working rather than one who walked off to a bunk.
    So waiting changes the animation, not the place.
  */
  it('leaves a waiting dwarf at the station its rank works, rather than moving it', () => {
    expect(anchorKindFor('waiting', 'worker')).toBe('worker')
    expect(anchorKindFor('waiting', 'foreman')).toBe('foreman')
  })

  /*
    A leaving dwarf walks out rather than fading where it stands (issue #19).
    The way out is the way in, and the design marks three of them up the shaft
    rather than one door at the bottom, so a leaver heads for a spawn circle.
  */
  it('sends anyone who is leaving back to a spawn point, whatever their rank', () => {
    expect(anchorKindFor('leaving', 'worker')).toBe('spawn')
    expect(anchorKindFor('leaving', 'foreman')).toBe('spawn')
  })

  /*
    #157's ruling on the new rank, pinned rather than left to fall out of a
    ternary: a worker2 shares the WORKER's locations and the worker's whole
    lifecycle. It digs at the same triangles, rests at them, and walks out of the
    same spawn circles. No worker2 anchor kind was added and none should be —
    the design's spatial map draws spawn circles, worker triangles and foreman
    diamonds, and a fourth marker would need a re-authored interior to mean
    anything.
  */
  it('works a worker2 at the same stations a worker uses, and out the same way', () => {
    expect(anchorKindFor('working', 'worker2')).toBe('worker')
    expect(anchorKindFor('waiting', 'worker2')).toBe('worker')
    expect(anchorKindFor('leaving', 'worker2')).toBe('spawn')
  })

  it('gives the foreman diamond to the foreman alone', () => {
    // The shape of the rule, not a list: one post per mine means one supervisor
    // per mine in the art's own vocabulary, so a rank added later has to argue
    // its way onto that diamond rather than land on it by default.
    for (const role of ['worker', 'worker2'] satisfies DwarfRole[]) {
      expect(anchorKindFor('working', role), role).not.toBe('foreman')
    }
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
    const placements = assignScene(crew, INTERIOR_LAYOUT)
    expect(placements.size).toBe(4)
    for (const dwarf of crew) expect(placements.has(dwarf.id), dwarf.id).toBe(true)
  })

  it('places nobody for an empty crew', () => {
    expect(assignScene([], INTERIOR_LAYOUT).size).toBe(0)
  })

  it('gives each dwarf an anchor of the kind its status calls for', () => {
    const crew = [
      occupant('claude:a'),
      occupant('claude:b', 'waiting'),
      occupant('claude:c', 'leaving'),
      occupant('claude:d', 'working', 'foreman')
    ]
    const placements = assignScene(crew, INTERIOR_LAYOUT)
    expect(placements.get('claude:a')?.anchor.kind).toBe('worker')
    expect(placements.get('claude:b')?.anchor.kind).toBe('worker')
    expect(placements.get('claude:c')?.anchor.kind).toBe('spawn')
    expect(placements.get('claude:d')?.anchor.kind).toBe('foreman')
  })

  it('stands a dwarf that has its anchor to itself exactly on the painted feature', () => {
    const placements = assignScene([occupant('claude:only')], INTERIOR_LAYOUT)
    const placement = placements.get('claude:only')
    expect(placement?.shareCount).toBe(1)
    expect(placement?.point).toEqual({ x: placement?.anchor.x, y: placement?.anchor.y })
    expect(placement?.facesLeft).toBe(placement?.anchor.facesLeft)
  })

  it('keeps every dwarf on the painting, however crowded the mine gets', () => {
    const crew = Array.from({ length: 40 }, (_, index) => occupant(`claude:w${index}`))
    for (const placement of assignScene(crew, INTERIOR_LAYOUT).values()) {
      expect(placement.point.x, placement.anchor.id).toBeGreaterThanOrEqual(0)
      expect(placement.point.x, placement.anchor.id).toBeLessThanOrEqual(100)
      expect(placement.point.y, placement.anchor.id).toBeGreaterThanOrEqual(0)
      expect(placement.point.y, placement.anchor.id).toBeLessThanOrEqual(100)
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
      expect(anchorIds(assignScene(crew, INTERIOR_LAYOUT))).toEqual(
        anchorIds(assignScene(crew, INTERIOR_LAYOUT))
      )
    })

    it('ignores the order the poll happened to deliver the crew in', () => {
      const shuffled = [...crew].reverse()
      expect(anchorIds(assignScene(shuffled, INTERIOR_LAYOUT))).toEqual(
        anchorIds(assignScene(crew, INTERIOR_LAYOUT))
      )
    })

    it('does not move a working miner when a foreman or a leaver appears', () => {
      const before = anchorIds(assignScene(crew, INTERIOR_LAYOUT))
      const after = anchorIds(
        assignScene(
          [...crew, occupant('claude:boss', 'working', 'foreman'), occupant('codex:z', 'leaving')],
          INTERIOR_LAYOUT
        )
      )
      for (const dwarf of crew) expect(after[dwarf.id], dwarf.id).toBe(before[dwarf.id])
    })
  })

  /*
    There are eighteen worker stations and a mine can run more sessions than
    that, so sharing has to be graceful rather than a pile-up on one rock.
  */
  describe('sharing a work spot', () => {
    const stationCount = anchorsOfKind(INTERIOR_LAYOUT, 'worker').length
    const crew = Array.from({ length: stationCount * 2 }, (_, index) =>
      occupant(`claude:w${index}`)
    )
    const placements = assignScene(crew, INTERIOR_LAYOUT)

    it('fills every station before doubling up on any of them', () => {
      const used = new Set([...placements.values()].map((place) => place.anchor.id))
      expect(used.size).toBe(stationCount)
    })

    /*
      AMENDED with the interior (#137): this used to assert `shareCount === 2`
      exactly. That was never a guarantee `assignSlots` makes — the overflow
      lands on its own hash-preferred slot rather than being levelled out — it
      just happened to hold at the cave's four veins. Eighteen stations expose
      it, so the case now pins what the sharing contract actually promises:
      every sharer knows how many it is with, and its own place in that group.
    */
    it('tells each sharer how many are on the rock with it', () => {
      const byAnchor = new Map<string, number>()
      for (const placement of placements.values()) {
        byAnchor.set(placement.anchor.id, (byAnchor.get(placement.anchor.id) ?? 0) + 1)
      }
      for (const placement of placements.values()) {
        expect(placement.shareCount).toBe(byAnchor.get(placement.anchor.id))
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
        expect(new Set(xs).size, anchorId).toBe(xs.length)
        const sorted = [...xs].sort((a, b) => a - b)
        for (let index = 1; index < sorted.length; index++) {
          expect((sorted[index] as number) - (sorted[index - 1] as number), anchorId).toBeCloseTo(
            SHARE_SPREAD_X
          )
        }
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
    // A hypothetical re-extracted interior with no foreman diamond must still
    // place the foreman somewhere in the mine, not leave him unrendered.
    const postless: SceneLayout = {
      anchors: anchorsOfKind(INTERIOR_LAYOUT, 'worker') as unknown as SceneLayout['anchors']
    }
    const placements = assignScene([occupant('claude:boss', 'working', 'foreman')], postless)
    expect(placements.size).toBe(1)
    for (const placement of placements.values()) {
      expect(postless.anchors).toContain(placement.anchor)
    }
  })
})
