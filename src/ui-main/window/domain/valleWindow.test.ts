// layer: L1
import { describe, expect, it } from 'vitest'
import { VALLE_BOUNDS } from '@dwarfai/contracts'
import {
  enterValle,
  nextValleWindow,
  refitValle,
  type ValleDisplay,
  type ValleNode
} from './valleWindow'

/**
 * Machine 39 (07, VA11 The Valle window), UI main's half: where Valle opens (the work area of the display matching the
 * window it is entered from, OQ-20; §24 I-35 for a launch), what a display event does to it (S39.08, S39.09; §24 I-37),
 * and the transitions 07 lists for it. The reveal (S39.06, S39.07) is ISSUE-311's.
 */
const LEFT: ValleDisplay = {
  displayKey: 'DELL U2720Q|3840x2160|@2|0,0',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  primary: true
}
const RIGHT: ValleDisplay = {
  displayKey: 'LG HDR 4K|2560x1440|@1|1920,0',
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
  primary: false
}
/** The Panel docked at the right edge of the RIGHT display, and Veta at the bottom of the LEFT one. */
const PANEL_ON_RIGHT = { x: 4060, y: 0, width: 420, height: 1400 }
const VETA_ON_LEFT = { x: 720, y: 968, width: 480, height: 72 }
const NOT_CREATED: ValleNode = { state: 'not-created' }

describe('machine 39 diagram conformance', () => {
  it('[US-VALLE-001.AC10, S39.01, S39.02] Valle opens on the display matching the window it is entered from, with no placement of its own', () => {
    expect(VALLE_BOUNDS).toBe('work-area')
    // S39.01: the first entry, from the Panel on the RIGHT display, the one that is not the primary.
    const first = enterValle(NOT_CREATED, { from: 'window', bounds: PANEL_ON_RIGHT }, [LEFT, RIGHT])
    expect(first).toEqual({
      ok: true,
      value: {
        id: 'S39.01',
        to: { state: 'opening' },
        place: { displayKey: RIGHT.displayKey, bounds: RIGHT.workArea }
      }
    })
    // Shown, then left: hidden, and nothing about where it was is kept.
    const shown = nextValleWindow({ state: 'opening' }, { type: 'stores-read', unreadable: false })
    expect(shown).toEqual({ ok: true, value: { id: 'S39.03', to: { state: 'shown' } } })
    const hidden = nextValleWindow({ state: 'shown' }, { type: 'left' })
    expect(hidden).toEqual({ ok: true, value: { id: 'S39.04', to: { state: 'hidden' } } })
    // S39.02: entered again, from Veta on the LEFT display: Valle follows it there, its last display forgotten.
    const again = enterValle({ state: 'hidden' }, { from: 'window', bounds: VETA_ON_LEFT }, [
      LEFT,
      RIGHT
    ])
    expect(again).toEqual({
      ok: true,
      value: {
        id: 'S39.02',
        to: { state: 'opening' },
        place: { displayKey: LEFT.displayKey, bounds: LEFT.workArea }
      }
    })
    // A window lying across both displays goes to the one holding most of it.
    const across = enterValle(
      { state: 'hidden' },
      { from: 'window', bounds: { x: 1800, y: 0, width: 420, height: 900 } },
      [LEFT, RIGHT]
    )
    expect(across.ok && across.value.place.displayKey).toBe(RIGHT.displayKey)
  })

  it("[S39.01] a launch straight into Valle with no source window opens on the display of the Panel's stored place, else the primary", () => {
    const stored = enterValle(NOT_CREATED, { from: 'launch', panelPlace: PANEL_ON_RIGHT }, [
      LEFT,
      RIGHT
    ])
    expect(stored.ok && stored.value).toEqual({
      id: 'S39.01',
      to: { state: 'opening' },
      place: { displayKey: RIGHT.displayKey, bounds: RIGHT.workArea }
    })
    // No stored place of the Panel: the primary display, whichever is listed first.
    const none = enterValle(NOT_CREATED, { from: 'launch', panelPlace: null }, [RIGHT, LEFT])
    expect(none.ok && none.value.place).toEqual({
      displayKey: LEFT.displayKey,
      bounds: LEFT.workArea
    })
    // A stored place on a display no longer connected: the primary too.
    const gone = enterValle(NOT_CREATED, { from: 'launch', panelPlace: PANEL_ON_RIGHT }, [LEFT])
    expect(gone.ok && gone.value.place.displayKey).toBe(LEFT.displayKey)
  })

  it('[S39.08, S39.09] an unplugged display re-places Valle on the display matching its bounds and a work-area change refits it', () => {
    // S39.08: Valle on the RIGHT display, which is unplugged: the display now matching its bounds is the primary.
    expect(nextValleWindow({ state: 'shown' }, { type: 'display-removed' })).toEqual({
      ok: true,
      value: { id: 'S39.08', to: { state: 'shown' } }
    })
    expect(refitValle(RIGHT.workArea, [LEFT])).toEqual({
      displayKey: LEFT.displayKey,
      bounds: LEFT.workArea
    })
    // S39.09: the taskbar of its display grew: the bounds refit to the new work area of the same display.
    const shorter: ValleDisplay = {
      ...RIGHT,
      workArea: { x: 1920, y: 0, width: 2560, height: 1360 }
    }
    expect(nextValleWindow({ state: 'shown' }, { type: 'work-area-changed' })).toEqual({
      ok: true,
      value: { id: 'S39.09', to: { state: 'shown' } }
    })
    expect(refitValle(RIGHT.workArea, [LEFT, shorter])).toEqual({
      displayKey: RIGHT.displayKey,
      bounds: shorter.workArea
    })
  })

  it('[S39.04, S39.10, S39.12, S39.13] hiding, Reset metrics, a UI exit and an unreadable store follow 07 machine 39', () => {
    // S39.13: a store unreadable at restore still opens, on its defaults.
    expect(
      nextValleWindow({ state: 'opening' }, { type: 'stores-read', unreadable: true })
    ).toEqual({ ok: true, value: { id: 'S39.13', to: { state: 'shown' } } })
    // S39.04: leaving Valle or hiding.
    expect(nextValleWindow({ state: 'shown' }, { type: 'left' })).toEqual({
      ok: true,
      value: { id: 'S39.04', to: { state: 'hidden' } }
    })
    // S39.10: Reset metrics, shown or hidden, keeps the state.
    for (const state of ['shown', 'hidden'] as const) {
      expect(nextValleWindow({ state }, { type: 'reset' }), state).toEqual({
        ok: true,
        value: { id: 'S39.10', to: { state } }
      })
    }
    // S39.11: an arrival in a mine not on screen keeps Valle shown.
    expect(nextValleWindow({ state: 'shown' }, { type: 'arrival-off-screen' })).toEqual({
      ok: true,
      value: { id: 'S39.11', to: { state: 'shown' } }
    })
    // S39.05: a viewport change re-reports, shown.
    expect(nextValleWindow({ state: 'shown' }, { type: 'viewport-changed' })).toEqual({
      ok: true,
      value: { id: 'S39.05', to: { state: 'shown' } }
    })
    // S39.12: a UI exit from any state ends with no window.
    for (const state of ['hidden', 'opening', 'shown', 'revealing'] as const) {
      expect(nextValleWindow({ state }, { type: 'ui-exit' }), state).toEqual({
        ok: true,
        value: { id: 'S39.12', to: { state: 'not-created' } }
      })
    }
  })

  it('[ADR-025] a transition not listed in 07 machine 39 is rejected', () => {
    const refused = { ok: false, error: 'not-listed' }
    // Hidden reports nothing and hears no display or arrival rows of its own; never created has nothing to hide.
    expect(nextValleWindow(NOT_CREATED, { type: 'left' })).toEqual(refused)
    expect(nextValleWindow({ state: 'hidden' }, { type: 'viewport-changed' })).toEqual(refused)
    expect(nextValleWindow({ state: 'hidden' }, { type: 'display-removed' })).toEqual(refused)
    expect(nextValleWindow({ state: 'hidden' }, { type: 'arrival-off-screen' })).toEqual(refused)
    expect(nextValleWindow({ state: 'shown' }, { type: 'stores-read', unreadable: false })).toEqual(
      refused
    )
    expect(nextValleWindow(NOT_CREATED, { type: 'reset' })).toEqual(refused)
    // An entry while it is opening or shown is not a machine 39 row: the coordinator answers it (S27.09).
    expect(enterValle({ state: 'shown' }, { from: 'launch', panelPlace: null }, [LEFT])).toEqual(
      refused
    )
    expect(enterValle({ state: 'opening' }, { from: 'launch', panelPlace: null }, [LEFT])).toEqual(
      refused
    )
  })
})
