// The Valle window as the rest of UI main uses it (ISSUE-299; 07 machine 39; ADR-025 items 1, 7; ADR-024 item 6;
// 16 §4.14 `WindowFactory.valle`, `ScreenAreaProvider`).
//
// - Built lazily, by the secure factory (`WindowFactory.valle`, ADR-019 item 1), on its first use, then kept: the
//   `ModeCoordinator` shows and hides it, it is never destroyed (ADR-025 item 1). Frameless, not always on top, out of
//   the taskbar, throttled while hidden (the Valle row; `valleWindowRequest`).
// - Each entry places it again (S39.01, S39.02): on the work area (`VALLE_BOUNDS`) of the display matching the window it
//   is entered from, or for a launch with no window the display of the Panel's stored place, else the primary (§24
//   I-35). It keeps no placement of its own (OQ-20; US-VALLE-001.AC10).
// - A display event while it is shown re-places it on the display now matching its bounds, or refits it to that
//   display's new work area (S39.08, S39.09); a hidden one is placed by its next entry.
//
// UI main's view of machine 39: the window is `opening` from its placement until it is shown inactive, and `shown`
// from then; the stores read before the first paint (S39.03, S39.13) are its renderer's.
import {
  enterValle,
  nextValleWindow,
  placeValle,
  refitValle,
  type ValleEntry,
  type ValleNode,
  type VallePlace,
  type ValleWindowEvent,
  type ValleWindowState
} from '../domain/valleWindow'
import type { ScreenAreaProvider } from '../ports/screenAreaProvider'
import type { ModeWindow, Rect, WindowFactory } from '../ports/windowFactory'

export interface ValleWindowControllerDeps {
  factory: Pick<WindowFactory, 'valle'>
  screen: Pick<ScreenAreaProvider, 'displays'>
  /** Where Valle is entered from now: the bounds of the mode window shown, or a launch with the Panel's stored place. */
  entry(): ValleEntry
}

export interface ValleWindowController {
  /** The Valle window for the `ModeCoordinator`: built on the first call, the same window afterwards. */
  window(): ModeWindow
  /** Its final bounds for this entry (S39.01, S39.02): placed from where it is entered from, nothing remembered. */
  bounds(): Rect
  /** Whether the window exists yet. */
  built(): boolean
  /** Machine 39's state as UI main sees it. */
  state(): ValleWindowState
  /** A `display:` event (S39.08, S39.09): a shown window is re-placed; a hidden one waits for its next entry. */
  displaysChanged(): void
}

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export function createValleWindowController(
  deps: ValleWindowControllerDeps
): ValleWindowController {
  let built: ModeWindow | null = null
  let node: ValleNode = { state: 'not-created' }
  /** Where the window was last placed: the bounds a display event re-matches (S39.08), never a stored placement. */
  let placed: VallePlace | null = null

  const step = (event: ValleWindowEvent): void => {
    const next = nextValleWindow(node, event)
    if (next.ok) node = next.value.to
  }

  /** S39.01, S39.02: placed from where it is entered from now; an entry while already opening places it all the same. */
  const enter = (): VallePlace => {
    const displays = deps.screen.displays()
    const entered = enterValle(node, deps.entry(), displays)
    if (!entered.ok) return placeValle(deps.entry(), displays)
    node = entered.value.to
    return entered.value.place
  }

  const window = (): ModeWindow => {
    if (built !== null) return built
    const valle = deps.factory.valle(placeValle(deps.entry(), deps.screen.displays()).displayKey)
    built = {
      placeAt: (bounds) => {
        valle.placeAt(bounds)
        if (placed !== null) placed = { ...placed, bounds }
      },
      showInactive: () => {
        valle.showInactive()
        if (node.state === 'opening') node = { state: 'shown' }
      },
      hide: () => {
        valle.hide()
        step({ type: 'left' })
      },
      focus: () => valle.focus(),
      send: (push, payload) => valle.send(push, payload)
    }
    return built
  }

  return {
    window,
    bounds() {
      const place = enter()
      placed = place
      return place.bounds
    },
    built: () => built !== null,
    state: () => node.state,
    displaysChanged() {
      if (built === null || placed === null || node.state !== 'shown') return
      const displays = deps.screen.displays()
      const next = refitValle(placed.bounds, displays)
      if (next.displayKey === placed.displayKey && sameRect(next.bounds, placed.bounds)) return
      const gone = !displays.some((display) => display.displayKey === placed?.displayKey)
      step({ type: gone ? 'display-removed' : 'work-area-changed' })
      placed = next
      built.placeAt(next.bounds)
    }
  }
}
