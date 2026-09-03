import { describe, expect, it } from 'vitest'
import { shellComposition } from './composition'

describe('shellComposition', () => {
  it('is the rail when neither page is drawn', () => {
    expect(shellComposition({ expanded: false, mineOpen: false })).toBe('rail')
  })

  it('is the mine when the left page is closed and a mine is held open', () => {
    expect(shellComposition({ expanded: false, mineOpen: true })).toBe('mine')
  })

  it('is the pages whenever the left page is open, with or without a mine', () => {
    expect(shellComposition({ expanded: true, mineOpen: false })).toBe('pages')
    expect(shellComposition({ expanded: true, mineOpen: true })).toBe('pages')
  })

  /*
   * The whole reason this function exists (#156). The shell used to read
   * `expanded` alone, so the mine-only composition was classified as the closed
   * rail: no ground, no padding, no frame — and the rail went on drawing the app
   * mark beside the navigation stack's own.
   */
  it('separates the rail from the mine-only page, which the open flag alone cannot', () => {
    expect(shellComposition({ expanded: false, mineOpen: true })).not.toBe(
      shellComposition({ expanded: false, mineOpen: false })
    )
  })

  it('draws the panel for both pages and refuses it to the bare rail', () => {
    expect(shellComposition({ expanded: false, mineOpen: true })).not.toBe('rail')
    expect(shellComposition({ expanded: true, mineOpen: false })).not.toBe('rail')
  })
})
