import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../types'
import { NUGGET_SRC } from './art'

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
