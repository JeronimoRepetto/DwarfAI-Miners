// The Veta dock in UI main (07 machine 21; UC-045; ISSUE-286; ADR-024 items 1, 5, 8; ADR-025 items 2, 5, 6; 14 §2.2
// A-N23 `layoutVeta`, A-N28 `onVetaDockChanged`; 19 §9.6 `veta.placement`).
//
// - Where Veta is: a `VetaPlace` (`docked` or `fallback`) on one display, read from `vetaDock` the first time it is
//   asked (S21.01–S21.03), then kept up to date by the requests and the display events below.
// - A-N23: `drag-start` grows the window to the work area of the display under the pointer, the drag surface (07 §23
//   N-14; a second call when the pointer crosses onto another display moves it there, once per crossing, S21.07);
//   `drag-end` lands the island on the edge nearest the pointer (S21.08) and saves `vetaDock[displayKey]` (S21.09,
//   S21.15); `dock-key` docks it to the named edge keeping its end and offset (S21.11); `island-resize` re-places it for
//   its new length, saving nothing (S21.19), which is also how the renderer puts it back after a cancelled drag
//   (S21.10); `overlay` (ISSUE-288; 07 N-25; ADR-025 item 2) grows the window before a menu or the mine picker shows,
//   toward the screen and aligned to the island's anchored end (`vetaOverlayFrame`; the renderer pins the island and
//   the overlay by the same rule), so the island never moves on the screen, and `null` shrinks it back once the
//   overlay closed. An overlay
//   is never saved, and a drag forgets it (the renderer closes it silently, S22.17). The other kinds answer
//   `applied: false` until their issue builds them.
// - A landing whose bounds the OS refused (the read-back differs, `dockingAvailable` false) puts the island back where
//   it was and saves nothing (S21.20); with docking unavailable (native Wayland, S21.16) a drag or an arrow key changes
//   nothing.
// - Display events (S21.12–S21.14): Veta is re-placed and the renderer is told why (A-N28). Reset metrics (S21.17): the
//   Reset metrics UI step rewrote `vetaDock`; a shown Veta moves to the default place and nothing is pushed (14 §3.9
//   usage rule: the renderer re-reads its preferences on A-N12).
// - Saves go through `UiPreferences` (the whole map, one atomic write, ADR-024 item 1); nothing is saved before a
//   landing, so a crash or a quit mid-drag saves nothing (S21.18).
import {
  vetaOverlayFrame,
  type ChannelKey,
  type VetaDock,
  type VetaDockChanged,
  type VetaLayoutRequest,
  type VetaLayoutResult
} from '@dwarfai/contracts'
import type { UiLog } from '../../diagnostics/uiLogger'
import {
  dockAtPointer,
  dockToEdge,
  land,
  placeOnDisplayChange,
  placeOnShow,
  vetaBounds,
  type IslandExtent,
  type PanelSide,
  type VetaDisplay,
  type VetaPlace
} from '../domain/vetaPlacement'
import type { ScreenAreaProvider } from '../ports/screenAreaProvider'
import type { DisplayKey, Rect } from '../ports/windowFactory'
import type { StoredUiPreferences } from './uiPreferences'

/** A-N28 (push). */
export const VETA_DOCK_CHANGED_PUSH = 'veta:dock:changed' satisfies ChannelKey

/** The Veta window as the dock moves it: placing and pushing do nothing until the window is built. */
export interface VetaDockWindow {
  placeAt(bounds: Rect): void
  send(push: string, payload: unknown): void
}

export interface VetaDockServiceDeps {
  screen: Pick<ScreenAreaProvider, 'displays'>
  /** The persisted UI preferences (`vetaDock`), written atomically by UI main alone (ADR-024 items 1, 9). */
  prefs: Pick<StoredUiPreferences, 'get' | 'set'>
  /** The Panel's docking edge, whose end of the bottom edge the default place takes (S21.02). */
  panelSide(): PanelSide
  window: VetaDockWindow
  /** Whether the OS applies the bounds asked for (A-N24 `dockingAvailable`; read after each placement). */
  dockingAvailable(): boolean
  /** The island's size until the strip reports its length (ISSUE-287). */
  island: IslandExtent
  log: UiLog
}

export interface VetaDockService {
  /** The display Veta lives on and its place there. */
  current(): { displayKey: DisplayKey; dock: VetaDock }
  /** Machine 21's place, with its state (`docked` or `fallback`). */
  place(): VetaPlace
  /** The island's size along and across its edge. */
  island(): IslandExtent
  /** The window's bounds at the current place. */
  bounds(): Rect
  /** A-N23. */
  layout(request: VetaLayoutRequest): VetaLayoutResult
  /** A `display:` event (display added or removed, metrics or work area changed). */
  displaysChanged(): void
  /** S21.17: after the Reset metrics UI step rewrote `vetaDock`. */
  reset(): void
}

/** The display under a screen point: the one whose bounds hold it, else the nearest. */
function displayUnder(displays: readonly VetaDisplay[], x: number, y: number): VetaDisplay {
  const distance = (d: VetaDisplay): number => {
    const dx = Math.max(d.bounds.x - x, 0, x - (d.bounds.x + d.bounds.width - 1))
    const dy = Math.max(d.bounds.y - y, 0, y - (d.bounds.y + d.bounds.height - 1))
    return dx * dx + dy * dy
  }
  let best = displays[0]
  if (best === undefined) throw new Error('no display to place Veta on')
  for (const display of displays) if (distance(display) < distance(best)) best = display
  return best
}

export function createVetaDockService(deps: VetaDockServiceDeps): VetaDockService {
  const { screen, prefs, window, log } = deps
  let island: IslandExtent = { ...deps.island }
  let place: VetaPlace | null = null
  /** The open overlay's room beside the island, or `null` while none is open. */
  let overlay: { width: number; height: number } | null = null
  /** The work area Veta was last placed (or first found) against, to tell a work-area change (S21.12). */
  let placedArea: Rect = { x: 0, y: 0, width: 0, height: 0 }

  const displays = (): VetaDisplay[] => screen.displays()
  const areaOf = (key: DisplayKey): Rect => {
    const display = displays().find((d) => d.displayKey === key)
    if (display === undefined) throw new Error('Veta is placed on a display that is not connected')
    return display.workArea
  }
  const now = (): VetaPlace => {
    if (place === null) {
      place = placeOnShow(prefs.get('vetaDock'), displays(), deps.panelSide())
      placedArea = areaOf(place.displayKey)
      if (place.kind === 'fallback') logFallback()
    }
    return place
  }
  const boundsAt = (at: VetaPlace): Rect => {
    const hugging = vetaBounds(areaOf(at.displayKey), at.dock, island)
    if (overlay === null) return hugging
    const frame = vetaOverlayFrame(at.dock, island, overlay)
    return {
      x: hugging.x - frame.island.x,
      y: hugging.y - frame.island.y,
      width: frame.width,
      height: frame.height
    }
  }
  const putAt = (at: VetaPlace): void => {
    placedArea = areaOf(at.displayKey)
    window.placeAt(boundsAt(at))
  }
  const result = (applied: boolean): VetaLayoutResult => {
    const at = now()
    return { applied, displayKey: at.displayKey, dock: { ...at.dock } }
  }

  function logFallback(): void {
    log.record({
      level: 'warn',
      event: 'veta.placement',
      subsystem: 'window',
      outcome: 'degraded',
      causeClass: 'fallback'
    })
  }

  /** S21.09 / S21.11 / S21.15 applied, or S21.20 refused: `asked` placed, kept and saved only when the OS took it. */
  function settle(asked: VetaPlace): VetaLayoutResult {
    const before = now()
    if (deps.dockingAvailable()) putAt(asked)
    const applied = deps.dockingAvailable()
    const landed = land(before, asked, prefs.get('vetaDock'), applied)
    place = landed.place
    if (applied) {
      prefs.set('vetaDock', landed.stored)
      log.record({
        level: 'info',
        event: 'veta.placement',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'applied'
      })
    } else {
      putAt(before)
      log.record({
        level: 'warn',
        event: 'veta.placement',
        subsystem: 'window',
        outcome: 'failed',
        causeClass: 'unplaced'
      })
    }
    return result(applied)
  }

  function layout(request: VetaLayoutRequest): VetaLayoutResult {
    const at = now()
    switch (request.kind) {
      case 'drag-start': {
        if (!deps.dockingAvailable()) return result(false)
        overlay = null
        const surface = displayUnder(displays(), request.screenX, request.screenY)
        // The drag surface is not a place: `placedArea` stays the work area Veta is docked against (S21.12).
        window.placeAt(surface.workArea)
        return { applied: true, displayKey: surface.displayKey, dock: { ...at.dock } }
      }
      case 'drag-end': {
        // Refused or not, the window leaves the drag surface: `settle` puts it back when the OS refuses (S21.20).
        const target = displayUnder(displays(), request.screenX, request.screenY)
        const dock = dockAtPointer(
          target.workArea,
          { x: request.screenX, y: request.screenY },
          island.length
        )
        return settle({ kind: 'docked', displayKey: target.displayKey, dock })
      }
      case 'dock-key': {
        if (!deps.dockingAvailable() || request.edge === at.dock.edge) return result(false)
        const dock = dockToEdge(at.dock, request.edge, areaOf(at.displayKey), island.length)
        return settle({ kind: 'docked', displayKey: at.displayKey, dock })
      }
      case 'island-resize': {
        island = { ...island, length: request.length }
        putAt(at)
        return result(true)
      }
      case 'overlay': {
        overlay = request.bounds === null ? null : { ...request.bounds }
        putAt(at)
        return result(true)
      }
      default:
        return result(false)
    }
  }

  return {
    current: () => {
      const at = now()
      return { displayKey: at.displayKey, dock: { ...at.dock } }
    },
    place: now,
    island: () => island,
    bounds: () => boundsAt(now()),
    layout,
    displaysChanged() {
      const before = now()
      const changed = placeOnDisplayChange(
        before,
        placedArea,
        prefs.get('vetaDock'),
        displays(),
        deps.panelSide()
      )
      if (changed.reason === null) return
      place = changed.place
      if (changed.reason === 'display-removed') logFallback()
      putAt(changed.place)
      const push: VetaDockChanged = {
        displayKey: changed.place.displayKey,
        dock: { ...changed.place.dock },
        reason: changed.reason
      }
      window.send(VETA_DOCK_CHANGED_PUSH, push)
    },
    reset() {
      place = placeOnShow(prefs.get('vetaDock'), displays(), deps.panelSide())
      putAt(place)
    }
  }
}
