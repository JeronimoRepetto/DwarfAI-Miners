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
  powerMonitor,
  screen,
  session,
  shell
} from 'electron'
import {
  composeLegacyRuntime,
  createLegacyRuntimeRoute,
  type LegacyRuntimeRoute
} from '../legacy-bridge/LegacyRuntimeRoute'
import {
  createLegacyEndFirstAdapter,
  type EndFirstTimers,
  type LegacyLaunchedSessions
} from '../legacy-bridge/LegacyEndFirstAdapter'
import type { StopAllRelay } from './window/application/stopEverything'
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
import { createPanelRows, PANEL_ROWS } from './ipc/handlers/panel'
import {
  createHostConnectionRows,
  HOST_CONNECTION_ROWS,
  type HostConnectionSource
} from './ipc/handlers/hostConnection'
import { createPanelWindow, type PanelWindowUseCases } from './window/application/panelWindow'
import { currentUiPlatform, ElectronScreenArea } from './window/adapters/ElectronScreenArea'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from './host-client/HostClient'
import {
  createNodeHostConnection,
  createNodeHostLauncher,
  createNodeHungHostEnder,
  winLaunchPrebuildsDir
} from './hostLauncher'
import { ElectronWindows, showRendererCrashedMessage } from './window/adapters/ElectronWindows'
import { startReopen, type Reopen } from './window/application/reopen'

/** A window's contents, as the UI preference pushes need them (A-P6). */
export interface WindowContents extends ModeWindowSender {
  readonly webContentsId: number
}

/**
 * The router's one `ui-local` target (ADR-001 item 3), composed from the parts whose dependencies are given, each
 * owning its own rows (21 §1 item 1): the UI preference rows (ISSUE-048), A-N30 renderer diagnostics (ISSUE-055),
 * the Panel window rows (ISSUE-047) and the Host connection rows A-N03, A-N05 (ISSUE-052).
 * `undefined` when no part is present. None of these rows is routed `ui-local` before the cut-0 switch (ISSUE-056).
 */
export function composeUiLocal({
  uiPreferences,
  uiLog,
  panelWindow,
  hostConnection,
  modeWindows,
  clock = { now: () => Date.now() }
}: {
  uiPreferences?: UiMainDeps['uiPreferences']
  uiLog?: UiLog
  panelWindow?: PanelWindowUseCases
  hostConnection?: HostConnectionSource
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
  if (panelWindow !== undefined) {
    parts.push({ channels: PANEL_ROWS, target: createPanelRows(panelWindow) })
  }
  if (hostConnection !== undefined) {
    parts.push({
      channels: HOST_CONNECTION_ROWS,
      target: createHostConnectionRows(hostConnection)
    })
  }
  return parts.length === 0 ? undefined : composeRouteTargets(parts)
}

/** Real timers for the legacy end bound. */
const realTimers: EndFirstTimers = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  }
}

/**
 * The A-N26 relay of Stop everything and quit through cut 4 (21 §3; ADR-002 D7): `LegacyEndFirstAdapter` ends every
 * session today's runtime launched, reached through `LegacyRuntimeRoute`, before `host.shutdown {mode:'stop-all'}` is
 * relayed, and relays nothing when one cannot be ended. The cut-0 switch (ISSUE-056) composes it as the `relay` of the
 * Stop everything use case, so it is the only path of A-N26 to the Host; it goes with the adapter at the end of cut 4.
 */
export function composeStopAllRelay(
  legacy: LegacyLaunchedSessions,
  timers: EndFirstTimers = realTimers
): StopAllRelay {
  const adapter = createLegacyEndFirstAdapter({ legacy, timers })
  return (requestId, shutdown) => adapter.beforeStopAll(requestId, shutdown)
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
  /** The OS resumed from sleep (`powerMonitor` `resume`, bound once the app is ready). */
  onResume?(h: () => void): void
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
  /**
   * The rebuilt Panel window (ISSUE-047), composed over the mode-window registry. Its rows join the `ui-local` target;
   * they stay `legacy` in the table until the cut-0 switch (ISSUE-056), so until then nothing calls it: it builds no
   * window, writes no preference and today's runtime keeps the one Panel window (21 §1 item 4).
   */
  panelWindow?: (modeWindows: ModeWindowRegistry) => PanelWindowUseCases
  /**
   * The Host attach (ISSUE-051; ADR-002 D4; ADR-003 items 7, 12): HostClient over the host launcher. The root reads
   * the remembered launch view, then starts the attach without awaiting it, before Electron is ready and the window
   * is composed, so the first paint never waits for the Host (US-RES-003.AC07); the board it keeps changes only when a
   * whole snapshot arrived (window/application/reopen.ts). Its Host connection rows A-N03, A-N05 join the `ui-local`
   * target (ISSUE-052), but they are listed in `contracts/ipc/unrouted.ts` until the cut-0 switch (ISSUE-056) routes
   * them and starts the A-N04 push, so until then the router refuses them and no seam A row reaches the client. An OS
   * resume wakes it (13 FM-109). Disposed at will-quit, so a closing app never reconnects or respawns.
   */
  host?: { client: HostClientService }
}

/** What a started root holds: the reopen state when the Host attach was composed. */
export interface UiMainStarted {
  reopen: Reopen | null
}

/**
 * The Electron composition root (05 §2.3; 16 §8.4; ADR-001 item 3). The single-instance lock is
 * taken first; a process that does not get it quits before composing anything (UC-033, PO #73).
 * The holder wires the second-launch use case (S10.02), then, once Electron is ready, composes
 * today's runtime through its one door `LegacyRuntimeRoute` (21 §3) and hands that runtime's Panel
 * window to the second-launch use case. The router (ISSUE-043) registers the seam A listeners
 * right after the lock and dispatches each call by the route table (`ipc/routes.ts`); the rebuilt
 * window module (ISSUE-046, ISSUE-047) joins it as a route target in its own issues. With `host`,
 * the root reads the launch view and starts the Host attach (ISSUE-051) before Electron is ready,
 * never awaiting it.
 *
 * The answer settles when the start has finished: at once (undefined) for a process that quit,
 * after the composition (or the exit it caused) for the lock holder, with its reopen state.
 */
export async function startUiMain({
  lock,
  lifecycle,
  legacyRuntime,
  ipc,
  appEntry,
  uiPreferences,
  uiLog,
  panelWindow,
  host
}: UiMainDeps): Promise<UiMainStarted | undefined> {
  if (!lock.acquire()) {
    lifecycle.quit()
    return undefined
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
  const uiLocal = composeUiLocal({
    uiPreferences,
    uiLog,
    panelWindow: panelWindow?.(modeWindows),
    ...(host === undefined ? {} : { hostConnection: host.client }),
    modeWindows
  })
  createRouter({
    routes: ROUTES,
    legacy: legacyRuntime,
    ...(uiLocal ? { uiLocal } : {}),
    senders: { appEntry, isModeWindow: (id) => modeWindows.has(id) }
  }).register(ipc)
  const secondLaunch = wireSecondLaunch(lock)
  // The launch view, then the Host attach in parallel: neither waits for the other or holds the window back.
  const reopen =
    host === undefined ? null : startReopen({ store: uiPreferences?.store, host: host.client })
  lifecycle.onResume?.(() => host?.client.wake())
  lifecycle.onBeforeQuit(() => legacyRuntime.beforeQuit())
  lifecycle.onWillQuit(() => {
    host?.client.dispose()
    legacyRuntime.willQuit()
  })
  // The app lives in the tray with every window hidden: closing the last window never quits it
  // (only the tray's Quit does), as today.
  lifecycle.onWindowAllClosed(() => {})
  try {
    await lifecycle.whenReady()
    // Today's Panel window answers a second launch until the cut-0 switch (ISSUE-056) attaches the rebuilt one.
    secondLaunch.attach(await legacyRuntime.compose())
  } catch {
    // Today's composition reports its own failure before it rethrows (LegacyRuntimeRoute).
    lifecycle.exit(1)
  }
  return { reopen }
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
    onResume: (h) => {
      void app.whenReady().then(() => powerMonitor.on('resume', () => h()))
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

/** A file under `resources/`: beside the app in development, under `process.resourcesPath` once packaged. */
function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

/**
 * The rebuilt Panel window over Electron (ISSUE-047): `ElectronWindows` builds it through the secure factory with the
 * sandboxed CommonJS preload (ISSUE-045, ISSUE-046), `ElectronScreenArea` answers the displays, and the pin and the
 * docking edge are the `alwaysOnTop` and `dockSide` stores of `store` (ADR-024 item 1). Composing it builds no window,
 * reads no store and touches no display: the window is built on the first call that needs it, and Electron's `screen`
 * is read only after the app is ready.
 */
function electronPanelWindow(
  store: UiPreferenceStore
): (modeWindows: ModeWindowRegistry) => PanelWindowUseCases {
  return (modeWindows) => {
    const screenArea = new ElectronScreenArea(() => screen, currentUiPlatform())
    let panel: PanelWindowUseCases | null = null
    const windows = new ElectronWindows({
      BrowserWindow,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      icon: resourcePath('app-icon.png'),
      appEntry: appEntryUrl(),
      registry: modeWindows,
      panelStart: () => {
        if (panel === null) throw new Error('the Panel window was asked for before it was composed')
        return panel.panelStart()
      },
      timers: {
        now: () => Date.now(),
        setTimeout: (fire, ms) => setTimeout(fire, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      // Every window ElectronWindows builds is an Electron BrowserWindow (the class handed to it above).
      crashMessage: (window) =>
        showRendererCrashedMessage<BrowserWindow>(dialog, window as unknown as BrowserWindow)
    })
    panel = createPanelWindow({
      windows,
      surface: windows.panelSurface(),
      screen: screenArea,
      store,
      floor: screenArea.minWindowWidth(),
      onDisplaysChanged: (h) => void app.whenReady().then(() => screenArea.onChange(h))
    })
    return panel
  }
}

/** The git commit (short) of this build (20 §3.1), stamped by electron.vite.uiMain.config.ts. */
declare const __DWARFAI_BUILD_ID__: string

/**
 * HostClient over the Node host launcher (ISSUE-051; ADR-002 D2, D4, D5): the Host data folder is `userData` + `/host`;
 * the Host runs `out/host/main.js` of this build from its versioned copy, checked against `out/host-manifest.json`,
 * both beside this bundle (`out/ui-main/`); the Windows launch helper loads from the app root's `prebuilds/`.
 */
function electronHostClient(uiLog: UiLog): HostClientService {
  const outDir = join(import.meta.dirname, '..')
  const hostDataDir = join(app.getPath('userData'), 'host')
  const client = { appVersion: app.getVersion(), buildId: __DWARFAI_BUILD_ID__ }
  return createHostClient({
    launcher: createNodeHostLauncher({
      hostDataDir,
      execPath: process.execPath,
      hostManifest: join(outDir, 'host-manifest.json'),
      hostEntry: join(outDir, 'host', 'main.js'),
      prebuildsDir: winLaunchPrebuildsDir(join(outDir, '..')),
      log: uiLog,
      client
    }),
    ...createNodeHostConnection({ hostDataDir }),
    protocolVersion: PROTOCOL_VERSION,
    client: { ...client, pid: process.pid },
    timers: {
      now: () => Date.now(),
      after: (ms, run) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
    },
    log: uiLog,
    // ADR-002 D9 steps 2 and 4: the hung-Host Retry ends that one process only when its identity file matches.
    hungHost: createNodeHungHostEnder({ hostDataDir })
  })
}

// The Electron wiring: the lock first, then the rest (16 §8.4). It runs only when Electron's main
// process loads this file as its entry (`process.type === 'browser'`), never when a test imports
// `startUiMain` from it.
if (process.type === 'browser') {
  // ADR-019 items 2–4 (ISSUE-046): the navigation guard from the first webContents, then the permission denial and
  // the CSP once Electron is ready. The secure window factory builds the Panel once the cut-0 switch (ISSUE-056) routes
  // the Panel window rows to it (ISSUE-047) with a preload that loads sandboxed (ISSUE-045); until then the window is
  // today's (LegacyRuntimeRoute).
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
  // The UI preference files of userData (ADR-024 item 1); their log records (19 §9.6 `uiprefs.corrupt`,
  // `uiprefs.write-failed`) go to the UI log segments.
  const uiPreferenceStore = new JsonUiPreferenceStore({
    dir: app.getPath('userData'),
    log: (record) => uiLog.record(record)
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
      store: uiPreferenceStore,
      windows: () =>
        BrowserWindow.getAllWindows().map((window) => ({
          webContentsId: window.webContents.id,
          send: (push, payload) => window.webContents.send(push, payload)
        }))
    },
    uiLog,
    panelWindow: electronPanelWindow(uiPreferenceStore),
    host: { client: electronHostClient(uiLog) }
  })
}
