import { describe, expect, it } from 'vitest'
import { MAP_SPAWN_SITE_COUNT } from '../domain/types'
import { chooseMapSite } from './mapSite'

/** A scripted random source, so "random" is assertable rather than hoped at. */
function scripted(...fractions: number[]): () => number {
  let index = 0
  return () => fractions[index++ % fractions.length]!
}

describe('chooseMapSite', () => {
  it('places the first mine somewhere among the design’s spawn locations', () => {
    const site = chooseMapSite(new Set(), scripted(0.5))
    expect(site).toBeGreaterThanOrEqual(1)
    expect(site).toBeLessThanOrEqual(MAP_SPAWN_SITE_COUNT)
  })

  it('never hands out a location another mine already holds', () => {
    const occupied = new Set<number>()
    const random = scripted(0.1, 0.9, 0.42, 0, 0.77, 0.31, 0.66)
    for (let placed = 0; placed < MAP_SPAWN_SITE_COUNT; placed++) {
      const site = chooseMapSite(occupied, random)
      expect(site, `after ${placed} placements`).not.toBeNull()
      expect(occupied.has(site!)).toBe(false)
      occupied.add(site!)
    }
    expect(occupied.size).toBe(MAP_SPAWN_SITE_COUNT)
  })

  /*
    The design asks for this in as many words — "assignment must avoid
    sequential placement patterns so the distribution feels organic" — and the
    obvious wrong implementation passes every test above: taking the lowest free
    id fills the map in order, 1, 2, 3, and draws a line of mines down the
    painting. So what is checked is that the choice actually consults the source
    it was given.
  */
  it('does not fill the map in id order', () => {
    const occupied = new Set<number>()
    const random = scripted(0.87, 0.12, 0.55, 0.03, 0.71, 0.38)
    const chosen: number[] = []
    for (let placed = 0; placed < 6; placed++) {
      const site = chooseMapSite(occupied, random)!
      occupied.add(site)
      chosen.push(site)
    }
    expect(chosen).not.toEqual([...chosen].sort((a, b) => a - b))
    expect(chosen).not.toEqual([1, 2, 3, 4, 5, 6])
  })

  it('spreads a run of placements over the whole map rather than one corner', () => {
    /*
      A uniform draw is the whole mechanism, so this is what it should produce:
      twenty placements from a source that walks the unit interval must not all
      land in one half of the site list.
    */
    const occupied = new Set<number>()
    const random = scripted(0.05, 0.95, 0.5, 0.25, 0.75, 0.13, 0.61, 0.88, 0.37, 0.02)
    const chosen: number[] = []
    for (let placed = 0; placed < 20; placed++) {
      const site = chooseMapSite(occupied, random)!
      occupied.add(site)
      chosen.push(site)
    }
    const half = MAP_SPAWN_SITE_COUNT / 2
    expect(chosen.some((site) => site <= half)).toBe(true)
    expect(chosen.some((site) => site > half)).toBe(true)
  })

  /*
    Two projects must never share a location, says the design — which stops
    being possible at the seventy-fifth project. Answering "no location" is the
    honest end of that rule: nothing is written, and the panel falls back to
    placing the mine itself. Inventing a duplicate would break the invariant
    silently and permanently, in the persisted row.
  */
  it('answers with no location at all once every one is taken', () => {
    const everySite = new Set(Array.from({ length: MAP_SPAWN_SITE_COUNT }, (_, index) => index + 1))
    expect(chooseMapSite(everySite, scripted(0.5))).toBeNull()
  })

  it('ignores an occupied id that is not a location on this map', () => {
    // A row written by a build with more sites, or a hand-edited database. It
    // occupies nothing here, so it must not shrink the valley by one.
    const occupied = new Set(Array.from({ length: MAP_SPAWN_SITE_COUNT }, (_, index) => index + 1))
    occupied.delete(7)
    occupied.add(9_999)
    expect(chooseMapSite(occupied, scripted(0.99))).toBe(7)
  })

  it('stays inside the map for a random source that returns exactly 1', () => {
    // Math.random() never returns 1, but a source is injected here and a
    // fraction of 1 must not index one past the last free site.
    const site = chooseMapSite(new Set(), scripted(1))
    expect(site).toBe(MAP_SPAWN_SITE_COUNT)
  })
})
