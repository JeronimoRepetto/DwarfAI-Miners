// layer: L1
import type { VetaDock } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  defaultVetaDock,
  dockAtPointer,
  land,
  placeOnDisplayChange,
  placeOnShow,
  resetVetaDocks,
  storeVetaDock,
  vetaBounds,
  type VetaDisplay,
  type VetaPlace
} from './vetaPlacement'

/**
 * Machine 21 (07, V2 Veta dock and drag), UI main's half: where the island is anchored on a display's work area, and
 * what each display event, landing and Reset metrics does to it. The renderer's half (press, drag, preview) is
 * `renderer/src/lib/veta/dockGesture.test.ts`.
 */
const PRIMARY: VetaDisplay = {
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  primary: true
}
const SECOND: VetaDisplay = {
  displayKey: 'PHL 243V7|1920x1080|@1|2560,357',
  bounds: { x: 2560, y: 357, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 357, width: 1920, height: 1032 },
  primary: false
}
const ISLAND = { length: 480, thickness: 72 }

describe('machine 21 diagram conformance (UI main)', () => {
  it('[US-VETA-002.AC02, S21.08, S21.09] a release snaps to the edge nearest the pointer, centred on the pointer and clamped to the work area', () => {
    const area = PRIMARY.workArea
    // Near the bottom, in the left half: the bottom edge, measured from its start, centred on the pointer.
    expect(dockAtPointer(area, { x: 700, y: 1380 }, ISLAND.length)).toEqual({
      edge: 'bottom',
      end: 'start',
      offset: 700 - 240
    })
    // Near the top, in the right half: measured from the end.
    expect(dockAtPointer(area, { x: 2000, y: 5 }, ISLAND.length)).toEqual({
      edge: 'top',
      end: 'end',
      offset: 2560 - 2000 - 240
    })
    // Near the left edge, low down: the left edge, measured from its bottom end.
    expect(dockAtPointer(area, { x: 3, y: 1000 }, ISLAND.length)).toEqual({
      edge: 'left',
      end: 'end',
      offset: 1392 - 1000 - 240
    })
    // Right in a corner: centring would push the island past it, so the offset is clamped to the work area.
    const corner = dockAtPointer(area, { x: 2550, y: 1385 }, ISLAND.length)
    expect(corner).toEqual({ edge: 'bottom', end: 'end', offset: 0 })
    // Over the taskbar (outside the work area): still the nearest edge, clamped, never away from an edge.
    const taskbar = dockAtPointer(area, { x: 1280, y: 1430 }, ISLAND.length)
    expect(taskbar.edge).toBe('bottom')
    // The window hugs the island flush against the work area, inside it.
    const bounds = vetaBounds(area, corner, ISLAND)
    expect(bounds).toEqual({ x: 2560 - 480, y: 1392 - 72, width: 480, height: 72 })
    // The place is saved under the display's key, as the latest one used.
    const stored = storeVetaDock(
      { [SECOND.displayKey]: defaultVetaDock('right') },
      PRIMARY.displayKey,
      corner
    )
    expect(Object.keys(stored)).toEqual([SECOND.displayKey, PRIMARY.displayKey])
    expect(stored[PRIMARY.displayKey]).toEqual(corner)
  })

  it('[US-VETA-002.AC05, S21.01, S21.03, S21.14] a stored place is restored per display, a missing display falls back to the default place and a replugged one returns', () => {
    const onSecond: VetaDock = { edge: 'right', end: 'start', offset: 40 }
    const onPrimary: VetaDock = { edge: 'top', end: 'end', offset: 100 }
    // Both displays have a place; the one saved last is where Veta lives (S21.01).
    const stored = storeVetaDock(
      storeVetaDock({}, PRIMARY.displayKey, onPrimary),
      SECOND.displayKey,
      onSecond
    )
    expect(placeOnShow(stored, [PRIMARY, SECOND], 'right')).toEqual({
      kind: 'docked',
      displayKey: SECOND.displayKey,
      dock: onSecond
    })
    // Only the second display's place is stored and it is unplugged: the default place on the primary display, the
    // entry kept (S21.03).
    const onlySecond = { [SECOND.displayKey]: onSecond }
    const fallback = placeOnShow(onlySecond, [PRIMARY], 'right')
    expect(fallback).toEqual({
      kind: 'fallback',
      displayKey: PRIMARY.displayKey,
      dock: defaultVetaDock('right')
    })
    expect(onlySecond).toEqual({ [SECOND.displayKey]: onSecond })
    // Replugged: it returns to its stored place (S21.14), and the renderer is told why.
    expect(
      placeOnDisplayChange(fallback, PRIMARY.workArea, onlySecond, [PRIMARY, SECOND], 'right')
    ).toEqual({
      place: { kind: 'docked', displayKey: SECOND.displayKey, dock: onSecond },
      reason: 'display-changed'
    })
  })

  it('[US-VETA-002.AC06, S21.19] on an edge shorter than the island the grip end stays on screen and the expand end runs off', () => {
    // A short side edge: 300 px high, an island 480 long.
    const short = { x: 0, y: 0, width: 1920, height: 300 }
    // Anchored at the top (start): expand at the top runs off above, the grip end at the bottom stays on screen.
    const fromTop = vetaBounds(short, { edge: 'left', end: 'start', offset: 16 }, ISLAND)
    expect(fromTop).toEqual({ x: 0, y: 300 - 480, width: 72, height: 480 })
    expect(fromTop.y + fromTop.height).toBe(short.y + short.height)
    // Anchored at the bottom (end): expand at the bottom runs off below, the grip end at the top stays on screen.
    const fromBottom = vetaBounds(short, { edge: 'right', end: 'end', offset: 16 }, ISLAND)
    expect(fromBottom).toEqual({ x: 1920 - 72, y: 0, width: 72, height: 480 })
    // A longer island on a long edge keeps the anchor corner: it grows away from the anchor, clamped on screen.
    const area = PRIMARY.workArea
    const grown = vetaBounds(
      area,
      { edge: 'bottom', end: 'end', offset: 16 },
      { length: 900, thickness: 72 }
    )
    expect(grown.x + grown.width).toBe(area.width - 16)
    const clamped = vetaBounds(area, { edge: 'bottom', end: 'start', offset: 2400 }, ISLAND)
    expect(clamped.x + clamped.width).toBe(area.x + area.width)
  })

  it('[US-VETA-002.AC08] a left or right edge makes the island vertical, parts swapping width and height', () => {
    const area = SECOND.workArea
    const bottom = vetaBounds(area, { edge: 'bottom', end: 'start', offset: 16 }, ISLAND)
    const left = vetaBounds(area, { edge: 'left', end: 'start', offset: 16 }, ISLAND)
    const right = vetaBounds(area, { edge: 'right', end: 'end', offset: 16 }, ISLAND)
    const top = vetaBounds(area, { edge: 'top', end: 'end', offset: 16 }, ISLAND)
    expect([bottom.width, bottom.height]).toEqual([480, 72])
    expect([top.width, top.height]).toEqual([480, 72])
    expect([left.width, left.height]).toEqual([72, 480])
    expect([right.width, right.height]).toEqual([72, 480])
    // Flush against its own edge of the work area, never over the taskbar.
    expect(left).toEqual({ x: 2560, y: 357 + 16, width: 72, height: 480 })
    expect(right).toEqual({ x: 2560 + 1920 - 72, y: 357 + 1032 - 16 - 480, width: 72, height: 480 })
    expect(top.y).toBe(357)
    expect(bottom.y + bottom.height).toBe(357 + 1032)
  })

  it("[S21.02] the default place is the bottom edge at the end on the Panel's dock side, 16 px, on the primary display", () => {
    expect(defaultVetaDock('right')).toEqual({ edge: 'bottom', end: 'end', offset: 16 })
    expect(defaultVetaDock('left')).toEqual({ edge: 'bottom', end: 'start', offset: 16 })
    // No stored place at all (first use, after Reset metrics): docked at the default place on the primary display,
    // whichever display is listed first.
    expect(placeOnShow({}, [SECOND, PRIMARY], 'left')).toEqual({
      kind: 'docked',
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'bottom', end: 'start', offset: 16 }
    })
    expect(vetaBounds(PRIMARY.workArea, defaultVetaDock('right'), ISLAND)).toEqual({
      x: 2560 - 16 - 480,
      y: 1392 - 72,
      width: 480,
      height: 72
    })
  })

  it('[S21.12, S21.13, FM-111] a work-area change re-places Veta flush and an unplugged display moves it to the primary display, keeping the entry', () => {
    const dock: VetaDock = { edge: 'bottom', end: 'start', offset: 100 }
    const stored = { [SECOND.displayKey]: dock }
    const onSecond: VetaPlace = { kind: 'docked', displayKey: SECOND.displayKey, dock }
    // Nothing changed for Veta's display: nothing to do.
    expect(
      placeOnDisplayChange(onSecond, SECOND.workArea, stored, [PRIMARY, SECOND], 'right')
    ).toEqual({
      place: onSecond,
      reason: null
    })
    // Its taskbar grew: the same place, flush against the new work area (S21.12).
    const taller = { ...SECOND, workArea: { ...SECOND.workArea, height: 980 } }
    const moved = placeOnDisplayChange(
      onSecond,
      SECOND.workArea,
      stored,
      [PRIMARY, taller],
      'right'
    )
    expect(moved).toEqual({ place: onSecond, reason: 'work-area-changed' })
    expect(vetaBounds(taller.workArea, dock, ISLAND).y).toBe(357 + 980 - 72)
    // Unplugged: the default place on the primary display; the entry is kept (S21.13).
    expect(placeOnDisplayChange(onSecond, SECOND.workArea, stored, [PRIMARY], 'right')).toEqual({
      place: { kind: 'fallback', displayKey: PRIMARY.displayKey, dock: defaultVetaDock('right') },
      reason: 'display-removed'
    })
    expect(stored).toEqual({ [SECOND.displayKey]: dock })
  })

  it('[S21.20] a refused drag-end leaves the place unchanged', () => {
    const before: VetaPlace = {
      kind: 'docked',
      displayKey: PRIMARY.displayKey,
      dock: defaultVetaDock('right')
    }
    const stored = { [PRIMARY.displayKey]: before.dock }
    const asked: VetaPlace = {
      kind: 'docked',
      displayKey: SECOND.displayKey,
      dock: { edge: 'left', end: 'start', offset: 20 }
    }
    expect(land(before, asked, stored, false)).toEqual({ place: before, stored })
    // Applied: the new place, saved under its display's key.
    expect(land(before, asked, stored, true)).toEqual({
      place: asked,
      stored: { [PRIMARY.displayKey]: before.dock, [SECOND.displayKey]: asked.dock }
    })
  })

  it('[S21.17] Reset metrics rewrites every vetaDock entry to the default', () => {
    const stored = {
      [PRIMARY.displayKey]: { edge: 'top', end: 'start', offset: 300 } as VetaDock,
      [SECOND.displayKey]: { edge: 'left', end: 'end', offset: 12 } as VetaDock
    }
    const reset = resetVetaDocks(stored)
    // No stored place is left, so every display takes the default place (S21.02 "after Reset metrics").
    expect(reset).toEqual({})
    expect(placeOnShow(reset, [PRIMARY, SECOND], 'right')).toEqual({
      kind: 'docked',
      displayKey: PRIMARY.displayKey,
      dock: defaultVetaDock('right')
    })
  })
})
