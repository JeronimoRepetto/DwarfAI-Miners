// layer: L2
import type { MineId, VetaDockChanged } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeScreenAreaProvider } from '../ports/fakes/FakeScreenAreaProvider'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'
import type { DisplayInfo } from '../ports/screenAreaProvider'
import type { Rect } from '../ports/windowFactory'
import { createUiPreferences } from './uiPreferences'
import { createVetaDockService, VETA_DOCK_CHANGED_PUSH } from './VetaDockService'

/**
 * The dock (07 machine 21, UI main's half; UC-045): `layoutVeta` (A-N23) requests, display events and Reset metrics over
 * a `FakeScreenAreaProvider`, the `InMemoryUiPreferenceStore` behind `UiPreferences`, and a fake Veta window that records
 * where it was placed and what was pushed to it.
 */
const PRIMARY: DisplayInfo = {
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  primary: true
}
const SECOND: DisplayInfo = {
  displayKey: 'PHL 243V7|1920x1080|@1|2560,357',
  bounds: { x: 2560, y: 357, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 357, width: 1920, height: 1032 },
  primary: false
}
const ISLAND = { length: 480, thickness: 72 }
/** A mine of the unbuilt `unfold-overflow` request. */
const PRIMARY_MINE = '11111111-1111-4111-8111-111111111111' as MineId

function world(options: { store?: InMemoryUiPreferenceStore; displays?: DisplayInfo[] } = {}) {
  const store = options.store ?? new InMemoryUiPreferenceStore()
  const screen = new FakeScreenAreaProvider(options.displays ?? [PRIMARY, SECOND])
  const placed: Rect[] = []
  const pushed: { push: string; payload: VetaDockChanged }[] = []
  const limits = { docking: true }
  const log = new RecordingUiLog()
  const dock = createVetaDockService({
    screen,
    prefs: createUiPreferences({ store, modeWindows: () => [] }),
    panelSide: () => 'right',
    window: {
      placeAt: (bounds) => placed.push(bounds),
      send: (push, payload) => pushed.push({ push, payload: payload as VetaDockChanged })
    },
    dockingAvailable: () => limits.docking,
    island: ISLAND,
    log
  })
  return { dock, store, screen, placed, pushed, limits, log }
}

describe('the Veta dock in UI main (07 machine 21; UC-045)', () => {
  it("[US-VETA-002.AC05, NFR-PERS-12, S21.09] a drop on another display's edge moves the window there and saves vetaDock under that displayKey", () => {
    const { dock, store, placed, log } = world()
    // First use: the default place on the primary display.
    expect(dock.current()).toEqual({
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'bottom', end: 'end', offset: 16 }
    })
    // The press becomes a drag over the primary display: the window grows to its work area, the drag surface.
    expect(dock.layout({ kind: 'drag-start', screenX: 2300, screenY: 1380 })).toMatchObject({
      applied: true,
      displayKey: PRIMARY.displayKey
    })
    expect(placed.at(-1)).toEqual(PRIMARY.workArea)
    // The pointer crosses onto the second display: the drag surface moves there once.
    dock.layout({ kind: 'drag-start', screenX: 2600, screenY: 900 })
    expect(placed.at(-1)).toEqual(SECOND.workArea)
    // Released near the second display's left edge, in its lower half.
    const result = dock.layout({ kind: 'drag-end', screenX: 2565, screenY: 900 })
    const landed = { edge: 'left', end: 'end', offset: 357 + 1032 - 900 - 240 } as const
    expect(result).toEqual({ applied: true, displayKey: SECOND.displayKey, dock: landed })
    expect(placed.at(-1)).toEqual({ x: 2560, y: 900 - 240, width: 72, height: 480 })
    expect(store.load('vetaDock')).toEqual({ [SECOND.displayKey]: landed })
    expect(log.byEvent('veta.placement')).toEqual([
      {
        level: 'info',
        event: 'veta.placement',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'applied'
      }
    ])
    // Relaunched: a new dock over the same store restores that place on that display (S21.01).
    const again = world({ store })
    expect(again.dock.current()).toEqual({ displayKey: SECOND.displayKey, dock: landed })
    expect(again.dock.bounds()).toEqual({ x: 2560, y: 900 - 240, width: 72, height: 480 })
  })

  it('[S21.12, S21.13] a display event re-places Veta and pushes onVetaDockChanged with its reason', () => {
    const { dock, screen, placed, pushed, store, log } = world()
    dock.layout({ kind: 'drag-end', screenX: 3000, screenY: 1385 })
    const onSecond = dock.current()
    expect(onSecond.displayKey).toBe(SECOND.displayKey)
    placed.length = 0
    // Nothing that concerns Veta changed: nothing moves, nothing is pushed.
    screen.set([PRIMARY, SECOND])
    dock.displaysChanged()
    expect([placed, pushed]).toEqual([[], []])
    // The second display's taskbar grew (S21.12): the same place, flush against the new work area.
    const taller = { ...SECOND, workArea: { ...SECOND.workArea, height: 980 } }
    screen.set([PRIMARY, taller])
    dock.displaysChanged()
    expect(placed.at(-1)?.y).toBe(357 + 980 - 72)
    expect(pushed.at(-1)).toEqual({
      push: VETA_DOCK_CHANGED_PUSH,
      payload: { ...onSecond, reason: 'work-area-changed' }
    })
    // Unplugged (S21.13): the default place on the primary display, the entry kept.
    screen.set([PRIMARY])
    dock.displaysChanged()
    expect(pushed.at(-1)).toEqual({
      push: VETA_DOCK_CHANGED_PUSH,
      payload: {
        displayKey: PRIMARY.displayKey,
        dock: { edge: 'bottom', end: 'end', offset: 16 },
        reason: 'display-removed'
      }
    })
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 480, y: 1392 - 72, width: 480, height: 72 })
    expect(store.load('vetaDock')).toEqual({ [SECOND.displayKey]: onSecond.dock })
    expect(log.byEvent('veta.placement').at(-1)).toEqual({
      level: 'warn',
      event: 'veta.placement',
      subsystem: 'window',
      outcome: 'degraded',
      causeClass: 'fallback'
    })
    // Replugged (S21.14): back to its stored place.
    screen.set([PRIMARY, taller])
    dock.displaysChanged()
    expect(pushed.at(-1)?.payload).toEqual({ ...onSecond, reason: 'display-changed' })
    expect(pushed).toHaveLength(3)
  })

  it('[S21.18] a crash mid-drag saves nothing', () => {
    const { dock, store } = world()
    dock.layout({ kind: 'drag-start', screenX: 100, screenY: 100 })
    // The UI process dies before the release: nothing is saved, and the next start uses the last saved place.
    expect(store.load('vetaDock')).toEqual({})
    const next = world({ store })
    expect(next.dock.current()).toEqual({
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'bottom', end: 'end', offset: 16 }
    })
  })

  it('[US-VETA-002.AC04, S21.11, S21.15] an arrow key docks to the named edge keeping end and offset, saved for the display now used', () => {
    const { store, placed } = world({ displays: [PRIMARY] })
    // Stored places exist for a display that is not connected: fallback on the primary display.
    store.save('vetaDock', { [SECOND.displayKey]: { edge: 'top', end: 'start', offset: 5 } })
    const fresh = world({ store, displays: [PRIMARY] })
    expect(fresh.dock.place().kind).toBe('fallback')
    const result = fresh.dock.layout({ kind: 'dock-key', edge: 'left' })
    expect(result).toEqual({
      applied: true,
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'left', end: 'end', offset: 16 }
    })
    expect(fresh.dock.place().kind).toBe('docked')
    expect(store.load('vetaDock')).toEqual({
      [SECOND.displayKey]: { edge: 'top', end: 'start', offset: 5 },
      [PRIMARY.displayKey]: { edge: 'left', end: 'end', offset: 16 }
    })
    // The edge it is on already: nothing moves, nothing is saved.
    const count = fresh.placed.length
    expect(fresh.dock.layout({ kind: 'dock-key', edge: 'left' }).applied).toBe(false)
    expect(fresh.placed).toHaveLength(count)
    expect(placed).toEqual([])
  })

  it('[S21.19, S21.20, S21.16] the island length re-places it without saving; a refused landing keeps the place; other kinds are not applied yet', () => {
    const { dock, store, placed, limits, log } = world()
    // The island grew: the window is re-placed at the same place, the anchor corner kept; nothing is saved.
    expect(dock.layout({ kind: 'island-resize', length: 600 }).applied).toBe(true)
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 600, y: 1392 - 72, width: 600, height: 72 })
    expect(store.load('vetaDock')).toEqual({})
    // The landing's bounds are refused (S21.20): the place before the press stands, nothing saved, logged.
    dock.layout({ kind: 'drag-start', screenX: 100, screenY: 100 })
    limits.docking = false
    const refused = dock.layout({ kind: 'drag-end', screenX: 5, screenY: 700 })
    expect(refused).toEqual({
      applied: false,
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'bottom', end: 'end', offset: 16 }
    })
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 600, y: 1392 - 72, width: 600, height: 72 })
    expect(store.load('vetaDock')).toEqual({})
    expect(log.byEvent('veta.placement').at(-1)).toMatchObject({
      outcome: 'failed',
      causeClass: 'unplaced'
    })
    // Docking unavailable (S21.16): a drag or an arrow key changes nothing.
    expect(dock.layout({ kind: 'drag-start', screenX: 100, screenY: 100 }).applied).toBe(false)
    expect(dock.layout({ kind: 'dock-key', edge: 'top' }).applied).toBe(false)
    // The kinds of later issues answer `applied: false` until they are built. AMENDED for ISSUE-288: `overlay` is built.
    // AMENDED for ISSUE-290: `rise` and `fold` are built (their case is the risen-room one below); `unfold-overflow`
    // is ISSUE-291's.
    expect(dock.layout({ kind: 'unfold-overflow', mineId: PRIMARY_MINE }).applied).toBe(false)
  })

  it('[S21.17] Reset metrics moves a shown Veta to the default place, with no onVetaDockChanged', () => {
    const { dock, store, placed, pushed } = world()
    dock.layout({ kind: 'drag-end', screenX: 3000, screenY: 400 })
    expect(dock.current().displayKey).toBe(SECOND.displayKey)
    // The Reset metrics UI step rewrote every stored store to its defaults; the dock follows.
    store.save('vetaDock', {})
    dock.reset()
    expect(dock.current()).toEqual({
      displayKey: PRIMARY.displayKey,
      dock: { edge: 'bottom', end: 'end', offset: 16 }
    })
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 480, y: 1392 - 72, width: 480, height: 72 })
    expect(pushed).toEqual([])
  })

  it('[ADR-025, S22.01, S22.16] an overlay grows the window toward the screen, the island staying put, and closing it shrinks it back', () => {
    const { dock, placed, store } = world()
    const island = { x: 2560 - 16 - 480, y: 1392 - 72, width: 480, height: 72 }
    expect(dock.bounds()).toEqual(island)
    // The picker (wider than the island) opens: the window grows up and to the left, the island's corner unmoved.
    expect(dock.layout({ kind: 'overlay', bounds: { width: 600, height: 300 } })).toMatchObject({
      applied: true,
      displayKey: PRIMARY.displayKey
    })
    expect(placed.at(-1)).toEqual({
      x: 2560 - 16 - 600,
      y: 1392 - 72 - 300,
      width: 600,
      height: 372
    })
    // A new length meanwhile keeps the overlay's room.
    dock.layout({ kind: 'island-resize', length: 400 })
    expect(placed.at(-1)).toEqual({
      x: 2560 - 16 - 600,
      y: 1392 - 72 - 300,
      width: 600,
      height: 372
    })
    // Closed: the window hugs the island again. Nothing about an overlay is ever saved.
    dock.layout({ kind: 'overlay', bounds: null })
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 400, y: 1392 - 72, width: 400, height: 72 })
    expect(store.load('vetaDock')).toEqual({})
    // A drag forgets an open overlay: its drop lands the island alone.
    dock.layout({ kind: 'overlay', bounds: { width: 200, height: 100 } })
    dock.layout({ kind: 'drag-start', screenX: 1000, screenY: 1380 })
    dock.layout({ kind: 'drag-end', screenX: 1000, screenY: 1380 })
    expect(placed.at(-1)).toMatchObject({ width: 400, height: 72 })
  })

  it('[ADR-025, S24.01, S24.09, S24.14] a rise grows the window by the risen room, kept with an overlay, and a fold or a drag gives it back', () => {
    const { dock, placed, store } = world()
    // The tab band is held (ISSUE-289): 480 x 30 beside the island.
    dock.layout({ kind: 'overlay', bounds: { width: 480, height: 30 } })
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 480, y: 1392 - 102, width: 480, height: 102 })
    // A chat rises: the window grows toward the screen and away from the anchor corner, the island unmoved.
    const answer = dock.layout({
      kind: 'rise',
      dwarfId: '33333333-3333-4333-8333-333333333333' as never,
      chatBounds: { width: 700, height: 614 }
    })
    expect(answer).toMatchObject({ applied: true, displayKey: PRIMARY.displayKey })
    expect(placed.at(-1)).toEqual({
      x: 2560 - 16 - 700,
      y: 1392 - 72 - 614,
      width: 700,
      height: 686
    })
    // A menu opening meanwhile keeps the risen room: the larger of the two holds the window.
    dock.layout({ kind: 'overlay', bounds: { width: 480, height: 200 } })
    expect(placed.at(-1)).toEqual({
      x: 2560 - 16 - 700,
      y: 1392 - 72 - 614,
      width: 700,
      height: 686
    })
    dock.layout({ kind: 'overlay', bounds: { width: 480, height: 30 } })
    // Folded: back to the band. Nothing about a rise is ever saved.
    expect(dock.layout({ kind: 'fold' }).applied).toBe(true)
    expect(placed.at(-1)).toEqual({ x: 2560 - 16 - 480, y: 1392 - 102, width: 480, height: 102 })
    expect(store.load('vetaDock')).toEqual({})
    // A drag forgets a risen chat (S24.14): its drop lands the island alone.
    dock.layout({
      kind: 'rise',
      dwarfId: '33333333-3333-4333-8333-333333333333' as never,
      chatBounds: { width: 700, height: 614 }
    })
    dock.layout({ kind: 'drag-start', screenX: 1000, screenY: 1380 })
    dock.layout({ kind: 'drag-end', screenX: 1000, screenY: 1380 })
    expect(placed.at(-1)).toMatchObject({ width: 480, height: 72 })
  })
})
