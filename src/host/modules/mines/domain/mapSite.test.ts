import { describe, expect, it } from 'vitest'
import { chooseMapSite, sameMapSite } from './mapSite'
import type { MapSite } from './mine'

const SITES: readonly MapSite[] = Array.from({ length: 6 }, (_, n) => ({
  xPct: 10 + n * 10,
  yPct: 20 + n * 5
}))

/** A scripted random source, so "random" is assertable rather than hoped at. */
function scripted(...fractions: number[]): () => number {
  let index = 0
  return () => fractions[index++ % fractions.length]!
}

describe('chooseMapSite (06 §4.1 MapSite; mapSite.ts rules)', () => {
  it('[US-MAP-004.AC01] a new mine gets a free site, never one another mine holds, until none is left', () => {
    const occupied: MapSite[] = []
    const random = scripted(0.1, 0.9, 0.42, 0, 0.77, 0.31)
    for (let placed = 0; placed < SITES.length; placed++) {
      const site = chooseMapSite(SITES, occupied, random)
      expect(site, `after ${placed} placements`).not.toBeNull()
      expect(occupied.some((taken) => sameMapSite(taken, site!))).toBe(false)
      occupied.push(site!)
    }
    expect(chooseMapSite(SITES, occupied, random)).toBeNull()
    expect(chooseMapSite([], [], random)).toBeNull()
  })

  it('[US-MAP-004.AC01] the pick follows the random source, not the order of the sites', () => {
    expect(chooseMapSite(SITES, [], () => 0.99)).toEqual(SITES[5])
    expect(chooseMapSite(SITES, [SITES[0]!], () => 0)).toEqual(SITES[1])
    // A source that answers exactly 1 still lands on the last free site, never past it.
    expect(chooseMapSite(SITES, [], () => 1)).toEqual(SITES[5])
  })
})
