import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../types'
import {
  ADD_ICON_SRC,
  CLOSE_ICON_SRC,
  DIALOG_ICON_SRC,
  NUGGET_SRC,
  SLEEP_ICON_SRC,
  SORT_ICON_SRC
} from './art'

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
