import { describe, expect, it } from 'vitest'
import { SHELL_AREAS, UNAVAILABLE_AREAS, arrowDirection, unavailableAreaOf } from './shellNav'

/*
 * REMOVED for #635, stated here rather than passing unseen: the describe block
 * "SHELL_NAV" and its three cases — "is the design order, top to bottom",
 * "names every button, because an icon alone names nothing" and "gives every
 * area exactly one entry" — with this file's import of `SHELL_NAV`. The list
 * was the v4 nav's single stack of six, and it went with ShellNav.vue, its only
 * reader: the redesigned nav groups its slots into World, Guild and System.
 * The same three guarantees, for the groups, are in lib/shell/panelNav.test.ts.
 */

/*
 * REMOVED for #635 (PR3): the describe block "isShellArea" and its two cases, "accepts every area
 * the nav offers" and "rejects anything else". The guard's last caller went with ShellNav.vue in
 * PR1 and nothing read it since, so it went; the one test below that used it now reads the list
 * the guard read, SHELL_AREAS, directly.
 */

/*
 * Which areas the design ships as unavailable (#335).
 *
 * The shell used to decide this inline, as `area === 'lab' ? 'lab' : 'market'`
 * — a ternary that answers "market" for anything that is not the lab. With a
 * third unavailable area that shape starts naming the wrong hall, so the list
 * lives here and the answer is `undefined` for an area that has a screen.
 */
describe('unavailableAreaOf', () => {
  it('names each of the three areas the design ships as unavailable', () => {
    expect(unavailableAreaOf('lab')).toBe('lab')
    expect(unavailableAreaOf('market')).toBe('market')
    expect(unavailableAreaOf('laboral-union')).toBe('laboral-union')
  })

  it('answers for no area that has a screen of its own', () => {
    for (const area of ['settings', 'map', 'mines'] as const) {
      expect(unavailableAreaOf(area), area).toBeUndefined()
    }
  })

  // AMENDED for #635 (PR3): reads SHELL_AREAS itself (was: through isShellArea, now removed).
  it('keeps its list inside the areas the navigation offers', () => {
    for (const area of UNAVAILABLE_AREAS) expect(SHELL_AREAS).toContain(area)
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
