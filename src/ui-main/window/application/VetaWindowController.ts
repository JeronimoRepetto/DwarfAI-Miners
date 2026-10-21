// The Veta window as the rest of UI main uses it (ISSUE-285; ADR-025 items 1, 4, 6; 16 §4.14 `WindowFactory.veta`,
// `ScreenAreaProvider.workArea`; UC-068; 13 FM-051; 19 §9.6 `veta.placement`).
//
// - Built lazily, by the secure factory (`WindowFactory.veta`, ADR-019 item 1), on its first use, then kept: the
//   `ModeCoordinator` shows and hides it, it is never destroyed (ADR-025 item 1).
// - Always on top at the level each OS allows: `screen-saver` on macOS, `pop-up-menu` elsewhere (ADR-025 item 1). The
//   level that holds above full-screen apps is S-025-2's to confirm per OS; until its record names one, this proposal
//   stands and a refused level is a known limit on the release checklist (EPIC-19 §4). Native Wayland has no
//   always-on-top (ADR-025 item 6), so nothing is asked there.
// - Placed from the work area of its `displayKey` (ADR-024 D5; INV-118: never `display.id`), flush against it, so the
//   taskbar, Dock or panel is never covered, at the place the dock keeps (`VetaDockService`, ISSUE-286; 07 machine 21).
// - Click-through (ADR-025 item 4): on Windows and macOS the renderer's hit-test toggles
//   `setIgnoreMouseEvents(ignore, { forward: true })` (A-N22); on Linux, where `forward` is not available, the bounds
//   hugging the island are the rule and a toggle changes nothing (S-025-3 records the session types).
// - Refused placement (ADR-025 item 6; FM-051): the bounds read back after `setBounds` differ from those asked, so
//   docking is not available on this session. Logged once (`veta.placement`, `unplaced`), and the windowing limits
//   (A-N24) change once, which the one Settings › General notice reads (NFR-PLAT-05: the same for the Panel and Veta).
// - OS show/hide animations stay as the platform has them: disabling them is UNVERIFIED until S-025-1 is recorded
//   (ADR-025 item 1), so nothing here depends on it.
import type { UiLog } from '../../diagnostics/uiLogger'
import { VETA_ISLAND, type VetaDock } from '@dwarfai/contracts'
import { vetaBounds } from '../domain/vetaPlacement'
import {
  windowingLimits,
  type WindowingLimits,
  type WindowingPlatform,
  type WindowingSession
} from '../domain/windowingLimits'
import type { ScreenAreaProvider } from '../ports/screenAreaProvider'
import type { DisplayKey, ModeWindow, Rect, WindowFactory } from '../ports/windowFactory'

/** The always-on-top levels the Veta window uses (ADR-025 item 1; Electron's `setAlwaysOnTop` level). */
export type AlwaysOnTopLevel = 'screen-saver' | 'pop-up-menu'

/** ADR-025 item 1: `screen-saver` on macOS, `pop-up-menu` elsewhere (S-025-2 confirms per OS). */
export function vetaAlwaysOnTopLevel(platform: WindowingPlatform): AlwaysOnTopLevel {
  return platform === 'darwin' ? 'screen-saver' : 'pop-up-menu'
}

/**
 * The Veta window's members beyond `ModeWindow` (frozen at 16 §4.14), answered by the adapter that built it
 * (`ElectronWindows.vetaSurface`), the way the Panel's are (`PanelWindowSurface`).
 */
export interface VetaWindowSurface {
  /** Always on top at `level`. */
  setAlwaysOnTopLevel(level: AlwaysOnTopLevel): void
  /** Click-through, with mouse moves still forwarded to the page. */
  setIgnoreMouseEvents(ignore: boolean): void
  /** The bounds the OS left the window at, read back. */
  bounds(): Rect
}

/**
 * The island the Veta window hugs until the strip reports its own length (`island-resize`, ISSUE-287): the design's
 * thickness, and the closed entrance's length (`VETA_ISLAND`).
 */
export const VETA_ISLAND_PLACEHOLDER: IslandSize = {
  width: VETA_ISLAND.length,
  height: VETA_ISLAND.thickness
}

/** The size of the Veta island the window hugs. */
export interface IslandSize {
  readonly width: number
  readonly height: number
}

export interface VetaWindowControllerDeps {
  factory: Pick<WindowFactory, 'veta'>
  /** The surface of the Veta window `factory.veta` built. */
  surface(): VetaWindowSurface
  screen: Pick<ScreenAreaProvider, 'workArea'>
  /** The display Veta lives on (ADR-024 D5; `VetaDockService`). */
  displayKey(): DisplayKey
  /** Its place on that display's work area (07 machine 21; `VetaDockService`). */
  dock(): VetaDock
  /** The island the window hugs (ADR-025 item 4): `width` along a top or bottom edge, `height` across it. */
  island(): IslandSize
  platform: WindowingPlatform
  /** The Linux session (`probeLinuxSession`); `null` on Windows and macOS. */
  session: WindowingSession
  log: UiLog
}

export interface VetaWindowController {
  /** The Veta window for the `ModeCoordinator`: built on the first call, the same window afterwards. */
  window(): ModeWindow
  /** Its final bounds: the island at its place, flush against the work area of its display. */
  bounds(): Rect
  /** Whether the window exists yet (the dock places and pushes to nothing before it does). */
  built(): boolean
  /** A-N22: the renderer's hit-test result. Before the window exists there is nothing to change. */
  setClickThrough(ignore: boolean): void
  /** A-N24: what this session allows. */
  limits(): WindowingLimits
  /** Told each time the limits change (a refused placement, once). */
  onLimitsChanged(h: (limits: WindowingLimits) => void): () => void
}

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export function createVetaWindowController(deps: VetaWindowControllerDeps): VetaWindowController {
  let built: ModeWindow | null = null
  let boundsApplied = true
  const handlers = new Set<(limits: WindowingLimits) => void>()
  const limits = (): WindowingLimits => windowingLimits(deps.platform, deps.session, boundsApplied)
  // ADR-025 item 4: Linux has no `forward`, so the bounds hugging the island are the rule there (S-025-3).
  const clickThrough = deps.platform !== 'linux'

  const placed = (asked: Rect): void => {
    if (sameRect(deps.surface().bounds(), asked) || !boundsApplied) return
    boundsApplied = false
    deps.log.record({
      level: 'warn',
      event: 'veta.placement',
      subsystem: 'window',
      outcome: 'degraded',
      causeClass: 'unplaced'
    })
    const now = limits()
    for (const h of handlers) h(now)
  }

  const window = (): ModeWindow => {
    if (built !== null) return built
    const veta = deps.factory.veta(deps.displayKey())
    if (limits().alwaysOnTopAvailable) {
      deps.surface().setAlwaysOnTopLevel(vetaAlwaysOnTopLevel(deps.platform))
    }
    built = {
      placeAt: (bounds) => {
        veta.placeAt(bounds)
        placed(bounds)
      },
      showInactive: () => veta.showInactive(),
      hide: () => veta.hide(),
      focus: () => veta.focus(),
      send: (push, payload) => veta.send(push, payload)
    }
    return built
  }

  return {
    window,
    bounds: () => {
      const island = deps.island()
      return vetaBounds(deps.screen.workArea(deps.displayKey()), deps.dock(), {
        length: island.width,
        thickness: island.height
      })
    },
    built: () => built !== null,
    setClickThrough(ignore) {
      if (!clickThrough || built === null) return
      deps.surface().setIgnoreMouseEvents(ignore)
    },
    limits,
    onLimitsChanged(h) {
      handlers.add(h)
      return () => {
        handlers.delete(h)
      }
    }
  }
}
