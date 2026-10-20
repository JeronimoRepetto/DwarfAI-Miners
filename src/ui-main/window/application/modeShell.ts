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
import type { UiLog } from '../../diagnostics/uiLogger'
import type { ModeTiming } from '../ports/modeTiming'
import type { ModeWindow } from '../ports/windowFactory'
import { createModeCoordinator, type AppMode, type ModeCoordinator } from './ModeCoordinator'
import type { PanelWindowUseCases } from './panelWindow'
import type { DwarfChatRevealer, RevealWindows } from './revealDwarfChat'
import type { StoredUiPreferences } from './uiPreferences'

/**
 * The modes this build ships, UI main's copy of ISSUE-267's feature list (`renderer/src/lib/shell/builtDestinations.ts`
 * `SHIPPED_MODES`): the Panel until the Veta epic ships (ADR-034 item 2). Veta and Valle join here with their windows
 * (ISSUE-285, EPIC-20).
 */
export const BUILT_MODES: readonly AppMode[] = ['panel']

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
}

export interface ModeShell {
  coordinator: ModeCoordinator
  /** The Panel whose hide, show and toggle are the coordinator's runs. */
  panel: PanelWindowUseCases
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
  let revealer: DwarfChatRevealer = { revealDwarfChat: () => Promise.resolve('mine-only') }
  const coordinator = createModeCoordinator({
    windows: {
      window: (mode) => {
        if (mode !== 'panel') throw new Error(`the ${mode} window is not built`)
        return panelWindow
      },
      bounds: () => panel.panelStart().bounds,
      // The Panel's own show re-fits it, shows it inactive and raises it, which also un-minimizes it (#165).
      bringForward: () => panel.show(),
      isShown: () => panel.visible()
    },
    timing: deps.timing,
    lastMode: deps.lastMode,
    built: BUILT_MODES,
    // Late-bound: the reveal's windows are the coordinator's own runs.
    revealer: { revealDwarfChat: (t) => revealer.revealDwarfChat(t) },
    log: deps.log,
    newTransitionId: deps.newTransitionId,
    // UI main reads no reduced-motion preference: each renderer reads its own and answers at t0 (S27.06).
    reducedMotion: () => false,
    start: deps.start
  })
  revealer = deps.revealer({
    existing: () => {
      const rung = coordinator.ladder().state
      return rung === 'tray-only' || rung === 'not-running' ? null : 'panel'
    },
    restore: () => void coordinator.restore(),
    openAtLaunch: async () => {
      await coordinator.openAtLaunch('panel', { reveal: true })
      return 'panel'
    },
    raise: () => {
      panel.raise()
      return Promise.resolve(deps.focused?.() ?? panel.visible())
    }
  })
  return {
    coordinator,
    panel: {
      ...panel,
      hide: () => void coordinator.hide(),
      show: () => void coordinator.restore(),
      toggleVisible: () => void coordinator.toggle()
    }
  }
}
