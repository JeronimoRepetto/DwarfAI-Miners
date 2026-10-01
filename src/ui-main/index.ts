import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
  shell
} from 'electron'
import {
  composeLegacyRuntime,
  createLegacyRuntimeRoute,
  type LegacyRuntimeRoute
} from '../legacy-bridge/LegacyRuntimeRoute'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from './ipc/router'
import { ROUTES } from './ipc/routes'
import { ElectronSingleInstanceLock } from './window/adapters/ElectronSingleInstanceLock'
import { createModeWindowRegistry } from './window/application/modeWindowRegistry'
import { wireSecondLaunch } from './window/application/secondLaunch'
import type { SingleInstanceLock } from './window/ports/singleInstanceLock'
import { createUiPreferenceRows, UI_PREFERENCE_ROWS } from './ipc/handlers/uiPreferenceRows'
import { JsonUiPreferenceStore } from './window/adapters/JsonUiPreferenceStore'
import { createUiPreferences, type ModeWindowSender } from './window/application/uiPreferences'
import type { UiPreferenceStore } from './window/ports/uiPreferenceStore'
import { NodeLogFiles } from './diagnostics/adapters/NodeLogFiles'
import type { UiClock } from './diagnostics/ports/clock'
import { createRendererDiagnostics } from './diagnostics/rendererDiagnostics'
import { createUiLogger, logLevelFromEnv, type UiLog } from './diagnostics/uiLogger'
import { composeRouteTargets, type RouteTargetPart } from './ipc/composeRouteTargets'
import {
  createRendererDiagnosticHandler,
  RENDERER_DIAGNOSTIC_CHANNEL
} from './ipc/handlers/rendererDiagnostic'
import type { ModeWindowRegistry } from './window/application/modeWindowRegistry'
import { devHmrOriginOf } from './window/adapters/contentSecurityPolicy'
import { installWindowHardening } from './window/adapters/windowHardening'

/** A window's contents, as the UI preference pushes need them (A-P6). */
export interface WindowContents extends ModeWindowSender {
  readonly webContentsId: number
}

/**
 * The router's one `ui-local` target (ADR-001 item 3), composed from the parts whose dependencies are given, each
 * owning its own rows (21 §1 item 1): the UI preference rows (ISSUE-048) and A-N30 renderer diagnostics (ISSUE-055).
 * `undefined` when no part is present. None of these rows is routed `ui-local` before the cut-0 switch (ISSUE-056).
 */
export function composeUiLocal({
  uiPreferences,
  uiLog,
  modeWindows,
  clock = { now: () => Date.now() }
}: {
  uiPreferences?: UiMainDeps['uiPreferences']
  uiLog?: UiLog
  modeWindows: ModeWindowRegistry
  clock?: UiClock
}): RouteTarget | undefined {
  const parts: RouteTargetPart[] = []
  if (uiPreferences !== undefined) {
    parts.push({
      channels: UI_PREFERENCE_ROWS,
      target: createUiPreferenceRows(
        createUiPreferences({
          store: uiPreferences.store,
          modeWindows: () => uiPreferences.windows().filter((w) => modeWindows.has(w.webContentsId))
        })
      )
    })
  }
  if (uiLog !== undefined) {
    parts.push({
      channels: [RENDERER_DIAGNOSTIC_CHANNEL],
      target: createRendererDiagnosticHandler(
        createRendererDiagnostics({
          log: uiLog,
          clock,
          // Until the window factory registers each window's mode (ISSUE-046), the one mode window is the Panel.
          modeOf: (id) => (modeWindows.has(id) ? 'panel' : undefined)
        })
      )
    })
  }
  return parts.length === 0 ? undefined : composeRouteTargets(parts)
}

/** A window Electron created, as the mode-window registry needs it. */
export interface CreatedWindow {
  readonly webContentsId: number
  onClosed(h: () => void): void
}

/** The Electron `app` events and exits the root needs, as plain calls (bound in the Electron wiring below). */
export interface UiMainLifecycle {
  quit(): void
  exit(code: number): void
  whenReady(): Promise<unknown>
  onBeforeQuit(h: () => void): void
  onWillQuit(h: () => void): void
  onWindowAllClosed(h: () => void): void
  /** Electron created a window (`browser-window-created`). */
  onWindowCreated(h: (window: CreatedWindow) => void): void
}

export interface UiMainDeps {
  lock: SingleInstanceLock
  lifecycle: UiMainLifecycle
  legacyRuntime: Pick<LegacyRuntimeRoute, 'compose' | 'serve' | 'beforeQuit' | 'willQuit'>
  /** Electron's `ipcMain`, where the router registers the seam A listeners (ADR-001 item 3). */
  ipc: IpcMainRegistrar
  /** The app's own entry, the only page whose calls the seam A gate accepts (ADR-019 item 8). */
  appEntry: string
  /**
   * The persisted UI preference stores (ISSUE-048, ADR-024 item 1) and every window's contents, for the A-P6 push to
   * the mode windows. Its rows are a `ui-local` route target; they stay `legacy` in the table, so today's runtime
   * keeps writing today's files, until the cut-0 switch (ISSUE-056) routes them here.
   */
  uiPreferences?: { store: UiPreferenceStore; windows(): readonly WindowContents[] }
  /** The UI logger (ADR-026; 05 §3.14): A-N30 renderer diagnostics join the `ui-local` target with it. */
  uiLog?: UiLog
}

/**
 * The Electron composition root (05 §2.3; 16 §8.4; ADR-001 item 3). The single-instance lock is
 * taken first; a process that does not get it quits before composing anything (UC-033, PO #73).
 * The holder wires the second-launch use case (S10.02), then, once Electron is ready, composes
 * today's runtime through its one door `LegacyRuntimeRoute` (21 §3) and hands that runtime's Panel
 * window to the second-launch use case. The router (ISSUE-043) registers the seam A listeners
 * right after the lock and dispatches each call by the route table (`ipc/routes.ts`); the Host
 * client (ISSUE-051) and the rebuilt window module (ISSUE-046, ISSUE-047) join it as route
 * targets in their own issues.
 *
 * The answer settles when the start has finished: at once for a process that quit, after the
 * composition (or the exit it caused) for the lock holder.
 */
export async function startUiMain({
  lock,
  lifecycle,
  legacyRuntime,
  ipc,
  appEntry,
  uiPreferences,
  uiLog
}: UiMainDeps): Promise<void> {
  if (!lock.acquire()) {
    lifecycle.quit()
    return
  }
  // The mode windows (ADR-019 item 8): until the window factory registers the windows it builds (ISSUE-046), every
  // window of this process is created by today's composition, and since #635 that is the one Panel shell window.
  // Registered before anything is composed, so the window is known before its page is loaded.
  const modeWindows = createModeWindowRegistry()
  lifecycle.onWindowCreated(({ webContentsId, onClosed }) => {
    modeWindows.register(webContentsId)
    onClosed(() => modeWindows.drop(webContentsId))
  })
  // Every seam A call goes through the router table from the first renderer load (21 §1 item 1), behind the gate
  // that checks its sender and its payload (ADR-019 items 7, 8).
  const uiLocal = composeUiLocal({ uiPreferences, uiLog, modeWindows })
  createRouter({
    routes: ROUTES,
    legacy: legacyRuntime,
    ...(uiLocal ? { uiLocal } : {}),
    senders: { appEntry, isModeWindow: (id) => modeWindows.has(id) }
  }).register(ipc)
  const secondLaunch = wireSecondLaunch(lock)
  lifecycle.onBeforeQuit(() => legacyRuntime.beforeQuit())
  lifecycle.onWillQuit(() => legacyRuntime.willQuit())
  // The app lives in the tray with every window hidden: closing the last window never quits it
  // (only the tray's Quit does), as today.
  lifecycle.onWindowAllClosed(() => {})
  try {
    await lifecycle.whenReady()
    secondLaunch.attach(await legacyRuntime.compose())
  } catch {
    // Today's composition reports its own failure before it rethrows (LegacyRuntimeRoute).
    lifecycle.exit(1)
  }
}

/** The Electron `app` behind `UiMainLifecycle`. */
function electronLifecycle(): UiMainLifecycle {
  return {
    quit: () => app.quit(),
    exit: (code) => app.exit(code),
    whenReady: () => app.whenReady(),
    onBeforeQuit: (h) => {
      app.on('before-quit', () => h())
    },
    onWillQuit: (h) => {
      app.on('will-quit', () => h())
    },
    onWindowAllClosed: (h) => {
      app.on('window-all-closed', () => h())
    },
    onWindowCreated: (h) => {
      app.on('browser-window-created', (_event, window) => {
        h({
          webContentsId: window.webContents.id,
          onClosed: (closed) => window.once('closed', closed)
        })
      })
    }
  }
}

/** Electron's `ipcMain` behind `IpcMainRegistrar`: the event (for the sender check) and the one payload argument. */
function electronIpcMain(): IpcMainRegistrar {
  return {
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, payload: unknown) => listener(event, payload)),
    on: (channel, listener) => {
      ipcMain.on(channel, (event, payload: unknown) => listener(event, payload))
    }
  }
}

/**
 * The page today's composition loads into the Panel window (legacy `shell/window.ts` `applyPanelPageLoad`): the dev
 * server when `ELECTRON_RENDERER_URL` names one, the built `renderer/index.html` beside this bundle otherwise.
 */
function appEntryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const devServerUrl = env.ELECTRON_RENDERER_URL
  if (devServerUrl) return devServerUrl
  return pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
}

// The Electron wiring: the lock first, then the rest (16 §8.4). It runs only when Electron's main
// process loads this file as its entry (`process.type === 'browser'`), never when a test imports
// `startUiMain` from it.
if (process.type === 'browser') {
  // ADR-019 items 2–4 (ISSUE-046): the navigation guard from the first webContents, then the permission denial and
  // the CSP once Electron is ready. The secure window factory builds the Panel once the Panel window rows are served
  // (ISSUE-047) with a preload that loads sandboxed (ISSUE-045); until then the window is today's (LegacyRuntimeRoute).
  installWindowHardening({
    app,
    session: () => session.defaultSession,
    openExternal: (url) => void shell.openExternal(url),
    appEntry: appEntryUrl(),
    devHmrOrigin: app.isPackaged ? undefined : devHmrOriginOf(process.env.ELECTRON_RENDERER_URL)
  })
  const uiLog = createUiLogger({
    files: new NodeLogFiles(),
    logDir: join(app.getPath('userData'), 'logs'), // ADR-026 item 1, the folder the Host writes into too
    clock: { now: () => Date.now() },
    appVersion: app.getVersion(),
    pid: process.pid,
    level: logLevelFromEnv(process.env),
    appRoot: app.getAppPath()
  })
  void startUiMain({
    lock: new ElectronSingleInstanceLock(app),
    lifecycle: electronLifecycle(),
    legacyRuntime: createLegacyRuntimeRoute(
      composeLegacyRuntime({ app, dialog, nativeImage, shell, clipboard, globalShortcut })
    ),
    ipc: electronIpcMain(),
    appEntry: appEntryUrl(),
    uiPreferences: {
      // The UI preference files of userData (ADR-024 item 1); their log records (19 §9.6 `uiprefs.corrupt`,
      // `uiprefs.write-failed`) go to the UI log segments.
      store: new JsonUiPreferenceStore({
        dir: app.getPath('userData'),
        log: (record) => uiLog.record(record)
      }),
      windows: () =>
        BrowserWindow.getAllWindows().map((window) => ({
          webContentsId: window.webContents.id,
          send: (push, payload) => window.webContents.send(push, payload)
        }))
    },
    uiLog
  })
}
