import { describe, expect, it } from 'vitest'
import { SHELL_AREAS, SHELL_NAV, arrowDirection, isShellArea } from './shellNav'

describe('SHELL_NAV', () => {
  it('is the design order, top to bottom', () => {
    // Settings, Map, Mines, Lab, Market — written down in the source and drawn
    // in that order in every verified export. Not alphabetical, and not the
    // order the app happened to build them in.
    expect(SHELL_NAV.map((item) => item.area)).toEqual([
      'settings',
      'map',
      'mines',
      'lab',
      'market'
    ])
  })

  it('names every button, because an icon alone names nothing', () => {
    expect(SHELL_NAV.map((item) => item.label)).toEqual([
      'Settings',
      'Map',
      'Mines',
      'Lab',
      'Market'
    ])
  })

  it('gives every area exactly one entry', () => {
    expect(SHELL_NAV).toHaveLength(SHELL_AREAS.length)
    expect(new Set(SHELL_NAV.map((item) => item.area)).size).toBe(SHELL_NAV.length)
  })
})

describe('isShellArea', () => {
  it('accepts every area the nav offers', () => {
    for (const area of SHELL_AREAS) expect(isShellArea(area)).toBe(true)
  })

  it('rejects anything else', () => {
    for (const value of ['mine', 'Map', '', 'browse', null, 7]) {
      expect(isShellArea(value), `${String(value)}`).toBe(false)
    }
  })
})

/*
 * The arrow is the only thing on a 20px rail that says what pressing it will
 * do, so pointing it the wrong way points the user off the screen.
 *
 * Closed, it points the way the panel will OPEN — inward, away from the edge it
 * hangs on. Open, it points back at that edge, which is where the panel goes
 * when it collapses. Page 1 of the design source draws both closed rails, one
 * per edge, with the arrows mirrored; the expanded exports draw the other half.
 */
describe('arrowDirection', () => {
  it('points inward from the edge it is closed against', () => {
    expect(arrowDirection('right', false)).toBe('left')
    expect(arrowDirection('left', false)).toBe('right')
  })

  it('points back at its own edge once the panel is open', () => {
    expect(arrowDirection('right', true)).toBe('right')
    expect(arrowDirection('left', true)).toBe('left')
  })

  it('never points at the same side in both states', () => {
    for (const edge of ['left', 'right'] as const) {
      expect(arrowDirection(edge, false)).not.toBe(arrowDirection(edge, true))
    }
  })
})
