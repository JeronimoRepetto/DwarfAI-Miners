import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../types'
import {
  ADD_ICON_SRC,
  CLOSE_ICON_SRC,
  DIALOG_ICON_SRC,
  MAP_ART_SIZE,
  MAP_BG_SRC,
  NUGGET_SRC,
  SLEEP_ICON_SRC,
  SORT_ICON_SRC
} from './art'
import { MAP_TIME_VARIANTS } from './map/mapTime'

/*
 * art.ts resolves every painting to a bundled URL through explicit imports, so
 * a missing or renamed file fails the build rather than rendering as a broken
 * image. The one thing that check cannot catch is a material with no entry in
 * the table at all — the record would simply be short, and the pile for that
 * material would render `undefined` as its src. Hence this test.
 */
describe('NUGGET_SRC', () => {
  it('has a painted nugget for every material the vault can hold', () => {
    for (const material of MATERIALS) {
      expect(NUGGET_SRC[material], `no nugget art keyed for ${material}`).toBeTruthy()
    }
  })

  /*
   * Iron was painted before bronze arrived and is committed to the tree. No
   * tier produces it, so the vault never carries it — but keeping it keyed
   * means a future tier below bronze costs no new art, and it is cheaper to
   * carry one 19 KB painting than to pretend a committed asset does not exist.
   */
  it('also keys the painted iron nugget, which no tier produces yet', () => {
    expect(NUGGET_SRC.iron).toBeTruthy()
  })

  it('gives each material its own painting rather than reusing one', () => {
    const sources = Object.values(NUGGET_SRC)
    expect(new Set(sources).size).toBe(sources.length)
  })
})

/*
 * The same gap the nugget table has, and one more: the four map paintings are
 * keyed by a time-of-day variant, and three of the four committed files carry a
 * typo in their own name (`sunerise`, `suneset`, `nigth`). An import typed one
 * letter differently fails the build; a variant left out of the record does
 * not, and would draw the map as a broken image for four hours a day.
 */
describe('MAP_BG_SRC', () => {
  it('has a painting for every time-of-day variant', () => {
    for (const variant of MAP_TIME_VARIANTS) {
      expect(MAP_BG_SRC[variant], `no map art keyed for ${variant}`).toBeTruthy()
    }
  })

  it('gives each variant its own painting rather than reusing one', () => {
    const sources = Object.values(MAP_BG_SRC)
    expect(new Set(sources).size).toBe(MAP_TIME_VARIANTS.length)
  })

  /*
   * All four paintings are the same size, which is what lets one authored
   * spawn point serve every variant — the design says so ("all time-of-day maps
   * are symmetric, so the same stored coordinate applies across variants") and
   * the four committed files agree, at 1856x2304 each.
   */
  it('states the pixel size the cover projection measures against', () => {
    expect(MAP_ART_SIZE).toEqual({ width: 1856, height: 2304 })
  })
})

/*
 * The Mines panel's own glyphs (#135). Same reasoning as SHELL_ICON_SRC: they
 * are the designer's committed SVGs at the path the source names, resolved
 * through explicit imports so a renamed file fails the build instead of
 * rendering as an empty masked square nobody notices.
 */
describe('browse and status icons', () => {
  it.each([
    ['SORT_ICON_SRC', SORT_ICON_SRC],
    ['ADD_ICON_SRC', ADD_ICON_SRC],
    ['DIALOG_ICON_SRC', DIALOG_ICON_SRC],
    ['SLEEP_ICON_SRC', SLEEP_ICON_SRC]
  ])('resolves %s to a bundled url', (_name, src) => {
    expect(src).toBeTruthy()
  })

  it('gives each glyph its own file rather than reusing one', () => {
    const sources = [SORT_ICON_SRC, ADD_ICON_SRC, DIALOG_ICON_SRC, SLEEP_ICON_SRC, CLOSE_ICON_SRC]
    expect(new Set(sources).size).toBe(sources.length)
  })
})
