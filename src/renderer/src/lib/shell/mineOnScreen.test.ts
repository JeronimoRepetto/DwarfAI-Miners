import { describe, expect, it } from 'vitest'
import { mineOnScreen } from './mineOnScreen'

/**
 * Which mine INTERIOR is actually on screen (#316) — the reading the shell
 * reports to main, so main can hold its "never notify about the mine the
 * person is looking at" rule.
 */
describe('mineOnScreen', () => {
  it('names the mine when the shell is holding one open and drawing its column', () => {
    expect(mineOnScreen('m1', { mineOpen: true })).toBe('m1')
  })

  it('is nothing when no mine is held open at all', () => {
    expect(mineOnScreen(null, { mineOpen: true })).toBe(null)
    expect(mineOnScreen(null, { mineOpen: false })).toBe(null)
  })

  it('is nothing for a mine held open behind a collapsed shell', () => {
    // A column with no width draws nothing, so a mine the view is still holding
    // is not something a person can see — and #316's rule is about what is
    // visible. AMENDED for #635: the bare rail this was written for is gone; the
    // view still holds a mine a moment before main has given its column width.
    // The two facts come from different owners: `mineId` is the shell's own
    // navigation, `mineOpen` is main's report that the column has width.
    expect(mineOnScreen('m1', { mineOpen: false })).toBe(null)
  })
})
