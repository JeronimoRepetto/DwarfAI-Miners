// The rebuilt Panel window (05 §3.14 `PanelWindowController`, frozen in 16 §4.14; ADR-024 items 1, 9; 07 S10.08,
// S10.09; 13 FM-052, FM-111), replacing today's `shell/window.ts` module-level window (21 §6 row "Window and tray":
// replaced). It hides and shows the one Panel window (INV-116), docks it to the stored edge on the work area of the
// display it is on, sizes it for the parts that are open (`domain/panelBounds.ts`), keeps it pinned as stored, and
// tells the Panel's page whenever it starts or stops being on screen (A-P1).
import type { ChannelKey } from '@dwarfai/contracts'
import {
  layoutThatFits,
  panelBounds,
  uiScale,
  type PanelColumns,
  type PanelEdge
} from '../domain/panelBounds'
import type {
  PanelLayout,
  PanelLayoutRequest,
  PanelWindowController
} from '../ports/panelWindowController'
import type { DisplayInfo, ScreenAreaProvider } from '../ports/screenAreaProvider'
import type { UiPreferenceStore, UiPreferenceStoreMap } from '../ports/uiPreferenceStore'
import type { Rect, WindowFactory } from '../ports/windowFactory'

/** A-P1 `onPanelVisibility` (14 §2.1, KEEP): whether the Panel window is on screen. */
export const PANEL_VISIBILITY_PUSH = 'panel:visible:changed' satisfies ChannelKey

/**
 * What the use case reads back from the Panel window the factory built, beyond the frozen `ModeWindow` members
 * (16 §4.14): each answer is what the OS or the page actually did, never what was asked (ADR-024 item 9; 13 FM-051,
 * FM-052). Bound by `ElectronWindows.panelSurface()`; every member acts on the Panel window `windows.panel()` built.
 * Owner-approved additive amendment to 16 §4.14 (2026-10-01, ISSUE-047): these read-backs join the window module's
 * ports; no channel, shape or existing member changes.
 */
export interface PanelWindowSurface {
  /** Zooms the page to `factor` and answers the zoom it has (#153). */
  applyZoom(factor: number): number
  /** The window's rectangle as the window manager left it after the last placement. */
  bounds(): Rect
  /** Asks for always-on-top and answers what the window is (FM-052: a refusal reads back `false`). */
  setAlwaysOnTop(on: boolean): boolean
  isAlwaysOnTop(): boolean
  /** Brings a visible window to the front and focuses it; a hidden one stays hidden (#165). */
  raise(): void
  isMinimized(): boolean
  /** The person minimized or restored the window. */
  onMinimizedChanged(h: () => void): void
}

export interface PanelWindowDeps {
  windows: WindowFactory
  surface: PanelWindowSurface
  screen: ScreenAreaProvider
  /** The `alwaysOnTop` and `dockSide` stores (ADR-024 item 1; ISSUE-048). */
  store: UiPreferenceStore
  /** The narrowest window this platform makes, in real pixels (`ElectronScreenArea.minWindowWidth`). */
  floor: number
  /** The displays changed: one plugged in or out, a work area or a scale changed (13 FM-111). */
  onDisplaysChanged(h: () => void): void
}

/**
 * The Panel window rows' use cases (14 §2.1 A-01…A-05, A-08, A-09, A-P1): the frozen `PanelWindowController` and the
 * three reads its rows answer that the port does not declare (A-02 raise, A-03 the pin, A-05 visibility), plus where a
 * new Panel window opens (`ElectronWindowsDeps.panelStart`). Owner-approved additive amendment to 16 §4.14
 * (2026-10-01, ISSUE-047): `PanelWindowController` gains `raise`, `alwaysOnTop` and `visible`.
 */
export interface PanelWindowUseCases extends PanelWindowController {
  /** A-02: a click on the Panel raises and focuses it; a hidden Panel stays hidden (US-SHELL-002.AC05). */
  raise(): void
  /** A-03: whether the Panel stays above other windows. */
  alwaysOnTop(): boolean
  /** A-05: whether the Panel window is on screen (shown and not minimized). */
  visible(): boolean
  /** Where a new Panel window opens, pinned as stored (#35) and docked to the stored edge (#138). */
  panelStart(): { alwaysOnTop: boolean; bounds: Rect }
  /**
   * Builds the Panel window hidden, its page loading, as today's start did (legacy `createMainWindow` then
   * `loadPanelPage`): the cut-0 entry calls it once the router serves the rows (ISSUE-056; 21 §2 cut 0, "same app").
   */
  load(): void
}

/** What one fit of the Panel window came to, in the display's own pixels. */
export interface PanelFit {
  /** The columns the window it ended up as can hold: what the page is told. */
  held: PanelColumns
  /** The zoom the page actually has. */
  zoom: number
  requestedWidth: number
  appliedWidth: number
}

/** The members of the Panel window one fit needs. */
export interface PanelFitTarget {
  placeAt(bounds: Rect): void
  bounds(): Rect
  applyZoom(factor: number): number
}

/**
 * Fits the Panel window to a layout and reports what it can hold (#635, window fit): the zoom first, because the mine
 * column is derived at the height it leaves the page; then the bounds sized at that zoom; then the read-back. A window
 * that did not reach the width is placed once more for the layout it CAN hold, so the docked edge stays against the
 * screen and no column is drawn into room that is not there.
 */
export function fitPanelWindow(
  target: PanelFitTarget,
  area: Rect,
  layout: PanelColumns & { edge: PanelEdge },
  floor: number
): PanelFit {
  const zoom = target.applyZoom(uiScale(area))
  const requested = panelBounds(area, layout.edge, layout, floor, zoom)
  target.placeAt(requested)
  let applied = target.bounds()
  const held = layoutThatFits(area, layout, applied.width, floor, zoom)
  if (held.mineOpen !== layout.mineOpen || held.dockOpen !== layout.dockOpen) {
    target.placeAt(panelBounds(area, layout.edge, held, floor, zoom))
    applied = target.bounds()
  }
  return { held, zoom, requestedWidth: requested.width, appliedWidth: applied.width }
}

/** The display under a window: the one it overlaps most, or `undefined` when it overlaps none. */
function displayUnder(window: Rect, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
  let best: DisplayInfo | undefined
  let bestArea = 0
  for (const display of displays) {
    const { bounds } = display
    const w =
      Math.min(window.x + window.width, bounds.x + bounds.width) - Math.max(window.x, bounds.x)
    const h =
      Math.min(window.y + window.height, bounds.y + bounds.height) - Math.max(window.y, bounds.y)
    const overlap = w > 0 && h > 0 ? w * h : 0
    if (overlap > bestArea) {
      best = display
      bestArea = overlap
    }
  }
  return best
}

export function createPanelWindow(deps: PanelWindowDeps): PanelWindowUseCases {
  const { windows, surface, screen, store, floor } = deps
  /**
   * The layout asked for: the edge stored, nothing beside the page until the page asks (#635). Read from the store on
   * first use, so composing the use case reads nothing.
   */
  let asked: PanelLayout | null = null
  const layoutAsked = (): PanelLayout =>
    (asked ??= { edge: store.load('dockSide'), mineOpen: false, dockOpen: false })
  /** The columns the window as it last ended up can hold; `null` until it was fitted to the current request. */
  let held: PanelColumns | null = null
  /** Whether the window was built: nothing reads or moves a window before it exists. */
  let built = false
  /** Whether the Panel is shown (S10 `panel` vs `hidden`); minimized is the window's, read back. */
  let shown = false
  /** The visibility the page was last told (A-P1), so each change is pushed once. */
  let told = false

  const panel = () => {
    built = true
    return windows.panel()
  }

  /** The work area of the display the Panel is on, or of the primary display when it is on none (FM-111). */
  const currentArea = (): Rect => {
    const displays = screen.displays()
    const under = built ? displayUnder(surface.bounds(), displays) : undefined
    const display = under ?? displays.find((d) => d.primary) ?? displays[0]
    if (display === undefined) throw new Error('panelWindow: the screen reports no display')
    return screen.workArea(display.displayKey)
  }

  const fit = (): void => {
    const window = panel()
    const target: PanelFitTarget = {
      placeAt: (bounds) => window.placeAt(bounds),
      bounds: () => surface.bounds(),
      applyZoom: (factor) => surface.applyZoom(factor)
    }
    held = fitPanelWindow(target, currentArea(), layoutAsked(), floor).held
  }

  /** What the window is right now: the layout asked, less what the window as it ended up cannot hold. */
  const current = (): PanelLayout => ({ ...layoutAsked(), ...held })

  const visible = (): boolean => built && shown && !surface.isMinimized()

  const publish = (): void => {
    const now = visible()
    if (now === told) return
    told = now
    panel().send(PANEL_VISIBILITY_PUSH, now)
  }

  const persist = <K extends 'alwaysOnTop' | 'dockSide'>(
    k: K,
    v: UiPreferenceStoreMap[K]
  ): void => {
    try {
      store.save(k, v)
    } catch {
      // The store logged the failed write (`uiprefs.write-failed`); the window keeps what it really is.
    }
  }

  const show = (): void => {
    // Re-derived on every show: a Panel hidden across a display change comes back docked to the display as it is now.
    fit()
    panel().showInactive()
    shown = true
    // Shown is not raised (#165): the window may come back under whatever had the foreground.
    surface.raise()
    publish()
  }

  const hide = (): void => {
    shown = false
    if (!built) return
    panel().hide()
    publish()
  }

  deps.onDisplaysChanged(() => {
    // A Panel never built has nothing to re-dock; a hidden one is re-docked too and stays hidden.
    if (built) fit()
  })
  surface.onMinimizedChanged(() => {
    if (built) publish()
  })

  return {
    hide,
    show,
    toggleVisible: () => (shown ? hide() : show()),
    setAlwaysOnTop(on) {
      const real = built ? surface.setAlwaysOnTop(on) : on
      persist('alwaysOnTop', real)
      return real
    },
    layout: current,
    setLayout(request: PanelLayoutRequest) {
      // A request that names no edge (a mine or the window slot opening) keeps the docked side (#138).
      const layout: PanelLayout = {
        edge: request.edge ?? layoutAsked().edge,
        mineOpen: request.mineOpen,
        dockOpen: request.dockOpen
      }
      asked = layout
      held = null
      if (built) fit()
      if (request.edge !== undefined) persist('dockSide', layout.edge)
      return current()
    },
    raise() {
      if (shown && built) surface.raise()
    },
    alwaysOnTop: () => (built ? surface.isAlwaysOnTop() : store.load('alwaysOnTop')),
    visible,
    load: () => {
      panel()
    },
    panelStart: () => ({
      alwaysOnTop: store.load('alwaysOnTop'),
      bounds: panelBounds(currentArea(), layoutAsked().edge, layoutAsked(), floor)
    })
  }
}
