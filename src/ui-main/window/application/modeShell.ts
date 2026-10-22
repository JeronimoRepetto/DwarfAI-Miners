// The mode shell of UI main (ISSUE-284; ADR-025 items 1, 3, 8; 07 machines 10 and 27): the `ModeCoordinator` composed
// over the mode windows this build ships, and the Panel as every other part of UI main sees it.
//
// - The Panel is the one mode window built (ADR-034 item 2; BR-19): its `ModeWindow` is the Panel window use case.
//   Its final bounds are its docked fit, which `show()` applies before it shows the window inactive (panelWindow.ts),
//   so the coordinator's `placeAt` has nothing left to do for it; `focus` raises it (#165).
// - Every hide and show of the Panel by another part of UI main — the global shortcut, Settings "Hide panel" (A-01),
//   the tray's Open, a second launch, Stop everything's confirmation — is a run of the coordinator (S10.08, S10.09):
//   the Panel those parts get answers `hide`, `show` and `toggleVisible` through it. Everything else is the Panel's own.
// - A notification click reaches the per-mode reveal through the coordinator (S27.14), and the reveal's own restore
//   and launch-open are runs too (S10.11, S10.12).
import { builtModesOf, type DwarfId } from '@dwarfai/contracts'
import type { UiLog } from '../../diagnostics/uiLogger'
import type { ModeTiming } from '../ports/modeTiming'
import type { ModeWindow } from '../ports/windowFactory'
import { createModeCoordinator, type AppMode, type ModeCoordinator } from './ModeCoordinator'
import type { PanelWindowUseCases } from './panelWindow'
import type { DwarfChatRevealer, RevealWindows } from './revealDwarfChat'
import type { VetaWindowController } from './VetaWindowController'
import type { StoredUiPreferences } from './uiPreferences'

/** The build profile electron.vite.config.ts stamps from `DWARFAI_BUILD_PROFILE`; absent outside a build (tests). */
declare const __DWARFAI_BUILD_PROFILE__: string | undefined

/**
 * The modes this build contains: the one built-modes list (`builtModesOf`, 17 §1.9), which the renderer's controls
 * read too (`SHIPPED_MODES`). A release build has the Panel alone until the Veta epic ships (ADR-034 item 2); the E2E
 * build profile adds Veta and Valle. Valle is data only: with no window built, a move to it is refused (EPIC-20).
 */
export const BUILT_MODES: readonly AppMode[] = builtModesOf(
  typeof __DWARFAI_BUILD_PROFILE__ === 'string' ? __DWARFAI_BUILD_PROFILE__ : undefined
)

export interface ModeShellDeps {
  panel: PanelWindowUseCases
  /** A push to the Panel window (a 14 §2.2 M→R member of it, `ModeWindow.send`). */
  pushToPanel(push: string, payload: unknown): void
  lastMode: Pick<StoredUiPreferences, 'get' | 'set'>
  timing: ModeTiming
  log: UiLog
  newTransitionId(): string
  /** `hidden`: a launch built the Panel hidden; `tray-only`: a `--background` start built no window (S10.03). */
  start: 'hidden' | 'tray-only'
  /** The per-mode reveal (`createRevealDwarfChat`) over the windows the coordinator moves. */
  revealer(windows: RevealWindows): DwarfChatRevealer
  /** Whether the raised window took the foreground (S-018-2); the Panel's visibility when none is given. */
  focused?(): boolean
  /** The Host's `dwarf.departed` frames, as dwarf ids: a run carrying that dwarf's chat completes (S27.11). */
  departures?(h: (dwarfId: DwarfId) => void): () => void
  /** The Host closed on purpose (`host.closing`): from tray-only the UI process ends with it (S10.16). */
  hostClosing?(h: () => void): () => void
  /** The modes this build ships; `BUILT_MODES` when not given. */
  built?: readonly AppMode[]
  /** The Veta window (`VetaWindowController`), moved only where `built` lists Veta. */
  veta?: Pick<VetaWindowController, 'window' | 'bounds'>
}

export interface ModeShell {
  coordinator: ModeCoordinator
  /** Stops hearing the Host's departures and close. */
  dispose(): void
  /** The Panel whose hide, show and toggle are the coordinator's runs. */
  panel: PanelWindowUseCases
  /** Shows the Panel for a dialog only the Panel draws (Stop everything and quit's confirmation). */
  surfacePanel(): void
}

export function composeModeShell(deps: ModeShellDeps): ModeShell {
  const { panel } = deps
  const panelWindow: ModeWindow = {
    // The Panel's final bounds are its docked fit, applied by `show()` before it shows the window inactive.
    placeAt: () => {},
    showInactive: () => panel.show(),
    hide: () => panel.hide(),
    focus: () => panel.raise(),
    send: (push, payload) => deps.pushToPanel(push, payload)
  }
  const built = deps.built ?? BUILT_MODES
  // The Veta window (ISSUE-285): moved only where this build ships Veta (BR-19; ADR-034 item 2), else not built.
  const veta = built.includes('veta') ? deps.veta : undefined
  let vetaShown = false
  const vetaWindow = (): ModeWindow => {
    if (veta === undefined) throw new Error('the veta window is not built')
    const window = veta.window()
    return {
      placeAt: (bounds) => window.placeAt(bounds),
      focus: () => window.focus(),
      send: (push, payload) => window.send(push, payload),
      showInactive: () => {
        window.showInactive()
        vetaShown = true
      },
      hide: () => {
        window.hide()
        vetaShown = false
      }
    }
  }
  let revealer: DwarfChatRevealer = { revealDwarfChat: () => Promise.resolve('mine-only') }
  const coordinator = createModeCoordinator({
    windows: {
      window: (mode) => {
        if (mode === 'veta') return vetaWindow()
        if (mode !== 'panel') throw new Error(`the ${mode} window is not built`)
        return panelWindow
      },
      bounds: (mode) => {
        if (mode !== 'veta') return panel.panelStart().bounds
        if (veta === undefined) throw new Error('the veta window is not built')
        return veta.bounds()
      },
      // The Panel's own show re-fits it, shows it inactive and raises it, which also un-minimizes it (#165).
      bringForward: (mode) => (mode === 'veta' ? vetaWindow().focus() : panel.show()),
      // The coordinator is the one that shows and hides Veta, so its own runs say whether it is on screen.
      isShown: (mode) => (mode === 'veta' ? vetaShown : panel.isShown())
    },
    timing: deps.timing,
    lastMode: deps.lastMode,
    built,
    // Late-bound: the reveal's windows are the coordinator's own runs.
    revealer: { revealDwarfChat: (t) => revealer.revealDwarfChat(t) },
    log: deps.log,
    newTransitionId: deps.newTransitionId,
    // UI main reads no reduced-motion preference: each renderer reads its own and answers at t0 (S27.06).
    reducedMotion: () => false,
    // NFR-PERF-02: the Panel places itself nowhere while a run plays (a display change, a layout request).
    onRunChanged: (playing) => panel.holdPlacement(playing),
    start: deps.start
  })
  revealer = deps.revealer({
    // The mode of the window that exists: Veta while Veta is shown (07 S24.15, ISSUE-290), else the Panel, a hidden
    // one included (S10.11).
    existing: () => {
      const rung = coordinator.ladder().state
      if (rung === 'tray-only' || rung === 'not-running') return null
      return rung === 'veta' ? 'veta' : 'panel'
    },
    restore: () => void coordinator.restore(),
    // S10.12: a click with no window open opens the app in "Mode at launch" (ISSUE-294), a built mode.
    openAtLaunch: async () => {
      const mode = coordinator.launchMode()
      await coordinator.openAtLaunch(mode, { reveal: true })
      return mode
    },
    raise: () => {
      panel.raise()
      return Promise.resolve(deps.focused?.() ?? panel.visible())
    }
  })
  const stopDepartures = deps.departures?.((dwarfId) => coordinator.departed(dwarfId))
  const stopClosing = deps.hostClosing?.(() => void coordinator.hostClosed())
  return {
    coordinator,
    dispose: () => {
      stopDepartures?.()
      stopClosing?.()
    },
    // Only the Panel draws Stop everything and quit's confirmation (US-RES-002.AC08; S10.18): with another mode shown,
    // the Panel is the target of a run, shown at once at its final bounds; from hidden it is the ordinary restore.
    surfacePanel: () => {
      const shown = coordinator.mode()
      if (shown === 'hidden' || shown === 'panel') void coordinator.restore()
      else void coordinator.moveToMode({ mode: 'panel' })
    },
    panel: {
      ...panel,
      hide: () => void coordinator.hide(),
      show: () => void coordinator.restore(),
      toggleVisible: () => void coordinator.toggle()
    }
  }
}
