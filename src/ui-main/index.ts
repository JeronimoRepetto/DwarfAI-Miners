import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  type NativeImage
} from 'electron'
import {
  composeLegacyRuntime,
  createLegacyRuntimeRoute,
  type LegacyPanelSurface,
  type LegacyRuntimeRoute
} from '../legacy-bridge/LegacyRuntimeRoute'
import {
  createLegacyEndFirstAdapter,
  type EndFirstTimers,
  type LegacyLaunchedSessions
} from '../legacy-bridge/LegacyEndFirstAdapter'
import { createLegacySettingsWriteHub } from '../legacy-bridge/settingsMirror/legacySettingsWrites'
import { createBoardFacadeAdapter } from '../legacy-bridge/BoardFacadeAdapter'
import {
  createLegacyAgentRegistryFeed,
  LEGACY_FEED_PROVIDERS_CUT_1,
  type LegacyAgentRegistryFeed,
  type LegacyFeedModes,
  type LegacyFeedTimers,
  type LegacyRuntimeSurface
} from '../legacy-bridge/LegacyAgentRegistryFeed'
import {
  createLegacyLaunchObservation,
  type LegacyLaunchObservation
} from '../legacy-bridge/LegacyLaunchObservation'
import type { MirrorHalf } from '../legacy-bridge/settingsMirror/mirrorHalf'
import {
  createNotificationsMirrorHalf,
  reportNotificationsWrites
} from '../legacy-bridge/settingsMirror/notificationsHalf'
import {
  createSettingsMirrorBridge,
  type LegacySettingsWrites
} from '../legacy-bridge/settingsMirror/settingsMirrorBridge'
import {
  createStopEverything,
  STOP_EVERYTHING_REQUESTED,
  type StopAllRelay,
  type StopEverything
} from './window/application/stopEverything'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from './ipc/router'
import { LEGACY_BRIDGE_ADAPTERS, ROUTES, ROUTES_RELEASE } from './ipc/routes'
import type { ChannelRoute } from './ipc/channelRoute'
import type { TrayController } from './window/ports/trayController'
import type { PanelWindowController } from './window/ports/panelWindowController'
import type { ToggleShortcut } from './window/application/toggleShortcut'
import { startTrayProcess, type TrayProcess } from './window/application/trayMenu'
import {
  createStopEverythingRows,
  STOP_EVERYTHING_CONFIRM,
  STOP_EVERYTHING_CANCEL,
  STOP_EVERYTHING_REQUEST
} from './ipc/handlers/stopEverything'
import { NATIVE_ROWS } from './ipc/handlers/nativeRows'
import { createShortcutRows } from './ipc/handlers/shortcut'
import { ElectronSingleInstanceLock } from './window/adapters/ElectronSingleInstanceLock'
import { createModeWindowRegistry } from './window/application/modeWindowRegistry'
import { wireSecondLaunch } from './window/application/secondLaunch'
import type { SingleInstanceLock } from './window/ports/singleInstanceLock'
import { createUiPreferenceRows, UI_PREFERENCE_ROWS } from './ipc/handlers/uiPreferenceRows'
import { JsonUiPreferenceStore } from './window/adapters/JsonUiPreferenceStore'
import {
  createUiPreferences,
  TYPOGRAPHY_CHANGED_PUSH,
  type ModeWindowSender
} from './window/application/uiPreferences'
import type { UiPreferenceStore } from './window/ports/uiPreferenceStore'
import { NodeLogFiles } from './diagnostics/adapters/NodeLogFiles'
import type { UiClock } from './diagnostics/ports/clock'
import { createRendererDiagnostics } from './diagnostics/rendererDiagnostics'
import {
  createUiLogger,
  logLevelFromEnv,
  type UiLog,
  type UiLogEntry
} from './diagnostics/uiLogger'
import { installUiUncaughtHandlers } from './diagnostics/uncaught'
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
  HOST_CONNECTION_PUSH,
  HOST_CONNECTION_ROWS,
  pushHostConnection,
  type HostConnectionSource
} from './ipc/handlers/hostConnection'
import {
  createPanelWindow,
  PANEL_VISIBILITY_PUSH,
  type PanelWindowUseCases
} from './window/application/panelWindow'
import { currentUiPlatform, ElectronScreenArea } from './window/adapters/ElectronScreenArea'
import { uiDataDirectory } from './dataDirectory'
import {
  DEFAULT_TOGGLE_ACCELERATOR,
  PROTOCOL_VERSION,
  type ChannelKey,
  type StepId
} from '@dwarfai/contracts'
import { createNativeRows } from './ipc/handlers/nativeRows'
import { createAppInfo, type AppInfo } from './window/application/appInfo'
import { createNativeActions } from './window/application/nativeActions'
import { createToggleShortcut } from './window/application/toggleShortcut'
import { ElectronClipboard } from './window/adapters/ElectronClipboard'
import { ElectronExternalOpener } from './window/adapters/ElectronExternalOpener'
import { ElectronFilePicker } from './window/adapters/ElectronFilePicker'
import {
  currentShortcutPlatform,
  ElectronGlobalShortcut
} from './window/adapters/ElectronGlobalShortcut'
import { ElectronTray } from './window/adapters/ElectronTray'
import { ElectronNotificationDisplay } from './window/adapters/ElectronNotificationDisplay'
import { startNotificationPresenter } from './window/application/notificationPresenter'
import { drawsWithoutWindow } from './window/domain/trayNotificationGate'
import type {
  NotificationDisplay,
  NotificationWithdrawal
} from './window/ports/notificationDisplay'
import { readUserDataConfigFile } from './window/adapters/userDataConfigFile'
import type { HostClientService } from './host-client/HostClient'
import type { HostClient } from './window/ports/hostClient'
import { composeHostClient } from './host-client/composeHostClient'
import { mintRequestId } from './host-client/requestIds'
import {
  createNodeHostAttach,
  createNodeHostConnection,
  createNodeHungHostEnder,
  nodeHostManifestPath,
  winLaunchPrebuildsDir
} from './hostLauncher'
import { ElectronWindows, showRendererCrashedMessage } from './window/adapters/ElectronWindows'
import { startReopen, type Reopen } from './window/application/reopen'
import { InMemorySessionStore } from './window/adapters/InMemorySessionStore'
import {
  createUiSession,
  UI_SESSION_CHANGED_PUSH,
  type UiSession
} from './window/application/uiSession'
import { createUiSessionRows, UI_SESSION_ROWS } from './ipc/handlers/uiSession'
import { createUiPreferenceMapRows, UI_PREFERENCE_MAP_ROWS } from './ipc/handlers/uiPreferenceMap'
import { createUiPreferenceMap } from './window/application/uiPreferenceMap'
import { createUiPreferencesReset } from './window/application/uiPreferencesReset'
import {
  createUiPreferencesResetPush,
  UI_PREFERENCES_RESET_PUSH
} from './ipc/handlers/uiPreferencesReset'
import { createStartWithSystem, type StartWithSystem } from './window/application/startWithSystem'
import { ElectronAutostart } from './window/adapters/autostart/ElectronAutostart'
import { loginEntryOffered } from './window/domain/loginEntryGate'
import { LOGIN_ENTRY_ARGS, uiStartPlanOf, type UiStartPlan } from './window/domain/uiStart'

/** A window's contents, as the UI preference pushes need them (A-P6). */
export interface WindowContents extends ModeWindowSender {
  readonly webContentsId: number
}

/**
 * The router's one `ui-local` target (ADR-001 item 3), composed from the parts whose dependencies are given, each
 * owning its own rows (21 §1 item 1): the UI preference rows (ISSUE-048), A-N30 renderer diagnostics (ISSUE-055),
 * the Panel window rows (ISSUE-047), the Host connection rows A-N03, A-N05 (ISSUE-052), the native rows (ISSUE-050),
 * the shortcut rows (ISSUE-049), the tray's confirmation rows A-N27, A-N34 (ISSUE-053, ISSUE-316) and the UI session
 * rows A-N17, A-N18 (ISSUE-059) and, with the UI preferences, the UI preference map rows A-N20, A-N21 (ISSUE-060).
 * `undefined` when no part is present. The cut-0 switch (ISSUE-056) routes these rows here, but for the UI session and
 * UI preference map rows, which the cut-1 switch (ISSUE-123) routes.
 */
export function composeUiLocal({
  uiPreferences,
  uiLog,
  panelWindow,
  hostConnection,
  nativeRows,
  shortcut,
  stopEverything,
  uiSession,
  startWithSystem,
  modeWindows,
  clock = { now: () => Date.now() }
}: {
  uiPreferences?: UiMainDeps['uiPreferences']
  uiLog?: UiLog
  panelWindow?: PanelWindowUseCases
  hostConnection?: HostConnectionSource
  nativeRows?: RouteTarget
  shortcut?: Pick<ToggleShortcut, 'state' | 'set'>
  stopEverything?: Pick<StopEverything, 'confirm' | 'cancel' | 'requestFromWindow'>
  uiSession?: Pick<UiSession, 'get' | 'patch'>
  /** "Start with the system", served by A-N20 / A-N21 only where S-027-4 passed (loginEntryGate.ts). */
  startWithSystem?: Pick<StartWithSystem, 'stored' | 'toggle'>
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
    parts.push({
      channels: UI_PREFERENCE_MAP_ROWS,
      target: createUiPreferenceMapRows(
        createUiPreferenceMap(startWithSystem === undefined ? {} : { startWithSystem })
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
  if (nativeRows !== undefined) {
    parts.push({ channels: NATIVE_ROWS, target: nativeRows })
  }
  if (shortcut !== undefined) {
    const rows = createShortcutRows(shortcut)
    parts.push({
      channels: ['shortcut:get', 'shortcut:set'],
      // The gate parsed A-11's payload: a string reaches the setter (14 §2.1; shortcut.ts).
      target: {
        serve: (channel, payload) =>
          Promise.resolve(
            channel === 'shortcut:set'
              ? rows['shortcut:set'](payload as string)
              : rows['shortcut:get']()
          )
      }
    })
  }
  if (stopEverything !== undefined) {
    parts.push({
      channels: [STOP_EVERYTHING_CANCEL, STOP_EVERYTHING_REQUEST],
      target: createStopEverythingRows(stopEverything)
    })
  }
  if (uiSession !== undefined) {
    parts.push({
      channels: UI_SESSION_ROWS,
      // Until the window factory registers each window's mode (ISSUE-046), the one mode window is the Panel.
      target: createUiSessionRows(uiSession, (id) => (modeWindows.has(id) ? 'panel' : undefined))
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

/** A-12 `getMines` (invoke) and A-P2 `onMinesUpdated` (push): RETIRE rows of the Host (14 §2.1). */
const BOARD_READ = 'mines:get' satisfies ChannelKey
const BOARD_PUSH = 'mines:update' satisfies ChannelKey

export interface BoardFacadeComposition {
  /** The `host` target part serving A-12. */
  part: RouteTargetPart
  dispose(): void
}

/**
 * `BoardFacadeAdapter` (21 §3, cuts 1–4; 14 §5): A-12 and A-P2 from the Host board in today's `MinesSnapshot`, for the
 * composables not yet switched to A-N01/A-N02. Composed once the table routes A-12 to the Host (the cut-1 switch,
 * ISSUE-123), as a part of the `host` target; A-P2 reaches the mode windows only while the table routes it to the Host
 * too, so today's runtime and the facade never push the board together (21 §1 item 4). `undefined` in a table that
 * serves A-12 `legacy`. Deleted at cut 5 after a test proves no consumer (ISSUE-242).
 */
export function composeBoardFacade(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'subscribe'>
  windows: () => readonly WindowContents[]
  defer?: (run: () => void) => void
}): BoardFacadeComposition | undefined {
  const toHost = (channel: ChannelKey): boolean =>
    deps.routes.some((r) => r.channel === channel && r.owner === 'host')
  if (!toHost(BOARD_READ)) return undefined
  const pushes = toHost(BOARD_PUSH)
  const facade = createBoardFacadeAdapter({
    client: deps.client,
    push: (board) => {
      if (pushes) for (const window of deps.windows()) window.send(BOARD_PUSH, board)
    },
    ...(deps.defer === undefined ? {} : { defer: deps.defer })
  })
  return {
    part: {
      channels: [BOARD_READ],
      target: { serve: () => Promise.resolve(facade.getMines()) }
    },
    dispose: () => facade.dispose()
  }
}

/** Whether the legacy-bridge adapter `name` lives in `release`: composed exactly in the steps 21 §3 lists it for. */
function bridgeLivesIn(name: string, release: StepId): boolean {
  return LEGACY_BRIDGE_ADAPTERS.some(
    (adapter) => adapter.name === name && adapter.cuts.includes(release)
  )
}

/** Runs `run` every `ms` on Node's timers. */
const realInterval: LegacyFeedTimers = {
  every: (ms, run) => {
    const timer = setInterval(run, ms)
    return () => clearInterval(timer)
  }
}

export type { LegacyRuntimeSurface }

/**
 * `LegacyAgentRegistryFeed` (21 §3, cuts 1–4; ADR-001 Consequences): from cut 1 the Host observer is the only observer,
 * and only the legacy providers' session discovery stays composed, into the legacy runtime's in-memory agent registry,
 * so the rows still `legacy` (send, console, stop, asks) find their dwarf and the Codex pending questions. Composed in
 * the releases it is listed for (cut 1, its rollback build included, to the end of cut 4), never in the cut-0 table,
 * and only over a bound legacy surface. The cut-1 switch (ISSUE-123) turns the rest of today's observer off.
 */
export function composeLegacyAgentRegistryFeed(deps: {
  release: StepId
  legacy: LegacyRuntimeSurface | undefined
  modes?: LegacyFeedModes
  timers?: LegacyFeedTimers
}): LegacyAgentRegistryFeed | undefined {
  if (deps.legacy === undefined || !bridgeLivesIn('LegacyAgentRegistryFeed', deps.release)) {
    return undefined
  }
  return createLegacyAgentRegistryFeed({
    legacy: deps.legacy,
    modes: deps.modes ?? LEGACY_FEED_PROVIDERS_CUT_1,
    timers: deps.timers ?? realInterval
  })
}

/**
 * `LegacyLaunchObservation` (21 §3, cuts 1–4b; 14 §5): a session today's runtime launched is an observed session for the
 * Host, found in its provider's files like any other; the legacy runtime keeps its launch channel, which from cut 1 is
 * reached through this bridge (the A-N26 end-first relay). Composed in the releases it is listed for, never in the
 * cut-0 table; deleted at the end of 4b (ISSUE-240).
 */
export function composeLegacyLaunchObservation(deps: {
  release: StepId
  launches: LegacyLaunchedSessions
}): LegacyLaunchObservation | undefined {
  if (!bridgeLivesIn('LegacyLaunchObservation', deps.release)) return undefined
  return createLegacyLaunchObservation({ launches: deps.launches })
}

/** An open window of the app, as the pushes reach it. */
export interface AppWindow extends WindowContents {
  close(): void
}

/** The pushes UI main sends itself: A-P1, A-P6, A-N04 and A-N25, its `ui-local` push rows in cut 0 (14 §2). */
export const UI_MAIN_PUSHES: readonly ChannelKey[] = [
  PANEL_VISIBILITY_PUSH,
  TYPOGRAPHY_CHANGED_PUSH,
  HOST_CONNECTION_PUSH,
  STOP_EVERYTHING_REQUESTED
]

/**
 * The rows whose today's handlers need today's window, tray or shortcut (A-01…A-05, A-08…A-11): the window family that
 * moves as one, so today's window and the rebuilt one never serve the same app at once (21 §1 item 4).
 */
const WINDOW_FAMILY: readonly ChannelKey[] = [...PANEL_ROWS, 'shortcut:get', 'shortcut:set']

/**
 * Who serves the window family in a route table: today's runtime with its own window, tray and shortcut (before cut 0,
 * or a rollback build, 21 §2.1), or the rebuilt window module (from cut 0). A table that splits the family is a
 * composition defect and stops the start.
 */
export function windowFamilyOwner(routes: readonly ChannelRoute[]): 'legacy' | 'ui-local' {
  const owners = new Set(
    routes.filter((route) => WINDOW_FAMILY.includes(route.channel)).map((route) => route.owner)
  )
  if (owners.size === 1 && (owners.has('legacy') || owners.has('ui-local'))) {
    return owners.has('legacy') ? 'legacy' : 'ui-local'
  }
  throw new Error(`the route table splits the window family: ${[...owners].join(', ')}`)
}

/** The steps of the start once Electron is ready, as `ui.start` names the one that failed. */
export type UiStartStep = 'ready' | 'panel-load' | 'shortcut' | 'tray' | 'legacy-compose'

/** What `errCode` may hold (19 §9.6; the UI writer's own shape): a code or a class name, never a sentence. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * The record of a start that failed (new 19 §9.1 event `ui.start`, outcome `failed`): the step and the error's code or
 * class name. Nothing the error says goes in: its message can hold a path or a person's words (ADR-026 item 4).
 */
export function uiStartFailed(step: UiStartStep, error: unknown): UiLogEntry {
  const code = (error as { code?: unknown } | null)?.code
  const name = error instanceof Error ? error.name : undefined
  const errCode = [code, name].find(
    (value): value is string => typeof value === 'string' && ERROR_CODE.test(value)
  )
  return {
    level: 'error',
    event: 'ui.start',
    subsystem: 'ui-main',
    outcome: 'failed',
    causeClass: step,
    errCode: errCode ?? 'unknown'
  }
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
  legacyRuntime: Pick<
    LegacyRuntimeRoute,
    'compose' | 'serve' | 'beforeQuit' | 'willQuit' | 'liveLaunches' | 'endLaunch'
  >
  /** The route table (default `ROUTES`, the release's own); a test or a rollback table is passed here. */
  routes?: readonly ChannelRoute[]
  /** The release the table is for (default `ROUTES_RELEASE`): which legacy-bridge adapters live (21 §3). */
  release?: StepId
  /**
   * Today's runtime as `LegacyAgentRegistryFeed` is handed it (21 §3, cuts 1–4): its providers' discovery and its
   * in-memory agent registry. Without it, or in a release the feed is not listed for, no feed is composed.
   */
  legacyRegistry?: LegacyRuntimeSurface
  /** Every open window of the app (A-N04, A-N25 pushes; the tray's Quit closes them). */
  appWindows?: () => readonly AppWindow[]
  /** The rebuilt tray (ISSUE-053): its icon and the id of each new confirmation. */
  tray?: { controller: TrayController; newConfirmationId(): string }
  /** The rebuilt global shortcut over the Panel (ISSUE-049). */
  shortcut?: (panel: PanelWindowController) => ToggleShortcut
  /** The links, clipboard, pickers and build info rows (ISSUE-050). */
  nativeRows?: RouteTarget
  /** Electron's `ipcMain`, where the router registers the seam A listeners (ADR-001 item 3). */
  ipc: IpcMainRegistrar
  /** The app's own entry, the only page whose calls the seam A gate accepts (ADR-019 item 8). */
  appEntry: string
  /**
   * The persisted UI preference stores (ISSUE-048, ADR-024 item 1) and every window's contents, for the A-P6 push to
   * the mode windows. Its rows are a `ui-local` route target from the cut-0 switch (ISSUE-056); a table that
   * serves them `legacy` (a rollback build) leaves today's runtime writing today's files.
   */
  uiPreferences?: { store: UiPreferenceStore; windows(): readonly WindowContents[] }
  /**
   * The UI logger (ADR-026; 05 §3.14): A-N30 renderer diagnostics join the `ui-local` target with it, and a failed start
   * is recorded in it (`ui.start`) and written out before the process exits.
   */
  uiLog?: UiLog & { flush?(): Promise<void> }
  /**
   * The rebuilt Panel window (ISSUE-047), composed over the mode-window registry. Its rows join the `ui-local` target;
   * from the cut-0 switch (ISSUE-056) the root loads it at start and today's runtime composes no window of its own. In
   * a table that serves the window family `legacy` nothing calls it: it builds no window and writes no preference, and
   * today's runtime keeps the one Panel window (21 §1 item 4).
   */
  panelWindow?: (modeWindows: ModeWindowRegistry) => PanelWindowUseCases
  /**
   * The Host attach (ISSUE-051; ADR-002 D4; ADR-003 items 7, 12): HostClient over the host launcher. The root reads
   * the remembered launch view, then starts the attach without awaiting it, before Electron is ready and the window
   * is composed, so the first paint never waits for the Host (US-RES-003.AC07); the board it keeps changes only when a
   * whole snapshot arrived (window/application/reopen.ts). Its Host connection rows A-N03, A-N05 join the `ui-local`
   * target (ISSUE-052), and the root pushes A-N04 once the table routes it (the cut-0 switch, ISSUE-056); without their
   * routes the router refuses them and no seam A row reaches the client. An OS
   * resume wakes it (13 FM-109). Disposed at will-quit, so a closing app never reconnects or respawns.
   */
  host?: { client: HostClientService }
  /**
   * `SettingsMirrorBridge` (21 §3, cuts 1–3e; ISSUE-214): the legacy store's write notifications and the halves whose
   * non-secret Host-read preferences are mirrored into the Host with `preferences.set`. Composed over the Host attach
   * (`host`) and disposed at will-quit; deleted in 4a, when the direction flips.
   */
  settingsMirror?: { legacy: LegacySettingsWrites; halves: readonly MirrorHalf[] }
  /**
   * Level-3 OS notifications (ISSUE-113; ADR-018 items 5, 7): the display adapter and whether S-018-1 passed on this OS.
   * With the rebuilt window family, the Host attach and the UI log, the root draws the `notifier` connection's
   * `attention.notify` / `attention.withdraw` frames for the process's life (window/application/notificationPresenter.ts).
   */
  notifications?: {
    display: NotificationDisplay & NotificationWithdrawal
    drawsWithoutWindow: boolean
  }
  /**
   * How this process was started (07 machine 10): a normal launch, or a `--background` start by the login entry or the
   * Host, which is tray-only and builds no window until the person opens the app (S10.03, S10.13). Default normal.
   */
  launch?: UiStartPlan
  /**
   * "Start with the system" (ISSUE-060; 07 machine 40; ADR-027 item 7): re-applied at every start, normal or
   * `--background`, once Electron is ready and before any window (S40.01, S40.02), and served by A-N20 / A-N21. Composed
   * only where S-027-4 passed (`loginEntryGate.ts`); elsewhere today's candidate autostart stays the one writer of the
   * entry until v1 (21 §2 cut 1).
   */
  startWithSystem?: StartWithSystem
}

/** What a started root holds: the reopen state when the Host attach was composed. */
export interface UiMainStarted {
  reopen: Reopen | null
}

/**
 * The Electron composition root (05 §2.3; 16 §8.4; ADR-001 item 3). The single-instance lock is
 * taken first; a process that does not get it quits before composing anything (UC-033, PO #73).
 * The holder registers the router's seam A listeners (ISSUE-043) right after the lock, dispatching
 * each call by the route table (`ipc/routes.ts`), and wires the second-launch use case (S10.02).
 * With `host`, the root reads the launch view and starts the Host attach (ISSUE-051) before
 * Electron is ready, never awaiting it.
 *
 * Who owns the window depends on the table (21 §2 cut 0, ISSUE-056):
 *
 * - The window family served `ui-local` (cut 0 on): once Electron is ready the rebuilt Panel is
 *   built hidden with its page loading, as today's start did; the rebuilt shortcut is claimed, the
 *   rebuilt tray shows Open, Quit and Stop everything and quit (ADR-018 item 5; ADR-002 D7), and
 *   A-N26 reaches the Host through `LegacyEndFirstAdapter` (21 §3); A-N04 is pushed on every Host
 *   connection change. Today's runtime is composed through `LegacyRuntimeRoute` without its window,
 *   tray or shortcut, and a second launch shows the rebuilt Panel.
 * - The window family served `legacy` (before cut 0, or a rollback build, 21 §2.1): today's runtime
 *   is composed with its own window, tray and shortcut, and a second launch shows its Panel.
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
  routes = ROUTES,
  release = ROUTES_RELEASE,
  legacyRegistry,
  appWindows = () => [],
  tray,
  shortcut,
  nativeRows,
  uiPreferences,
  uiLog,
  panelWindow,
  host,
  settingsMirror,
  notifications,
  launch = { kind: 'normal', tray: true, window: true },
  startWithSystem
}: UiMainDeps): Promise<UiMainStarted | undefined> {
  if (!lock.acquire()) {
    lifecycle.quit()
    return undefined
  }
  // The mode windows (ADR-019 item 8): every window this process creates is registered, before anything is composed,
  // so the window is known before its page is loaded. Since cut 0 that is the rebuilt Panel; in a rollback build,
  // today's Panel shell window.
  const modeWindows = createModeWindowRegistry()
  lifecycle.onWindowCreated(({ webContentsId, onClosed }) => {
    modeWindows.register(webContentsId)
    onClosed(() => modeWindows.drop(webContentsId))
  })
  const rebuilt = windowFamilyOwner(routes) === 'ui-local'
  const panel = panelWindow?.(modeWindows)
  if (rebuilt && panel === undefined) {
    throw new Error(
      'the route table serves the window family ui-local but no rebuilt Panel was composed'
    )
  }
  /** The open mode windows, for the pushes UI main sends (A-N04, A-N25). */
  const modeWindowList = (): readonly AppWindow[] =>
    appWindows().filter((window) => modeWindows.has(window.webContentsId))
  const routed = (channel: ChannelKey): boolean => routes.some((r) => r.channel === channel)
  // The UI-main session store (ISSUE-059; ADR-024 items 1, 3): in memory, shared by the mode windows, pushed to them
  // (A-N19) once the table routes the push, and cleared on every entry into tray-only (below).
  const uiSession =
    host === undefined
      ? undefined
      : createUiSession({
          store: new InMemorySessionStore(),
          windows: () =>
            routed(UI_SESSION_CHANGED_PUSH)
              ? modeWindowList().map((window) => ({
                  webContentsId: window.webContentsId,
                  send: (push: string, payload: unknown) => window.send(push, payload)
                }))
              : [],
          host: host.client
        })

  // The Reset metrics UI step (ISSUE-061; ADR-024 item 8): composed with the Host attach whatever the table serves, so
  // the saga's `ui-prefs` step never waits on this UI; A-N12 reaches the mode windows once the table routes the push.
  // It hears the Host before the reopen starts the attach, so the first snapshot already reaches it.
  const uiPreferencesReset =
    host === undefined || uiPreferences === undefined || uiSession === undefined
      ? undefined
      : createUiPreferencesReset({
          store: uiPreferences.store,
          session: uiSession,
          ...(startWithSystem === undefined ? {} : { startWithSystem }),
          push: createUiPreferencesResetPush(() =>
            routed(UI_PREFERENCES_RESET_PUSH) ? modeWindowList() : []
          ),
          host: host.client
        })
  const stopResetListening = uiPreferencesReset?.listen()

  // From cut 1 to the end of cut 4 (21 §3): a session today's runtime launched is observed by the Host like any other,
  // and today's runtime keeps its launch channel; only the registry-only discovery of today's observer stays composed.
  const launchObservation = composeLegacyLaunchObservation({ release, launches: legacyRuntime })
  const registryFeed = composeLegacyAgentRegistryFeed({ release, legacy: legacyRegistry })

  // The rebuilt window module's owners, only where the table gives them their rows (21 §1 item 1).
  const toggle = rebuilt && panel !== undefined ? shortcut?.(panel) : undefined
  const stop =
    rebuilt && panel !== undefined && host !== undefined && tray !== undefined
      ? createStopEverything({
          host: host.client,
          // The confirmation shows in the Panel: a hidden Panel is shown first (US-RES-002.AC08; S10.18).
          windows: {
            anyOpen: () => panel.visible(),
            open: () => panel.show(),
            push: (channel, payload) => {
              for (const window of modeWindowList()) window.send(channel, payload)
            }
          },
          newConfirmationId: () => tray.newConfirmationId(),
          relay: composeStopAllRelay(launchObservation?.channel ?? legacyRuntime)
        })
      : undefined

  // A-12 and A-P2 from the Host board, once the table routes them there (the cut-1 switch, ISSUE-123; 21 §3).
  const boardFacade =
    host === undefined
      ? undefined
      : composeBoardFacade({ routes, client: host.client, windows: modeWindowList })
  const stopRows = stop === undefined ? undefined : createStopEverythingRows(stop)
  const hostTarget =
    boardFacade === undefined
      ? stopRows
      : composeRouteTargets([
          ...(stopRows === undefined
            ? []
            : [
                { channels: [STOP_EVERYTHING_CONFIRM], target: stopRows } satisfies RouteTargetPart
              ]),
          boardFacade.part
        ])

  // Level-3 OS notifications (ISSUE-113; ADR-018 items 5, 7): the notifier connection's frames, from the start of the
  // attach, are drawn once Electron is ready (a notification cannot be built before), in arrival order; where S-018-1
  // has not passed, only while the Panel is shown (window/domain/trayNotificationGate.ts).
  const notificationPresenter =
    rebuilt &&
    panel !== undefined &&
    host !== undefined &&
    uiLog !== undefined &&
    notifications !== undefined
      ? startNotificationPresenter({
          onAttentionFrame: (handler) => {
            const ready = lifecycle.whenReady()
            return host.client.onAttentionFrame((frame) => void ready.then(() => handler(frame)))
          },
          display: notifications.display,
          drawsWithoutWindow: notifications.drawsWithoutWindow,
          anyWindowOpen: () => panel.visible(),
          log: uiLog
        })
      : undefined

  // Every seam A call goes through the router table from the first renderer load (21 §1 item 1), behind the gate
  // that checks its sender and its payload (ADR-019 items 7, 8).
  const uiLocal = composeUiLocal({
    uiPreferences,
    uiLog,
    ...(panel === undefined ? {} : { panelWindow: panel }),
    ...(host === undefined ? {} : { hostConnection: host.client }),
    ...(nativeRows === undefined ? {} : { nativeRows }),
    ...(toggle === undefined ? {} : { shortcut: toggle }),
    ...(stop === undefined ? {} : { stopEverything: stop }),
    ...(uiSession === undefined ? {} : { uiSession }),
    ...(startWithSystem === undefined ? {} : { startWithSystem }),
    modeWindows
  })
  createRouter({
    routes,
    legacy: legacyRuntime,
    ...(uiLocal ? { uiLocal } : {}),
    // A-N26, the one `host` row of cut 0: its handler relays `host.shutdown` on the confirmation's `ui` connection.
    ...(hostTarget === undefined ? {} : { host: hostTarget }),
    senders: { appEntry, isModeWindow: (id) => modeWindows.has(id) }
  }).register(ipc)
  const secondLaunch = wireSecondLaunch(lock)
  // The launch view, then the Host attach in parallel: neither waits for the other or holds the window back.
  const reopen =
    host === undefined ? null : startReopen({ store: uiPreferences?.store, host: host.client })
  // A-N04: every Host connection change reaches the mode windows, once the table routes the push.
  const stopConnectionPush =
    host !== undefined && routed(HOST_CONNECTION_PUSH)
      ? pushHostConnection(host.client, (view) => {
          for (const window of modeWindowList()) window.send(HOST_CONNECTION_PUSH, view)
        })
      : undefined
  // The legacy store stays the source of truth for the settings rows until 4a: the mirror keeps the Host's copy of
  // its halves' preferences equal to it (21 §3).
  const mirror =
    host === undefined || settingsMirror === undefined
      ? undefined
      : createSettingsMirrorBridge({
          hostClient: host.client,
          legacy: settingsMirror.legacy,
          halves: settingsMirror.halves,
          newRequestId: () =>
            mintRequestId({ now: () => Date.now(), random: (n) => randomBytes(n) })
        })
  let trayProcess: TrayProcess | null = null
  lifecycle.onResume?.(() => host?.client.wake())
  lifecycle.onBeforeQuit(() => legacyRuntime.beforeQuit())
  lifecycle.onWillQuit(() => {
    toggle?.dispose()
    trayProcess?.dispose()
    notificationPresenter?.dispose()
    stopConnectionPush?.()
    uiSession?.dispose()
    stopResetListening?.()
    mirror?.dispose()
    boardFacade?.dispose()
    registryFeed?.stop()
    host?.client.dispose()
    legacyRuntime.willQuit()
  })
  // The app lives in the tray with every window hidden: closing the last window never quits it
  // (only Stop everything and quit does; before cut 0, today's tray Quit), as today. It enters tray-only, so the UI
  // session store is cleared (S10.14; ADR-024 item 3).
  lifecycle.onWindowAllClosed(() => uiSession?.clear())
  /** The step of the start running now, recorded when the start fails (`ui.start`). */
  let step: UiStartStep = 'ready'
  try {
    await lifecycle.whenReady()
    // "Start with the system" is applied before any window (S40.01, S40.02); a refusal is logged, never shown (S40.07).
    startWithSystem?.applyAtStart()
    if (rebuilt && panel !== undefined) {
      // A second launch shows the rebuilt Panel from now on; it is built hidden with its page loading, as today's
      // start built today's (`LegacyRuntimeRoute` serves the legacy rows once today's runtime is composed). A
      // `--background` start builds no window: the Panel is built when the person opens the app (S10.03, S10.13).
      secondLaunch.attach(panel)
      step = 'panel-load'
      if (launch.window) panel.load()
      step = 'shortcut'
      toggle?.start()
      step = 'tray'
      if (stop !== undefined && tray !== undefined && host !== undefined) {
        trayProcess = startTrayProcess({
          tray: tray.controller,
          // Cut 0 has one mode window, the Panel: Open shows it, Quit hides it (the frozen window ports give the use
          // case no close of its window, so it is hidden as today's close did); nothing ends (S10.13, S10.15).
          windows: {
            anyOpen: () => panel.visible(),
            open: () => panel.show(),
            closeAll: () => panel.hide()
          },
          // Quit enters tray-only: the UI-main session store is cleared (S10.15; ADR-024 item 3).
          sessionStore: { clear: () => uiSession?.clear() },
          stopEverything: stop,
          onHostClosing: (h) => host.client.onClosing(h),
          exit: () => lifecycle.quit(),
          // No system tray (13 FM-050): the Panel is the only way back to the app, so it is shown; the renderer
          // offers Stop everything and quit there (A-N34).
          offerFromWindow: () => panel.show()
        })
      }
      step = 'legacy-compose'
      await legacyRuntime.compose()
    } else {
      step = 'legacy-compose'
      const legacyPanel = await legacyRuntime.compose()
      if (legacyPanel === null) throw new Error('today’s runtime composed no Panel window')
      // Today's Panel window answers a second launch (before cut 0, or a rollback build).
      secondLaunch.attach(legacyPanel)
    }
    // The registry-only discovery runs over today's composed runtime (21 §3 `LegacyAgentRegistryFeed`).
    registryFeed?.start()
  } catch (error) {
    // The start cannot go on. The UI log says which step failed and the error's class or code, never its message
    // (ADR-026 items 3-4), and is written out before the process ends; today's composition also reports its own
    // failure before it rethrows (LegacyRuntimeRoute).
    uiLog?.record(uiStartFailed(step, error))
    await uiLog?.flush?.().catch(() => {})
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
 * reads no store and touches no display: the window is built on the first call that needs it (from cut 0, the root's
 * `load` once Electron is ready), and Electron's `screen` is read only after the app is ready. `composed()` answers the
 * use cases once the root composed them, for today's runtime to reach the Panel (`LegacyPanelSurface`).
 */
function electronPanelWindow(store: UiPreferenceStore): {
  factory: (modeWindows: ModeWindowRegistry) => PanelWindowUseCases
  composed(): PanelWindowUseCases | null
} {
  let panel: PanelWindowUseCases | null = null
  const factory = (modeWindows: ModeWindowRegistry): PanelWindowUseCases => {
    const screenArea = new ElectronScreenArea(() => screen, currentUiPlatform())
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
  return { factory, composed: () => panel }
}

/**
 * The native rows over Electron (ISSUE-050; 14 §2.1 A-21, A-22, A-24, A-28, A-29): the attachment picker attached to
 * the Panel window, the system clipboard, the allowlisted external opener, and the build info and feature flags. The
 * flags are read on the first call (`contracts/config` over the environment and the userData config file): today's
 * runtime reads the same layers when it is composed and stops the start on a wrong value, so UI main never answers
 * from a configuration today's runtime refused.
 */
function electronNativeRows(panelWindow: () => BrowserWindow | undefined): RouteTarget {
  let info: AppInfo | null = null
  const appInfo = (): AppInfo =>
    (info ??= createAppInfo({
      build: { version: app.getVersion(), packaged: app.isPackaged },
      env: process.env,
      readConfigFile: () => readUserDataConfigFile(app.getPath('userData'))
    }))
  return createNativeRows({
    actions: createNativeActions({
      files: new ElectronFilePicker({
        dialog,
        windowOf: (ref) => BrowserWindow.fromId(ref.windowId)
      }),
      clipboard: new ElectronClipboard(clipboard),
      opener: new ElectronExternalOpener(shell),
      // Cut 0 has one mode window, the Panel, where every attach control is pressed.
      parentWindow: () => ({ windowId: panelWindow()?.id ?? -1 })
    }),
    appInfo: { build: () => appInfo().build(), featureFlags: () => appInfo().featureFlags() }
  })
}

/** The git commit (short) of this build (20 §3.1), stamped by the app's electron-vite build. */
declare const __DWARFAI_BUILD_ID__: string

/**
 * HostClient over the Node host launcher (ISSUE-051; ADR-002 D2, D4, D5): the Host data folder is the UI's data folder
 * (`dataDirectory.ts`: userData, or `DwarfAI-dev` for a development build, ADR-005 item 6) + `/host`;
 * the Host runs `out/host/main.js` of this build from its versioned copy, checked against `host-manifest.json`: beside
 * this bundle's `out/` in development, in the resources folder once packaged (nodeHostManifestPath); the Windows
 * launch helper loads from the app root's `prebuilds/`.
 */
function electronHostClient(uiLog: UiLog, dataDir: string): HostClientService {
  const outDir = join(import.meta.dirname, '..')
  const hostDataDir = join(dataDir, 'host')
  const client = { appVersion: app.getVersion(), buildId: __DWARFAI_BUILD_ID__ }
  // Every attach is held to the ADR-002 D8 upgrade handshake first (composeHostClient.ts).
  return composeHostClient({
    ...createNodeHostAttach({
      hostDataDir,
      // A dev or preview build's copies stay apart from the installed release build's (ADR-005 item 6).
      build: app.isPackaged ? 'release' : 'dev',
      execPath: process.execPath,
      hostManifest: nodeHostManifestPath({
        packaged: app.isPackaged,
        outDir,
        resourcesPath: process.resourcesPath
      }),
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

/**
 * "Start with the system" over `ElectronAutostart` (ISSUE-060; ADR-027 item 7), only in a packaged build of an OS where
 * S-027-4 passed (`loginEntryGate.ts`): a development run never writes a login entry, and until the spike record
 * exists today's candidate autostart (`LegacyRuntimeRoute`) stays the one writer of the entry (21 §2 cut 1, §1 item
 * 4). The entry starts this executable, the channel's launch path, with `--background`; its Run value carries the
 * name today's candidate writes, so the switch replaces that value rather than adding a second one.
 */
function electronStartWithSystem(
  store: UiPreferenceStore,
  uiLog: UiLog
): Pick<UiMainDeps, 'startWithSystem'> {
  const platform = currentUiPlatform()
  if (!app.isPackaged || !loginEntryOffered(platform)) return {}
  return {
    startWithSystem: createStartWithSystem({
      autostart: new ElectronAutostart({
        platform,
        app,
        launchPath: process.execPath,
        args: LOGIN_ENTRY_ARGS,
        name: 'DwarfAI-Miners',
        home: app.getPath('home'),
        env: process.env
      }),
      store,
      log: (record) => uiLog.record(record)
    })
  }
}

// The Electron wiring: the lock first, then the rest (16 §8.4). It runs only when Electron's main
// process loads this file as its entry (`process.type === 'browser'`), never when a test imports
// `startUiMain` from it. From cut 0 it is the app's Electron entry (21 §2 cut 0, ISSUE-056).
if (process.type === 'browser') {
  // The rebuilt UI's data folder: userData, or `DwarfAI-dev` for a development or preview build whose userData is the
  // release folder (ADR-005 item 6; dataDirectory.ts). Today's runtime keeps userData (ISSUE-056 decision).
  const dataDir = uiDataDirectory({
    platform: currentUiPlatform(),
    isPackaged: app.isPackaged,
    appData: app.getPath('appData'),
    userData: app.getPath('userData')
  })
  const uiLog = createUiLogger({
    files: new NodeLogFiles(),
    logDir: join(dataDir, 'logs'), // ADR-026 item 1, the folder the Host writes into too
    clock: { now: () => Date.now() },
    appVersion: app.getVersion(),
    pid: process.pid,
    level: logLevelFromEnv(process.env),
    appRoot: app.getAppPath()
  })
  // 19 §9.1 `uncaught`, §11 (FM-041): from the first moment the logger exists, an uncaught error is logged, flushed
  // and ends Electron main non-zero; the listener also keeps Electron's own error dialog from opening.
  installUiUncaughtHandlers({ process, log: uiLog, exit: (code) => app.exit(code) })
  // ADR-019 items 2–4 (ISSUE-046): the navigation guard from the first webContents, then the permission denial and
  // the CSP once Electron is ready. From cut 0 the secure window factory builds the Panel (ISSUE-047) with a preload
  // that loads sandboxed (ISSUE-045); a rollback build's table gives the window back to today's runtime.
  installWindowHardening({
    app,
    session: () => session.defaultSession,
    openExternal: (url) => void shell.openExternal(url),
    appEntry: appEntryUrl(),
    devHmrOrigin: app.isPackaged ? undefined : devHmrOriginOf(process.env.ELECTRON_RENDERER_URL)
  })
  // The UI preference files of the data folder (ADR-024 item 1); their log records (19 §9.6 `uiprefs.corrupt`,
  // `uiprefs.write-failed`) go to the UI log segments.
  const uiPreferenceStore = new JsonUiPreferenceStore({
    dir: dataDir,
    log: (record) => uiLog.record(record)
  })
  /** Every open window of the app: in cut 0, the rebuilt Panel (the one window UI main builds). */
  const appWindows = (): AppWindow[] =>
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => ({
        webContentsId: window.webContents.id,
        send: (push, payload) => window.webContents.send(push, payload),
        close: () => window.close()
      }))
  /** The window a picker is attached to: the rebuilt Panel when it is open. */
  const panelBrowserWindow = (): BrowserWindow | undefined =>
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  const rebuiltPanel = electronPanelWindow(uiPreferenceStore)
  // Today's runtime, without its window, tray and shortcut once the table serves the window family `ui-local`: its
  // pushes, pickers and notification click reach the rebuilt Panel (21 §2 cut 0; LegacyRuntimeRoute).
  const legacyPanel: LegacyPanelSurface = {
    send: (channel, payload) => {
      for (const window of appWindows()) window.send(channel, payload)
    },
    visible: () => rebuiltPanel.composed()?.visible() ?? false,
    show: () => rebuiltPanel.composed()?.show(),
    showOpenDialog: (options) => {
      const parent = panelBrowserWindow()
      return parent === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(parent, options)
    }
  }
  // The legacy store's saves of Host-read preferences, for `SettingsMirrorBridge` (21 §3): the notifications half
  // (ISSUE-116, from cut 1) reports today's A-43 saves through the route the router serves the legacy rows with.
  const legacySettingsWrites = createLegacySettingsWriteHub()
  const legacyRuntime = reportNotificationsWrites(
    createLegacyRuntimeRoute(
      composeLegacyRuntime(
        { app, dialog, nativeImage, shell, clipboard, globalShortcut },
        windowFamilyOwner(ROUTES) === 'ui-local'
          ? { panel: legacyPanel, log: uiLog }
          : { log: uiLog }
      )
    ),
    legacySettingsWrites
  )
  void startUiMain({
    lock: new ElectronSingleInstanceLock(app),
    lifecycle: electronLifecycle(),
    legacyRuntime,
    ipc: electronIpcMain(),
    appEntry: appEntryUrl(),
    appWindows,
    uiPreferences: { store: uiPreferenceStore, windows: appWindows },
    uiLog,
    panelWindow: rebuiltPanel.factory,
    nativeRows: electronNativeRows(panelBrowserWindow),
    shortcut: (panel) =>
      createToggleShortcut({
        registry: new ElectronGlobalShortcut(globalShortcut),
        preference: {
          load: () => uiPreferenceStore.load('shortcut') ?? DEFAULT_TOGGLE_ACCELERATOR,
          save: (accelerator) => uiPreferenceStore.save('shortcut', accelerator)
        },
        panel,
        platform: currentShortcutPlatform()
      }),
    tray: {
      controller: new ElectronTray(
        {
          createTray: (image) => new Tray(image as NativeImage),
          buildMenu: (template) => Menu.buildFromTemplate(template),
          iconFromPath: (path) => nativeImage.createFromPath(path)
        },
        resourcePath('tray-icon.png')
      ),
      newConfirmationId: () => randomUUID()
    },
    host: { client: electronHostClient(uiLog, dataDir) },
    notifications: {
      display: new ElectronNotificationDisplay({
        notification: Notification,
        platform: currentUiPlatform(),
        setAppUserModelId: (id) => app.setAppUserModelId(id),
        log: uiLog
      }),
      drawsWithoutWindow: drawsWithoutWindow(currentUiPlatform())
    },
    launch: uiStartPlanOf(process.argv),
    ...electronStartWithSystem(uiPreferenceStore, uiLog),
    // The halves register here with their legacy saves wired to the hub (ISSUE-116 from cut 1, ISSUE-194 from 3a).
    settingsMirror: {
      legacy: legacySettingsWrites,
      halves: [createNotificationsMirrorHalf(legacyRuntime)]
    }
  })
}
