// The tray process of UI main (05 §3.14; ADR-018 item 5; ADR-002 D7; 07 S10.13…S10.16): the tray/menu-bar icon with
// `TrayMenuModel` — Open, Quit, a separator, Stop everything and quit — shown for the Host's whole life.
//
// - Open (S10.13) opens the window per "Mode at launch" (the same path as a second launch, ADR-002 D7, D3).
// - Quit (S10.15; OQ-44, OQ-47; INV-122) asks `TrayWindows.closeAll` and clears the UI-main session store; the tray
//   process, its `notifier` connection and the icon stay. It sends nothing: no frame exists for a Quit (14 §2.4) and
//   nothing ends, launched or observed. From tray-only it changes nothing. ADR-018's Quit closes every window and so
//   the `ui` connection; in cut 0 the composition root binds `closeAll` to hiding the one mode window, the Panel, whose
//   page stays loaded, because the `ui` connection is not bound to a window yet (ADR-003 item 12).
//   `docs/strangler/parity-cut-0.md` records it as an intended difference. The root binds `sessionStore.clear`
//   to the UI-main session store (ISSUE-059).
// - Stop everything and quit hands over to the confirmation flow (`stopEverything.ts`, S10.18).
// - The icon is removed only when the Host exits cleanly (`host.closing`, ADR-003 item 12 as revised): for
//   `'stop-all'` (this process's own Confirm, S10.20) and `'os-session-end'` (S10.16) the windows close, the icon goes
//   and the process exits with the Host. An upgrade drain (`'upgrade'`, ADR-002 D8) is not an exit: the UI starts the
//   new Host and attaches again, so the tray stays.
// - No system tray (13 FM-050): `TrayController.create` fails, the process runs windowless with no icon and Stop
//   everything and quit is offered from the window instead.
//
// The labels are design's copy (ADR-002 O-3; ADR-018 D5), looked up in the copy dictionary, whose values stay
// `⟦COPY NEEDED⟧` markers until design gives them.
import { t, type HostFrames } from '@dwarfai/contracts'
import type { TrayController, TrayMenuModel } from '../ports/trayController'

/** Why the Host closed on purpose (14 B-F05). */
export type HostClosingReason = HostFrames['host.closing']['reason']

/** The mode windows as the tray process uses them; bound by the composition root to the window module. */
export interface TrayWindows {
  /** Whether a window is open (a hidden or minimized one counts, ADR-018 D2). */
  anyOpen(): boolean
  /** Opens the app per "Mode at launch", or shows the open window (S10.13). */
  open(): void
  /** Closes every window (and so the `ui` connection, ADR-003 item 12). */
  closeAll(): void
}

export interface TrayProcessDeps {
  tray: TrayController
  windows: TrayWindows
  /** The UI-main session store (ADR-024): drafts and chat view state, dropped on every entry into tray-only. */
  sessionStore: { clear(): void }
  /** The confirmation flow of Stop everything and quit (`stopEverything.ts`). */
  stopEverything: { request(): unknown }
  /** The Host closed on purpose (`host.closing` on the `notifier` connection, HostClient `onClosing`). */
  onHostClosing(h: (reason: HostClosingReason) => void): () => void
  /** Ends this process (the Electron app's exit). */
  exit(): void
  /** Offers the given menu from the window where no system tray exists (13 FM-050; 07 S10.18). */
  offerFromWindow(menu: TrayMenuModel): void
}

export interface TrayProcess {
  /** Whether the icon shows (false where the desktop has no system tray, FM-050). */
  readonly hasIcon: boolean
  /** Stops listening for the Host's close (a test's or a composition's teardown); the icon stays as it is. */
  dispose(): void
}

/** The closes after which the tray process exits with the Host (S10.16, S10.20). */
const EXIT_WITH_HOST: ReadonlySet<HostClosingReason> = new Set(['stop-all', 'os-session-end'])

export function startTrayProcess(deps: TrayProcessDeps): TrayProcess {
  const { tray, windows, sessionStore, stopEverything } = deps
  const stopItem = {
    kind: 'item',
    id: 'stop-everything',
    label: t('tray.stopEverything'),
    choose: () => void stopEverything.request()
  } as const
  const menu: TrayMenuModel = [
    { kind: 'item', id: 'open', label: t('tray.open'), choose: () => windows.open() },
    {
      kind: 'item',
      id: 'quit',
      label: t('tray.quit'),
      choose: () => {
        windows.closeAll()
        sessionStore.clear()
      }
    },
    { kind: 'separator' },
    stopItem
  ]

  let hasIcon = true
  try {
    tray.create(menu)
  } catch {
    hasIcon = false
    deps.offerFromWindow([stopItem])
  }

  let exited = false
  const stopListening = deps.onHostClosing((reason) => {
    if (exited || !EXIT_WITH_HOST.has(reason)) return
    exited = true
    windows.closeAll()
    if (hasIcon) tray.destroy()
    deps.exit()
  })

  return {
    get hasIcon() {
      return hasIcon
    },
    dispose: stopListening
  }
}
