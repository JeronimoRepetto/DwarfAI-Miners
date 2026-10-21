import { config as loadDotenv } from 'dotenv'
import { homedir } from 'node:os'
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
  createStopEverything,
  STOP_EVERYTHING_REQUESTED,
  type StopEverything
} from './window/application/stopEverything'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from './ipc/router'
import { ROUTES, routesForBuild } from './ipc/routes'
import type { ChannelRoute, RouteQualifier } from './ipc/channelRoute'
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
import type { ModeWindow } from './window/ports/windowFactory'
import { ozoneRelaunchArgs, runningLinuxSession } from './window/adapters/linuxSession'
import { uiDataDirectory } from './dataDirectory'
import {
  DEFAULT_TOGGLE_ACCELERATOR,
  dwarfIdSchema,
  PROTOCOL_VERSION,
  type ChannelKey,
  type DwarfId,
  type UiPreferencesMap
} from '@dwarfai/contracts'
import { createNativeRows } from './ipc/handlers/nativeRows'
import { createAppInfo, type AppInfo } from './window/application/appInfo'
import { createNativeActions, type ServedNativeActions } from './window/application/nativeActions'
import { TerminalConsoleRaiser } from './window/adapters/terminal/TerminalConsoleRaiser'
import { ElectronFolderPicker } from './window/adapters/ElectronFolderPicker'
import {
  createMinesAdminRows,
  MINES_ADMIN_ROWS,
  type MinesAdminDeps
} from './ipc/handlers/minesAdmin'
import { createToggleShortcut } from './window/application/toggleShortcut'
import { ElectronClipboard } from './window/adapters/ElectronClipboard'
import { ElectronExternalOpener } from './window/adapters/ElectronExternalOpener'
import { ElectronFilePicker } from './window/adapters/ElectronFilePicker'
import {
  currentShortcutPlatform,
  ElectronGlobalShortcut
} from './window/adapters/ElectronGlobalShortcut'
import { ElectronTray } from './window/adapters/ElectronTray'
import { APP_USER_MODEL_ID } from './window/adapters/appUserModelId'
import { ElectronNotificationDisplay } from './window/adapters/ElectronNotificationDisplay'
import { startNotificationPresenter } from './window/application/notificationPresenter'
import {
  createDepartedDwarfs,
  createRevealDwarfChat,
  type DwarfChatRevealer,
  type RevealWindows
} from './window/application/revealDwarfChat'
import { composeModeShell, type ModeShell } from './window/application/modeShell'
import { SystemModeTiming } from './window/adapters/SystemModeTiming'
import { createModeRows, MODE_MOVE, MODE_TRANSITION_DONE } from './ipc/mode'
import { createVetaRows, SET_VETA_CLICK_THROUGH, VETA_ROWS } from './ipc/veta'
import { createVetaLayoutRows, LAYOUT_VETA, VETA_LAYOUT_ROWS } from './ipc/vetaLayout'
import { createVetaDockService, type VetaDockService } from './window/application/VetaDockService'
import {
  createVetaWindowController,
  VETA_ISLAND_PLACEHOLDER,
  type VetaWindowController
} from './window/application/VetaWindowController'
import { createPanelReveal, REVEAL_DWARF_CHAT_PUSH } from './window/adapters/panelReveal'
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
  createNodeRevertIntegrations,
  nodeHostManifestPath,
  runRegExe,
  wantsRevertIntegrations,
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
import { createUiShellStart, type UiShellStart } from './window/application/shellStart'
import { createCandidateAutostart } from './window/application/candidateAutostart'
import {
  candidateDefaultMarkerAt,
  candidateLoginEntryFor
} from './window/adapters/autostart/CandidateAutostart'
import { ElectronAutostart } from './window/adapters/autostart/ElectronAutostart'
import { loginEntryOffered } from './window/domain/loginEntryGate'
import { LOGIN_ENTRY_ARGS, uiStartPlanOf, type UiStartPlan } from './window/domain/uiStart'
import {
  createPresenceTracker,
  type PresenceTimers,
  type PresenceTracker
} from './window/application/presenceTracker'
import {
  createHostReadRows,
  forwardHostEvents,
  HOST_EVENT,
  HOST_READ_ROWS,
  HOST_SNAPSHOT
} from './ipc/handlers/hostRead'
import {
  createGetDwarfFeedPageRow,
  GET_DWARF_FEED_PAGE,
  GET_DWARF_FEED_PAGE_ROWS
} from './ipc/handlers/getDwarfFeedPage.host'
import {
  createGetMineHistoryRow,
  GET_MINE_HISTORY,
  GET_MINE_HISTORY_ROWS
} from './ipc/handlers/getMineHistory.host'
import {
  createReportVisibleMinesRow,
  REPORT_VISIBLE_MINES
} from './ipc/handlers/reportVisibleMines'
import {
  createLaunchAgentRow,
  LAUNCH_AGENT,
  LAUNCH_AGENT_ROWS
} from './ipc/handlers/launchAgent.host'
import {
  createListAgentProvidersRow,
  LIST_AGENT_PROVIDERS,
  LIST_AGENT_PROVIDERS_ROWS
} from './ipc/handlers/listAgentProviders.host'
import {
  createLaunchCustomRow,
  LAUNCH_CUSTOM,
  LAUNCH_CUSTOM_ROWS
} from './ipc/handlers/launchCustom.host'
import {
  createSendDwarfTextRow,
  SEND_DWARF_TEXT,
  SEND_DWARF_TEXT_ROWS
} from './ipc/handlers/sendDwarfText.host'
import {
  createDescribeAttachmentsRow,
  DESCRIBE_ATTACHMENTS,
  DESCRIBE_ATTACHMENTS_ROWS
} from './ipc/handlers/describeAttachments.host'
import {
  createRetryDwarfMessageRow,
  RETRY_DWARF_MESSAGE,
  RETRY_DWARF_MESSAGE_ROWS
} from './ipc/handlers/retryDwarfMessage.host'
import { createRecoveryReportRow, RECOVERY_REPORT_ROWS } from './ipc/handlers/recoveryReport.host'
import { createStopDwarfRow, STOP_DWARF, STOP_DWARF_ROWS } from './ipc/handlers/stopDwarf.host'
import {
  ACTIVATE_DWARF,
  ACTIVATE_DWARF_ROWS,
  createActivateDwarfRow
} from './ipc/splits/activateDwarf'
import { composeProviderQualifiers, DWARF_PROVIDER_ROWS } from './ipc/providerQualifiers'
import { createDwarfProviderBoard, type DwarfProviderBoard } from './ipc/dwarfProviderBoard'
import { ANSWER_DWARF_ROWS, createAnswerDwarfRows } from './ipc/handlers/answerDwarf.host'
import {
  createSetAskStepRow,
  SET_ASK_STEP,
  SET_ASK_STEP_ROWS
} from './ipc/handlers/setAskStep.host'
import {
  createRenameDwarfRow,
  RENAME_DWARF,
  RENAME_DWARF_ROWS
} from './ipc/handlers/renameDwarf.host'
import {
  createResetDwarfNameRow,
  RESET_DWARF_NAME,
  RESET_DWARF_NAME_ROWS
} from './ipc/handlers/resetDwarfName.host'
import {
  createRouteJevLaunchRow,
  ROUTE_JEV_LAUNCH,
  ROUTE_JEV_LAUNCH_ROWS
} from './ipc/handlers/routeJevLaunch.host'
import {
  createSetClaudeHooksRow,
  SET_CLAUDE_HOOKS,
  SET_CLAUDE_HOOKS_ROWS
} from './ipc/handlers/setClaudeHooks.host'
import {
  createOpenCodeSettingsRows,
  OPENCODE_SETTINGS_ROWS
} from './ipc/handlers/openCodeSettings.host'
import { createResetMetricsRow, RESET_METRICS_ROWS } from './ipc/handlers/resetMetrics.host'
import {
  ANSWER_WELCOME,
  ANSWER_WELCOME_ROWS,
  createAnswerWelcomeRow
} from './ipc/handlers/answerWelcome.host'
import { createJevApiKeyRows, JEV_API_KEY_ROWS } from './ipc/handlers/jevApiKey.host'
import {
  createHostJevSettings,
  createJevSettingsRows,
  JEV_SETTINGS_ROWS
} from './ipc/handlers/jevSettings.host'
import {
  createSystemNotificationsRows,
  SYSTEM_NOTIFICATIONS_ROWS
} from './ipc/handlers/systemNotifications.host'
import {
  createOpenCodePasswordRows,
  OPENCODE_PASSWORD_ROWS
} from './ipc/handlers/openCodePassword.host'

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
/** The Veta window as the root composes it (ISSUE-285). */
export interface VetaWindowParts {
  controller: VetaWindowController
  /** Its place per display (07 machine 21; ISSUE-286): A-N23, A-N28 and `vetaDock`. */
  dock: VetaDockService
  /** Whether a `webContents` id is the Veta window's. */
  isVeta(webContentsId: number): boolean
}

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
  presence,
  mode,
  veta,
  vetaLayout,
  vetaDock,
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
  /** A-44 `reportVisibleMines` feeding the PresenceTracker, once the table routes it `ui-local` (ISSUE-123). */
  presence?: RouteTargetPart
  /** A-N13, A-N15 to the `ModeCoordinator` (ISSUE-284), routed `ui-local` in the PR that declares them (22 §5). */
  mode?: RouteTargetPart
  /** A-N22, A-N24 to the Veta window and the windowing limits (ISSUE-285), routed `ui-local` likewise. */
  veta?: RouteTargetPart
  /** A-N23, A-N28 to the Veta dock (ISSUE-286), routed `ui-local` likewise. */
  vetaLayout?: RouteTargetPart
  /** `vetaDock` for A-N20, read-only (ISSUE-286): the dock's stored places. */
  vetaDock?: () => UiPreferencesMap['vetaDock']
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
        createUiPreferenceMap({
          ...(startWithSystem === undefined ? {} : { startWithSystem }),
          ...(vetaDock === undefined ? {} : { vetaDock })
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
  if (presence !== undefined) parts.push(presence)
  if (mode !== undefined) parts.push(mode)
  if (veta !== undefined) parts.push(veta)
  if (vetaLayout !== undefined) parts.push(vetaLayout)
  return parts.length === 0 ? undefined : composeRouteTargets(parts)
}

/** Real timers for UI main's presence tracker. */
const realTimers: PresenceTimers = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  }
}

/** The mines admin rows as the root composes them: their `host` target part. */
export interface MinesAdminComposition {
  part: RouteTargetPart
  dispose(): void
}

/**
 * The Mines page's admin rows A-20, A-30, A-31, A-32, A-34 (ISSUE-091; 14 §2.1; 21 §2 cut 1 "New core serves"), a part
 * of the `host` target, composed only for a table that routes one of them `host` (the cut-1 switch, ISSUE-123): in a
 * table that serves them `legacy` nothing new is composed. AMENDED for ISSUE-241, the end of cut 4 (was: A-32 relayed
 * through `LegacyEndFirstAdapter`'s `beforeRemoveMine` in the releases the adapter lived in, ISSUE-090; 21 §3): the
 * adapter left the tree, so `mines.remove` is sent at once and a session the old app launched is the Host's observed
 * session to end. `undefined` when the table routes none of the rows `host` or a dependency is missing.
 */
export function composeMinesAdmin(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call' | 'state' | 'subscribe'>
  native: Pick<ServedNativeActions, 'chooseFolder' | 'openPath'> | undefined
  newRequestId?: () => string
}): MinesAdminComposition | undefined {
  const rows: readonly ChannelKey[] = MINES_ADMIN_ROWS
  const toHost = deps.routes.some((r) => rows.includes(r.channel) && r.owner === 'host')
  if (!toHost || deps.native === undefined) return undefined
  const beforeRemoveMine: MinesAdminDeps['beforeRemoveMine'] = (mineId, requestId, remove) =>
    remove(mineId, requestId)
  return {
    part: {
      channels: rows,
      target: createMinesAdminRows({
        client: deps.client,
        native: deps.native,
        newRequestId:
          deps.newRequestId ??
          (() => mintRequestId({ now: () => Date.now(), random: (n) => randomBytes(n) })),
        beforeRemoveMine
      })
    },
    dispose: () => {}
  }
}

/** Whether the table routes `channel` to `owner`. */
const routedTo = (
  routes: readonly ChannelRoute[],
  channel: ChannelKey,
  owner: ChannelRoute['owner']
): boolean => routes.some((route) => route.channel === channel && route.owner === owner)

/** The Host read rows as the root composes them: their `host` target part, and the stop of the A-N02 forwarding. */
export interface HostReadsComposition {
  part: RouteTargetPart
  dispose(): void
}

/**
 * The Host-fed read path (21 §2 cut 1 "New core serves" H; ISSUE-082, ISSUE-111): A-N01 `getHostSnapshot` relays
 * `session.snapshot` and A-N02 `onHostEvent` forwards the Host's frames to the mode windows (window/…/hostRead.ts);
 * A-15 `getDwarfFeedPage` and A-19 `getMineHistory` relay `conversation.feed` and `conversation.mineHistory` over the
 * Host message log (14 §2.1 CHANGE). Each row is a part of the `host` target only where the table routes it `host` (the
 * cut-1 switch); A-N02 is forwarded only where it is routed. `undefined` when the table routes none of them `host`.
 */
export function composeHostReads(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'snapshot' | 'subscribe' | 'call'>
  windows: () => readonly WindowContents[]
  defer?: (run: () => void) => void
}): HostReadsComposition | undefined {
  const { routes, client } = deps
  const toHost = (channel: ChannelKey): boolean => routedTo(routes, channel, 'host')
  const parts: RouteTargetPart[] = []
  if (toHost(HOST_SNAPSHOT))
    parts.push({ channels: HOST_READ_ROWS, target: createHostReadRows(client) })
  if (toHost(GET_DWARF_FEED_PAGE)) {
    parts.push({ channels: GET_DWARF_FEED_PAGE_ROWS, target: createGetDwarfFeedPageRow(client) })
  }
  if (toHost(GET_MINE_HISTORY)) {
    parts.push({ channels: GET_MINE_HISTORY_ROWS, target: createGetMineHistoryRow(client) })
  }
  const stopForwarding = toHost(HOST_EVENT)
    ? forwardHostEvents({
        client,
        windows: deps.windows,
        ...(deps.defer === undefined ? {} : { defer: deps.defer })
      })
    : undefined
  if (parts.length === 0 && stopForwarding === undefined) return undefined
  return {
    part: {
      channels: parts.flatMap((part) => part.channels),
      target: composeRouteTargets(parts)
    },
    dispose: () => stopForwarding?.()
  }
}

/** A-44 as the root composes it: its `ui-local` target part, and the tracker the window events reach. */
export interface PresenceComposition {
  part: RouteTargetPart
  tracker: PresenceTracker
}

/**
 * A-44 `reportVisibleMines` (14 §2.1 CHANGE, `ui-local`; ADR-024 item 7; ISSUE-106): each mode window's report reaches
 * UI main's `PresenceTracker`, which tells the Host what is on screen (B-M07 `presence`) when it changed. A part of the
 * `ui-local` target only where the table routes A-44 `ui-local` (the cut-1 switch); `undefined` otherwise, so today's
 * runtime keeps answering `setOpenMine` before cut 1 and in a rollback build.
 */
export function composePresence(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'reportPresence'>
  timers: PresenceTimers
  visibleWindows: () => readonly number[]
}): PresenceComposition | undefined {
  if (!routedTo(deps.routes, REPORT_VISIBLE_MINES, 'ui-local')) return undefined
  const tracker = createPresenceTracker({
    host: deps.client,
    timers: deps.timers,
    visibleWindows: deps.visibleWindows
  })
  return {
    part: { channels: [REPORT_VISIBLE_MINES], target: createReportVisibleMinesRow(tracker) },
    tracker
  }
}

/** The A-40/A-41 answer path as the root composes it from the cut-2 switch (ISSUE-141). */
export interface AskAnswersComposition {
  /** The A-40/A-41 `host` handlers, for the Host's own AskIds (ISSUE-128); none where no row routes `host`. */
  part: RouteTargetPart | undefined
}

/**
 * A-40 `answerDwarfQuestion` and A-41 `answerDwarfPermission` from the cut-2 switch (21 §2 cut 2 "New core serves";
 * ISSUE-141): where the table routes them `host`, their `host` handlers relay a Host AskId's answer to
 * `asking.answerQuestion` / `asking.answerPermission` (ADR-010). AMENDED for ISSUE-241, the end of cut 4 (was: also
 * `LegacyAnswerShapeAdapter` over `LegacyAskRelay` for the relay's `legacy:` AskIds, with the qualifier read from each
 * call's AskId, 21 §3.1, cuts 2–4): both left the tree, so every ask answered is the Host's. `undefined` when the table
 * routes neither row `host` (before cut 2).
 */
export function composeAskAnswers(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'> | undefined
}): AskAnswersComposition | undefined {
  const { routes, client } = deps
  const rows =
    client === undefined
      ? []
      : ANSWER_DWARF_ROWS.filter((channel) => routedTo(routes, channel, 'host'))
  if (client === undefined || rows.length === 0) return undefined
  return { part: { channels: rows, target: createAnswerDwarfRows(client) } }
}

/**
 * The NEW rows born `host` in cut 2 (21 §2 cut 2 "New core serves"; ISSUE-141): A-N07 `setAskStep` (B-M32, ISSUE-129),
 * A-N31 `setClaudeHooksEnabled` (B-M39, ISSUE-221) and A-N32 `answerWelcome` (B-M40, ISSUE-223), each a part of the
 * `host` target only where the table routes it `host`. `undefined` when it routes none of them (before cut 2; in a
 * cut-2 rollback build A-N31 and A-N32 are withdrawn, `rollbackTable.ts`).
 */
export function composeAskStepAndIntegrationRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
}): RouteTargetPart | undefined {
  const { routes, client } = deps
  const parts: RouteTargetPart[] = []
  if (routedTo(routes, SET_ASK_STEP, 'host')) {
    parts.push({ channels: SET_ASK_STEP_ROWS, target: createSetAskStepRow(client) })
  }
  if (routedTo(routes, SET_CLAUDE_HOOKS, 'host')) {
    parts.push({ channels: SET_CLAUDE_HOOKS_ROWS, target: createSetClaudeHooksRow(client) })
  }
  if (routedTo(routes, ANSWER_WELCOME, 'host')) {
    parts.push({ channels: ANSWER_WELCOME_ROWS, target: createAnswerWelcomeRow(client) })
  }
  if (parts.length === 0) return undefined
  return { channels: parts.flatMap((part) => part.channels), target: composeRouteTargets(parts) }
}

/** The Jev key rows as the root composes them (ISSUE-217), and the Jev settings rows (ISSUE-230). */
export interface JevKeyComposition {
  /** A-48/A-49's and, from 4a, A-47/A-51's `host` target part, where the table routes them `host`. */
  part: RouteTargetPart | undefined
}

/**
 * The Jev key rows from step 3a (21 §2 cut 3a, §3, §3.1, §4 row "Jev API key"; ADR-017 item 8; ISSUE-217): A-48
 * `setJevApiKey` and A-49 `clearJevApiKey` relayed to B-M10 / B-M11 where the table routes them `host`, and A-47
 * `getJevSettings` through `JevSettingsShapeAdapter` where a route names it and it lives in the release. Where A-48 is
 * routed `host`, `SecretMigrationBridge` moves today's `safeStorage` Jev-key file into the Host once (in the releases
 * it is listed for), and every one of the three rows is served after the run started so far has settled, so the key is
 * never stored twice (C-23). `undefined` before the step-3a switch (ISSUE-001), which routes none of them so, or
 * without the Host attach.
 *
 * From step 4a (21 §2 cut 4a; ISSUE-230) A-47 `getJevSettings` and A-51 `setJevPreferences` are served by their `host`
 * handler where the table routes them `host` (the step-4a switch, ISSUE-235), from the Host's preferences; A-48/A-49
 * then answer the `JevSettings` the Host holds too, never today's preferences (`JevSettingsShapeAdapter` reads those,
 * up to 4a). They wait for the migration as the other Jev rows do.
 *
 * AMENDED for ISSUE-236, the 4a retirement (was: A-47 through `JevSettingsShapeAdapter` where a route named it, over
 * today's runtime as `legacy`): the adapter left the tree, so A-48/A-49 always answer the `JevSettings` the Host holds.
 *
 * AMENDED for ISSUE-247, the cut-5 deletion of `SecretMigrationBridge` (was: in the releases 3a and 4a the bridge moved
 * today's `safeStorage` Jev-key file into the Host once, and the rows waited for that run): the one-time migration
 * ended with its releases (21 §3; ADR-017 item 8), so the rows are served at once and no legacy secret file is read.
 */
export function composeJevKeyRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'> | undefined
  mintId: () => string
}): JevKeyComposition | undefined {
  const { routes, client } = deps
  const rows = JEV_API_KEY_ROWS.filter((channel) => routedTo(routes, channel, 'host'))
  const settingsRows = JEV_SETTINGS_ROWS.filter((channel) => routedTo(routes, channel, 'host'))
  if (client === undefined || (rows.length === 0 && settingsRows.length === 0)) {
    return undefined
  }
  // The `JevSettings` A-48/A-49 answer: the Host's (ISSUE-236: today's preferences through the adapter are gone).
  const settings = createHostJevSettings(client)
  const parts: RouteTargetPart[] = []
  if (rows.length > 0) {
    parts.push({
      channels: rows,
      target: createJevApiKeyRows({ client, settings, mintId: deps.mintId })
    })
  }
  if (settingsRows.length > 0) {
    parts.push({
      channels: settingsRows,
      target: createJevSettingsRows({ client, settings, mintId: deps.mintId })
    })
  }
  return {
    part:
      parts.length === 0
        ? undefined
        : {
            channels: parts.flatMap((part) => part.channels),
            target: composeRouteTargets(parts)
          }
  }
}

/** The OpenCode server password rows as the root composes them (ISSUE-231). */
export interface OpenCodePasswordComposition {
  /** A-54/A-55's `host` target part. */
  part: RouteTargetPart
}

/**
 * The OpenCode server password rows from step 4a (21 §2 cut 4a, §3, §4 row "OpenCode server password"; ADR-017 items
 * 3–5, 8; ISSUE-231): A-54 `setOpenCodeServerPassword` and A-55 `clearOpenCodeServerPassword` relayed to B-M10 / B-M11
 * where the table routes them `host`. There, `SecretMigrationBridge` moves today's `safeStorage` password file into the
 * Host once (in the releases it is listed for), and both rows are served after the run started so far has settled, so
 * the password is never stored twice (C-23). `undefined` before the step-4a switch (later: ISSUE-235), which routes
 * neither so, or without the Host attach.
 *
 * AMENDED for ISSUE-247, the cut-5 deletion of `SecretMigrationBridge` (was: in the release 4a the bridge moved today's
 * `safeStorage` password file into the Host once, and both rows waited for that run): the one-time migration ended with
 * its release (21 §3; ADR-017 item 8), so the rows are served at once and no legacy secret file is read.
 */
export function composeOpenCodePasswordRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'> | undefined
  mintId: () => string
}): OpenCodePasswordComposition | undefined {
  const { routes, client } = deps
  const rows = OPENCODE_PASSWORD_ROWS.filter((channel) => routedTo(routes, channel, 'host'))
  if (client === undefined || rows.length === 0) return undefined
  return {
    part: { channels: rows, target: createOpenCodePasswordRows({ client, mintId: deps.mintId }) }
  }
}

/**
 * A-52 `getOpenCodeSettings` (B-M12) and A-53 `setOpenCodePluginEnabled` (B-M14), ISSUE-228: the part of the `host`
 * target serving the rows the table routes `host`, which the step-4a switch does (ISSUE-235, 22 §5). `undefined` while
 * it routes neither (every table before that switch, where today's handlers keep serving them).
 */
export function composeOpenCodeSettingsRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
}): RouteTargetPart | undefined {
  const rows = OPENCODE_SETTINGS_ROWS.filter((channel) => routedTo(deps.routes, channel, 'host'))
  return rows.length === 0
    ? undefined
    : { channels: rows, target: createOpenCodeSettingsRows(deps.client) }
}

/**
 * A-42 `getNotificationsEnabled` and A-43 `setNotificationsEnabled` from step 4a (21 §2 cut 4a; ISSUE-230): a part of
 * the `host` target only where the table routes them `host` (the step-4a switch, ISSUE-235). `undefined` when it routes
 * neither (every table before 4a, where today's runtime serves them and `SettingsMirrorBridge` mirrors the switch).
 */
export function composeSystemNotificationRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
  mintId: () => string
}): RouteTargetPart | undefined {
  const channels = SYSTEM_NOTIFICATIONS_ROWS.filter((channel) =>
    routedTo(deps.routes, channel, 'host')
  )
  if (channels.length === 0) return undefined
  return {
    channels,
    target: createSystemNotificationsRows({ client: deps.client, mintId: deps.mintId })
  }
}

/**
 * A-33 `resetMetrics` from step 4a (21 §2 cut 4a, §3 `ResetFanout` ends; ISSUE-233): the Host saga alone (B-M15), a part
 * of the `host` target only where the table routes it `host` (the step-4a switch, ISSUE-235). `undefined` before, where
 * `ResetFanout` serves it.
 */
export function composeResetMetricsRow(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'withUiConnection'>
}): RouteTargetPart | undefined {
  const channels = RESET_METRICS_ROWS.filter((channel) => routedTo(deps.routes, channel, 'host'))
  return channels.length === 0
    ? undefined
    : { channels, target: createResetMetricsRow(deps.client) }
}

/**
 * A-N08 `renameDwarf` (B-M22) and A-N09 `resetDwarfName` (B-M23), ISSUE-172: each a part of the `host` target only
 * where the table routes it `host` (lead decision 2026-10-17: born `host` in cut 2, the renderer's board being the
 * Host's). `undefined` when it routes neither (the cut-1 table).
 */
export function composeDwarfNameRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
}): RouteTargetPart | undefined {
  const { routes, client } = deps
  const parts: RouteTargetPart[] = []
  if (routedTo(routes, RENAME_DWARF, 'host')) {
    parts.push({ channels: RENAME_DWARF_ROWS, target: createRenameDwarfRow(client) })
  }
  if (routedTo(routes, RESET_DWARF_NAME, 'host')) {
    parts.push({ channels: RESET_DWARF_NAME_ROWS, target: createResetDwarfNameRow(client) })
  }
  if (parts.length === 0) return undefined
  return { channels: parts.flatMap((part) => part.channels), target: composeRouteTargets(parts) }
}

/**
 * A-50 `routeJevLaunch` (14 §2.2 CHANGE; ISSUE-192): relayed to B-M38 `jev.suggest`, a part of the `host` target only
 * where the table routes it `host`. `undefined` before the step-3a switch (ISSUE-001), which routes it so: until then
 * today's runtime answers the card.
 */
export function composeJevRouteRow(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
}): RouteTargetPart | undefined {
  if (!routedTo(deps.routes, ROUTE_JEV_LAUNCH, 'host')) return undefined
  return { channels: ROUTE_JEV_LAUNCH_ROWS, target: createRouteJevLaunchRow(deps.client) }
}

/**
 * The step-3a rows the Host serves for launch and conversation (21 §2 cut 3a; ISSUE-001), each a part of the `host`
 * target only where the table routes it `host`: A-35 `launchAgent` (B-M33), A-23 `sendDwarfText` (B-M24), A-13
 * `activateDwarf` (B-M29, its window half raising the console UI main holds, ADR-031), A-25
 * `describeDwarfAttachments` (B-M28), A-N06 `retryDwarfMessage` (B-M25) and A-N10, A-N11 the recovery report (B-M35,
 * B-M36). A-13 is composed only with the console raiser (`consoles`), never half. From step 3d (ISSUE-186) also A-39
 * `launchHostedProcess` (B-M34, the "Other…" launch). From step 4b (ISSUE-238) also A-36 `listAgentProviders` (B-M37),
 * where its unqualified route, the renderer's one catalog call, is `host` (before 4b its provider-qualified `host`
 * routes are the moved providers of `CatalogMergeAdapter`, which serves that call). `undefined` when the table routes
 * none of them `host` (before the step-3a switch).
 */
export function composeConversationAndLaunchRows(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call'>
  consoles: Pick<ServedNativeActions, 'raiseConsole'> | undefined
}): RouteTargetPart | undefined {
  const { routes, client, consoles } = deps
  const toHost = (channel: ChannelKey): boolean => routedTo(routes, channel, 'host')
  const parts: RouteTargetPart[] = []
  if (toHost(LAUNCH_AGENT)) {
    parts.push({ channels: LAUNCH_AGENT_ROWS, target: createLaunchAgentRow(client) })
  }
  if (toHost(LAUNCH_CUSTOM)) {
    parts.push({ channels: LAUNCH_CUSTOM_ROWS, target: createLaunchCustomRow(client) })
  }
  const catalogCall = routes.find(
    (route) => route.channel === LIST_AGENT_PROVIDERS && route.qualifier === undefined
  )
  if (catalogCall?.owner === 'host') {
    parts.push({ channels: LIST_AGENT_PROVIDERS_ROWS, target: createListAgentProvidersRow(client) })
  }
  if (toHost(SEND_DWARF_TEXT)) {
    parts.push({ channels: SEND_DWARF_TEXT_ROWS, target: createSendDwarfTextRow(client) })
  }
  if (toHost(ACTIVATE_DWARF) && consoles !== undefined) {
    parts.push({
      channels: ACTIVATE_DWARF_ROWS,
      target: createActivateDwarfRow({ client, consoles })
    })
  }
  if (toHost(DESCRIBE_ATTACHMENTS)) {
    parts.push({
      channels: DESCRIBE_ATTACHMENTS_ROWS,
      target: createDescribeAttachmentsRow(client)
    })
  }
  if (toHost(RETRY_DWARF_MESSAGE)) {
    parts.push({ channels: RETRY_DWARF_MESSAGE_ROWS, target: createRetryDwarfMessageRow(client) })
  }
  const recovery = RECOVERY_REPORT_ROWS.filter(toHost)
  if (recovery.length > 0) {
    parts.push({ channels: recovery, target: createRecoveryReportRow(client) })
  }
  if (parts.length === 0) return undefined
  return { channels: parts.flatMap((part) => part.channels), target: composeRouteTargets(parts) }
}

/** A-N29 as the root composes it: its `host` target part, and the stop of its board reading. */
export interface StopDwarfComposition {
  part: RouteTargetPart
  dispose(): void
}

/**
 * A-N29 `stopDwarf` (14 §2.2 NEW, B-M21 `crew.stop`; ADR-014; 21 §2 cut 3 common rules), a part of the `host` target
 * where the table routes it `host` (the step-3a switch). AMENDED for ISSUE-241, the end of cut 4 (was: in the releases
 * `LegacyEndFirstAdapter` lived in, cuts 0–4, the relay went through its `beforeStopDwarf`, ISSUE-178, ending a dwarf
 * today's runtime launched by today's identity-checked kill first): the adapter left the tree, so the relay is direct
 * and a still-running session the old app launched answers could-not-end with the `no-identity` cause (15 §5;
 * docs/strangler/parity-cut-4b.md). `undefined` when the table does not route A-N29 `host`.
 */
export function composeStopDwarf(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'call' | 'subscribe'>
}): StopDwarfComposition | undefined {
  if (!routedTo(deps.routes, STOP_DWARF, 'host')) return undefined
  return {
    part: { channels: STOP_DWARF_ROWS, target: createStopDwarfRow(deps.client) },
    dispose: () => {}
  }
}

/** The provider qualifiers of the step-3a rows as the root composes them. */
export interface ProviderRoutingComposition {
  qualifiers: Partial<Record<ChannelKey, (payload: unknown) => RouteQualifier>>
  dispose(): void
}

/**
 * The qualifier of each row the table qualifies by provider (21 §1 item 2; 21 §2 cut 3; ISSUE-001): A-35 by its
 * `LaunchParams.way`, A-13 and A-23 by the provider of the call's dwarf on the Host board UI main reads
 * (`dwarfProviderBoard.ts`), never a guess (`providerQualifiers.ts`). The board is read only where a row needs it.
 */
export function composeProviderRouting(deps: {
  routes: readonly ChannelRoute[]
  client: Pick<HostClient, 'subscribe'>
}): ProviderRoutingComposition {
  let board: DwarfProviderBoard | undefined
  const qualifiers = composeProviderQualifiers({
    routes: deps.routes,
    board: { providerOf: (dwarfId) => board?.providerOf(dwarfId) }
  })
  const byDwarf = DWARF_PROVIDER_ROWS.some((channel) => qualifiers[channel] !== undefined)
  if (byDwarf) board = createDwarfProviderBoard(deps.client)
  return { qualifiers, dispose: () => board?.dispose() }
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
export type UiStartStep = 'ready' | 'panel-load' | 'shortcut' | 'tray' | 'shell'

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
  /**
   * The app's own version (AMENDMENT-25; 16 §4.14 as amended): the lock carries it to a running instance, and a later
   * launch of a newer build makes this instance replace itself with that launch (window/application/secondLaunch.ts).
   * Absent, the lock carries no version and no later launch is taken as newer.
   */
  appVersion?: string
  lifecycle: UiMainLifecycle
  // AMENDED for ISSUE-243, the deletion of today's runtime (was: `legacyRuntime`, today's runtime composed through
  // `LegacyRuntimeRoute`, which served the `legacy` rows and was torn down on quit; until ISSUE-241 also today's
  // launched register for `LegacyEndFirstAdapter`): no row is `legacy` any more, and the runtime left the tree.
  /** The route table (default `ROUTES`, the release's own); a test or a rollback table is passed here. */
  routes?: readonly ChannelRoute[]
  // AMENDED for ISSUE-247 (was: `release`, the release the table is for, which chose the legacy-bridge adapters living
  // in it, 21 §3): no adapter is left, so nothing is chosen by release.
  /** Every open window of the app (A-N04, A-N25 pushes; the tray's Quit closes them). */
  appWindows?: () => readonly AppWindow[]
  /** The rebuilt tray (ISSUE-053): its icon and the id of each new confirmation. */
  tray?: { controller: TrayController; newConfirmationId(): string }
  /** The rebuilt global shortcut over the Panel (ISSUE-049). */
  shortcut?: (panel: PanelWindowController) => ToggleShortcut
  /** The links, clipboard, pickers and build info rows (ISSUE-050). */
  nativeRows?: RouteTarget
  /** The folder picker and the file opener of the mines admin rows A-30, A-20 (ISSUE-091). */
  minesNative?: Pick<ServedNativeActions, 'chooseFolder' | 'openPath'>
  /** A-13's window half (ISSUE-170; ADR-031): the console target the Host resolved, raised in the OS terminal. */
  consoles?: Pick<ServedNativeActions, 'raiseConsole'>
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
   * The Veta window (ISSUE-285; ADR-025 items 1, 4, 6), composed once the Panel is: its controller, and whether a
   * `webContents` id is the Veta window's. The `ModeCoordinator` moves it only where the build's built-modes list
   * contains Veta (`BUILT_MODES`); A-N24 reads its windowing limits in every build.
   */
  vetaWindow?: () => VetaWindowParts
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
  // AMENDED for ISSUE-247 (was: `secretMigration`, today's `safeStorage` files for `SecretMigrationBridge`, steps 3a and
  // 4a; ADR-017 item 8): the bridge left the tree with the last adapter of src/legacy-bridge (21 §3).
  /**
   * Level-3 OS notifications (ISSUE-113; ADR-018 items 5, 7): the display adapter and whether S-018-1 passed on this OS.
   * With the rebuilt window family, the Host attach and the UI log, the root draws the `notifier` connection's
   * `attention.notify` / `attention.withdraw` frames for the process's life (window/application/notificationPresenter.ts).
   */
  notifications?: {
    display: NotificationDisplay & NotificationWithdrawal
    drawsWithoutWindow: boolean
    /**
     * Whether a window of the app has the focus (ISSUE-114): read right after a notification click asked the Panel to
     * the front, so the reveal knows whether the raise held (S-018-2; 13 FM-049). Absent, a raise is never taken as
     * held.
     */
    windowFocused?(): boolean
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
  /**
   * The shell's own start work (window/application/shellStart.ts; 21 §2 cut 5 preparation for ISSUE-243): the macOS
   * Dock tile hidden, the `.env` file read, the candidate login entry where it is composed, and the app's identity on
   * Windows. It runs once per start, last, where today's composition did the same work before ISSUE-243 deleted it.
   */
  shellStart?: UiShellStart
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
 *   A-N26 reaches the Host (through `LegacyEndFirstAdapter` until ISSUE-241, 21 §3); A-N04 is pushed on every Host
 *   connection change, and a second launch shows the rebuilt Panel.
 * - The window family served `legacy` (before cut 0, or a rollback build, 21 §2.1): nothing serves it any more.
 *   AMENDED for ISSUE-243 (was: today's runtime composed with its own window, tray and shortcut, through
 *   `LegacyRuntimeRoute`): today's runtime left the tree (21 §2 cut 5), so such a table is refused, as is any table
 *   with a `legacy` row (the router binds no `legacy` target).
 *
 * The answer settles when the start has finished: at once (undefined) for a process that quit,
 * after the composition (or the exit it caused) for the lock holder, with its reopen state.
 */
export async function startUiMain({
  lock,
  lifecycle,
  ipc,
  appEntry,
  routes = ROUTES,
  appWindows = () => [],
  tray,
  shortcut,
  nativeRows,
  minesNative,
  consoles,
  uiPreferences,
  uiLog,
  panelWindow,
  vetaWindow,
  host,
  notifications,
  launch = { kind: 'normal', tray: true, window: true },
  startWithSystem,
  appVersion,
  shellStart
}: UiMainDeps): Promise<UiMainStarted | undefined> {
  if (!lock.acquire(appVersion === undefined ? undefined : { appVersion })) {
    lifecycle.quit()
    return undefined
  }
  // The mode windows (ADR-019 item 8): every window this process creates is registered, before anything is composed,
  // so the window is known before its page is loaded. Since cut 0 that is the rebuilt Panel; in a rollback build,
  // today's Panel shell window.
  const modeWindows = createModeWindowRegistry()
  /** A closed mode window's presence report goes with it (ADR-024 item 7); bound once A-44 is composed below. */
  let windowClosed: (webContentsId: number) => void = () => {}
  lifecycle.onWindowCreated(({ webContentsId, onClosed }) => {
    modeWindows.register(webContentsId)
    onClosed(() => {
      modeWindows.drop(webContentsId)
      windowClosed(webContentsId)
    })
  })
  // AMENDED for ISSUE-243 (was: a table that serves the window family `legacy`, before cut 0 or in a rollback build,
  // started today's runtime with its own window, tray and shortcut): today's runtime left the tree (21 §2 cut 5), so
  // nothing can serve that family and such a table is refused, as a table that splits the family is.
  if (windowFamilyOwner(routes) === 'legacy') {
    throw new Error(
      'the route table serves the window family legacy, and no legacy runtime is left'
    )
  }
  const panel = panelWindow?.(modeWindows)
  if (panel === undefined) {
    throw new Error(
      'the route table serves the window family ui-local but no rebuilt Panel was composed'
    )
  }
  /** The open mode windows, for the pushes UI main sends (A-N04, A-N25). */
  const modeWindowList = (): readonly AppWindow[] =>
    appWindows().filter((window) => modeWindows.has(window.webContentsId))
  const routed = (channel: ChannelKey): boolean => routes.some((r) => r.channel === channel)
  const veta = vetaWindow?.()
  const isVeta = (webContentsId: number): boolean => veta?.isVeta(webContentsId) ?? false
  // The ModeCoordinator (ISSUE-284; ADR-025 item 3), once the table routes A-N13: every hide and show of the Panel (the
  // global shortcut, Settings "Hide panel", the tray, a second launch, Stop everything's confirmation, a notification
  // click) is one of its runs (S10.08, S10.09), and it alone writes `lastMode`. The click's per-mode reveal is bound
  // below, once the notification presenter composes it.
  let clickReveal: DwarfChatRevealer | null = null
  let shellRevealWindows: RevealWindows | null = null
  const shell: ModeShell | undefined =
    routed(MODE_MOVE) && uiPreferences !== undefined
      ? composeModeShell({
          panel,
          pushToPanel: (push, payload) => {
            // The Veta window has its own pushes (`ModeWindow.send`): a Panel push never reaches it.
            for (const window of modeWindowList()) {
              if (!isVeta(window.webContentsId)) window.send(push, payload)
            }
          },
          ...(veta === undefined ? {} : { veta: veta.controller }),
          lastMode: createUiPreferences({ store: uiPreferences.store, modeWindows: () => [] }),
          timing: new SystemModeTiming(),
          log: uiLog ?? { record: () => {} },
          newTransitionId: () => randomUUID(),
          start: launch.window ? 'hidden' : 'tray-only',
          revealer: (windows) => {
            shellRevealWindows = windows
            return {
              revealDwarfChat: (t) =>
                clickReveal === null ? Promise.resolve('mine-only') : clickReveal.revealDwarfChat(t)
            }
          },
          ...(notifications?.windowFocused === undefined
            ? {}
            : { focused: () => notifications.windowFocused?.() ?? false }),
          // S27.11 and S10.16 from the Host (ISSUE-284). A UI-process crash (S10.17, S27.12) is not heard by the
          // process that crashed: the Host respawns the tray process (S12.C02), which starts a fresh coordinator.
          ...(host === undefined
            ? {}
            : {
                departures: (h: (dwarfId: DwarfId) => void) =>
                  host.client.subscribe((event) => {
                    if (event.kind !== 'frame' || event.frame.name !== 'dwarf.departed') return
                    const dwarfId = dwarfIdSchema.safeParse(
                      (event.frame.data as { dwarfId?: unknown } | null)?.dwarfId
                    )
                    if (dwarfId.success) h(dwarfId.data)
                  }),
                hostClosing: (h: () => void) => host.client.onClosing(() => h())
              })
        })
      : undefined
  /** The Panel as the rest of UI main moves it: through the coordinator when it is composed. */
  const shownPanel = shell?.panel ?? panel
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
          push: (reset) => {
            createUiPreferencesResetPush(() =>
              routed(UI_PREFERENCES_RESET_PUSH) ? modeWindowList() : []
            )(reset)
            // S21.17: the reset rewrote `vetaDock`; a shown Veta moves to the default place, with no A-N28 (14 §3.9).
            veta?.dock.reset()
          },
          host: host.client
        })
  const stopResetListening = uiPreferencesReset?.listen()

  // AMENDED for ISSUE-240, the 4b deletion (was: `LegacyLaunchObservation`, today's launch channel for a session today's
  // runtime launched, and the settlement join of the ids `PerProviderShapeAdapter` minted): both left the tree.
  // AMENDED for ISSUE-241, the end of cut 4 (was: `LegacyDwarfIdBridge` over B-M41, `LegacyAskRelay` and
  // `LegacyAgentRegistryFeed` over today's runtime, 21 §3, cuts 1–4): the bridges that joined Host and legacy dwarfs
  // left the tree together; every row that carries a dwarf id is the Host's.

  // The rebuilt window module's owners, only where the table gives them their rows (21 §1 item 1).
  const toggle = panel !== undefined ? shortcut?.(shownPanel) : undefined
  const stop =
    panel !== undefined && host !== undefined && tray !== undefined
      ? createStopEverything({
          host: host.client,
          // The confirmation shows in the Panel: a hidden Panel is shown first (US-RES-002.AC08; S10.18), and with Veta
          // shown the Panel is moved to, since only the Panel draws the confirmation (ISSUE-285).
          windows: {
            anyOpen: () => panel.visible(),
            open: () => (shell === undefined ? shownPanel.show() : shell.surfacePanel()),
            push: (channel, payload) => {
              for (const window of modeWindowList()) window.send(channel, payload)
            }
          },
          // AMENDED for ISSUE-241 (was: `relay: composeStopAllRelay(...)`, `LegacyEndFirstAdapter` ending every session
          // today's runtime launched first, 21 §3): the adapter left the tree, so A-N26 relays `host.shutdown` at once.
          newConfirmationId: () => tray.newConfirmationId()
        })
      : undefined

  // The Host read path (21 §2 cut 1 "New core serves" H): A-N01 relays the snapshot, A-N02 pushes every Host frame to
  // the mode windows, and A-15, A-19 read the Host message log, once the table routes them `host` (ISSUE-123).
  const hostReads =
    host === undefined
      ? undefined
      : composeHostReads({ routes, client: host.client, windows: modeWindowList })
  // A-44 feeds UI main's PresenceTracker (ADR-024 item 7; B-M07), once the table routes it `ui-local` (ISSUE-123): the
  // on-screen set is the Panel's report while the Panel is shown and not minimized (in v1 the one mode window).
  const presence =
    host === undefined || panel === undefined
      ? undefined
      : composePresence({
          routes,
          client: host.client,
          timers: realTimers,
          visibleWindows: () =>
            panel.visible() ? modeWindowList().map((window) => window.webContentsId) : []
        })
  const stopHearingVisibility = panel?.onVisibleChanged?.(() => presence?.tracker.windowsChanged())
  windowClosed = (webContentsId) => presence?.tracker.windowClosed(webContentsId)
  // AMENDED for ISSUE-240, the 4b deletion (was: `PerProviderShapeAdapter` and `CatalogMergeAdapter` for A-13, A-23,
  // A-35 and A-36 of the providers not yet moved, 21 §3.1): from 4b every provider's rows are the Host's.

  // AMENDED for ISSUE-242, the first cut-5 deletion (was: `BoardFacadeAdapter` serving A-12 and A-P2 from the Host
  // board, 21 §3): both rows left with it, and the renderer reads the board through A-N01/A-N02 alone.
  // The mines admin rows, once the table routes them to the Host (the cut-1 switch, ISSUE-123; 21 §2 cut 1).
  const minesAdmin =
    host === undefined
      ? undefined
      : composeMinesAdmin({
          routes,
          client: host.client,
          native: minesNative
        })
  // A-40/A-41 and the NEW rows born `host` in cut 2, once the table routes them there (the cut-2 switch, ISSUE-141): the
  // Host's AskIds through the broker (from ISSUE-241 the only AskIds there are).
  const askAnswers = composeAskAnswers({ routes, client: host?.client })
  const cut2Rows =
    host === undefined
      ? undefined
      : composeAskStepAndIntegrationRows({ routes, client: host.client })
  const dwarfNameRows =
    host === undefined ? undefined : composeDwarfNameRows({ routes, client: host.client })
  const mintSettingsId = () =>
    mintRequestId({ now: () => Date.now(), random: (n) => randomBytes(n) })
  // A-52/A-53 once the step-4a switch routes them `host` (ISSUE-235; ISSUE-228).
  const openCodeRows =
    host === undefined ? undefined : composeOpenCodeSettingsRows({ routes, client: host.client })
  // A-47…A-49, once the step-3a switch routes them (ISSUE-001; ISSUE-217); A-47 and
  // A-51 from the Host once the step-4a switch routes them `host` (ISSUE-235; ISSUE-230).

  const jevKey = composeJevKeyRows({ routes, client: host?.client, mintId: mintSettingsId })
  // A-50, once the step-3a switch routes it `host` (ISSUE-001; ISSUE-192).
  const jevRouteRow =
    host === undefined ? undefined : composeJevRouteRow({ routes, client: host.client })
  // Claude's launch, send and console, A-25, A-N06, A-N10 and A-N11 from the step-3a switch (ISSUE-001; 21 §2 cut 3a).
  const conversationRows =
    host === undefined
      ? undefined
      : composeConversationAndLaunchRows({ routes, client: host.client, consoles })
  // A-N29 (ISSUE-001), relayed at once since `LegacyEndFirstAdapter` left the tree (ISSUE-241).
  const stopDwarf =
    host === undefined ? undefined : composeStopDwarf({ routes, client: host.client })
  // The provider qualifier of A-13, A-23 and A-35: the call's way or its dwarf's provider on the Host board (21 §1
  // item 2); the router picks the Host's or the shape adapter's route by it.
  const providerRouting =
    host === undefined ? undefined : composeProviderRouting({ routes, client: host.client })
  // A-54/A-55, once the step-4a switch routes them (ISSUE-235; ISSUE-231).
  const openCodePassword = composeOpenCodePasswordRows({
    routes,
    client: host?.client,
    mintId: () => mintRequestId({ now: () => Date.now(), random: (n) => randomBytes(n) })
  })
  // A-42/A-43 from the Host once the step-4a switch routes them `host` (ISSUE-235; ISSUE-230).
  const notificationRows =
    host === undefined
      ? undefined
      : composeSystemNotificationRows({ routes, client: host.client, mintId: mintSettingsId })
  // A-33, the Host saga alone, once the step-4a switch routes it `host` (ISSUE-235; ISSUE-233).
  const resetMetricsRow =
    host === undefined ? undefined : composeResetMetricsRow({ routes, client: host.client })
  const stopRows = stop === undefined ? undefined : createStopEverythingRows(stop)
  const hostTarget =
    minesAdmin === undefined &&
    hostReads === undefined &&
    askAnswers?.part === undefined &&
    cut2Rows === undefined &&
    dwarfNameRows === undefined &&
    openCodeRows === undefined &&
    jevKey?.part === undefined &&
    jevRouteRow === undefined &&
    conversationRows === undefined &&
    stopDwarf === undefined &&
    openCodePassword === undefined &&
    notificationRows === undefined &&
    resetMetricsRow === undefined
      ? stopRows
      : composeRouteTargets([
          ...(stopRows === undefined
            ? []
            : [
                { channels: [STOP_EVERYTHING_CONFIRM], target: stopRows } satisfies RouteTargetPart
              ]),
          ...(minesAdmin === undefined ? [] : [minesAdmin.part]),
          ...(hostReads === undefined ? [] : [hostReads.part]),
          ...(askAnswers?.part === undefined ? [] : [askAnswers.part]),
          ...(cut2Rows === undefined ? [] : [cut2Rows]),
          ...(dwarfNameRows === undefined ? [] : [dwarfNameRows]),
          ...(openCodeRows === undefined ? [] : [openCodeRows]),
          ...(jevKey?.part === undefined ? [] : [jevKey.part]),
          ...(jevRouteRow === undefined ? [] : [jevRouteRow]),
          ...(conversationRows === undefined ? [] : [conversationRows]),
          ...(stopDwarf === undefined ? [] : [stopDwarf.part]),
          ...(openCodePassword === undefined ? [] : [openCodePassword.part]),
          ...(notificationRows === undefined ? [] : [notificationRows]),
          ...(resetMetricsRow === undefined ? [] : [resetMetricsRow])
        ])

  // Level-3 OS notifications (ISSUE-113; ADR-018 items 5, 7): the notifier connection's frames, from the start of the
  // attach, are drawn once Electron is ready (a notification cannot be built before), in arrival order; where S-018-1
  // has not passed, only while the Panel is shown (window/domain/trayNotificationGate.ts).
  //
  // A click (ISSUE-114; ADR-018 item 6) reports `attention.clicked` and runs `revealDwarfChat` over the Panel, the one
  // mode built: the Panel window that exists (shown, hidden or minimized) is shown again, and with none the app opens
  // as a launch does, which until Veta and Valle exist is the Panel too. It is composed once the table routes A-N16
  // (the cut-1 switch, ISSUE-123): before that a click only logs its event name, as in cut 0, so a click neither
  // brings up a Panel that could not be told what to reveal nor counts a reveal that did not happen (hidden until
  // built, 21 §1 item 8). A dwarf counts as present until its `dwarf.departed` frame was heard (`createDepartedDwarfs`).
  const departedDwarfs =
    panel !== undefined &&
    host !== undefined &&
    notifications !== undefined &&
    routed(REVEAL_DWARF_CHAT_PUSH)
      ? createDepartedDwarfs(host.client)
      : undefined
  const notificationPresenter =
    panel !== undefined && host !== undefined && uiLog !== undefined && notifications !== undefined
      ? startNotificationPresenter({
          onAttentionFrame: (handler) => {
            const ready = lifecycle.whenReady()
            return host.client.onAttentionFrame((frame) => void ready.then(() => handler(frame)))
          },
          display: notifications.display,
          drawsWithoutWindow: notifications.drawsWithoutWindow,
          anyWindowOpen: () => panel.visible(),
          log: uiLog,
          ...(departedDwarfs === undefined
            ? {}
            : {
                click: {
                  host: host.client,
                  reveal: (() => {
                    const reveal = createRevealDwarfChat({
                      windows: shellRevealWindows ?? {
                        existing: () => (modeWindowList().length > 0 ? 'panel' : null),
                        restore: () => panel.show(),
                        openAtLaunch: () => {
                          panel.show()
                          return Promise.resolve('panel')
                        },
                        raise: () => {
                          panel.raise()
                          return Promise.resolve(notifications.windowFocused?.() ?? false)
                        }
                      },
                      // Each mode's reveal reaches its own window alone (ADR-025 item 8): the Panel's the Panel
                      // windows, Veta's the Veta window, whose renderer rises that dwarf's chat (07 S24.15, ISSUE-290).
                      reveals: {
                        panel: createPanelReveal(() =>
                          modeWindowList().filter((w) => !isVeta(w.webContentsId))
                        ),
                        veta: createPanelReveal(() =>
                          modeWindowList().filter((w) => isVeta(w.webContentsId))
                        )
                      },
                      dwarfPresent: (t) => departedDwarfs.present(t),
                      log: uiLog
                    })
                    // With the coordinator, a click mid-run is held and revealed in the target mode (S27.14).
                    clickReveal = reveal
                    return shell?.coordinator ?? reveal
                  })()
                }
              })
        })
      : undefined

  // Every seam A call goes through the router table from the first renderer load (21 §1 item 1), behind the gate
  // that checks its sender and its payload (ADR-019 items 7, 8).
  const uiLocal = composeUiLocal({
    uiPreferences,
    uiLog,
    ...(panel === undefined ? {} : { panelWindow: shownPanel }),
    ...(host === undefined ? {} : { hostConnection: host.client }),
    ...(nativeRows === undefined ? {} : { nativeRows }),
    ...(toggle === undefined ? {} : { shortcut: toggle }),
    ...(stop === undefined ? {} : { stopEverything: stop }),
    ...(uiSession === undefined ? {} : { uiSession }),
    ...(startWithSystem === undefined ? {} : { startWithSystem }),
    ...(presence === undefined ? {} : { presence: presence.part }),
    ...(shell === undefined
      ? {}
      : {
          mode: {
            channels: [MODE_MOVE, MODE_TRANSITION_DONE],
            target: createModeRows(shell.coordinator, (id) =>
              isVeta(id) ? 'veta' : modeWindows.has(id) ? 'panel' : undefined
            )
          } satisfies RouteTargetPart
        }),
    ...(veta === undefined || !routed(SET_VETA_CLICK_THROUGH)
      ? {}
      : {
          veta: {
            channels: [...VETA_ROWS],
            target: createVetaRows({
              veta: veta.controller,
              isVeta,
              limits: () => veta.controller.limits()
            })
          } satisfies RouteTargetPart
        }),
    // A-N23, A-N28 and the read-only `vetaDock` (ISSUE-286), once the table routes A-N23.
    ...(veta === undefined || !routed(LAYOUT_VETA)
      ? {}
      : {
          vetaLayout: {
            channels: [...VETA_LAYOUT_ROWS],
            target: createVetaLayoutRows({ dock: veta.dock, isVeta })
          } satisfies RouteTargetPart,
          vetaDock: () => uiPreferences?.store.load('vetaDock') ?? {}
        }),
    modeWindows
  })
  // AMENDED for ISSUE-243 (was: also `legacy: legacyRuntime`, today's runtime through `LegacyRuntimeRoute`): no route
  // is `legacy` (21 §2 cut 5), so the router has no legacy target; a `legacy` route would stop it from starting.
  createRouter({
    routes,
    ...(uiLocal ? { uiLocal } : {}),
    // A-13, A-23 and A-35's qualifier, from the step-3a switch: the call's provider (21 §1 item 2). AMENDED for
    // ISSUE-241 (was: also A-40/A-41's, the relay's origin of a `legacy:` AskId): the relay left the tree.
    qualifiers: { ...providerRouting?.qualifiers },
    // A-N26, the one `host` row of cut 0: its handler relays `host.shutdown` on the confirmation's `ui` connection.
    ...(hostTarget === undefined ? {} : { host: hostTarget }),
    senders: { appEntry, isModeWindow: (id) => modeWindows.has(id) }
  }).register(ipc)
  // A later launch brings this instance forward, or, when it is of a newer build, this instance replaces itself with
  // it; the Host is never touched (AMENDMENT-25; ADR-002 D3, D7).
  const secondLaunch = wireSecondLaunch(
    lock,
    appVersion === undefined
      ? undefined
      : { appVersion, ...(uiLog === undefined ? {} : { log: uiLog }) }
  )
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
  let trayProcess: TrayProcess | null = null
  lifecycle.onResume?.(() => host?.client.wake())
  // AMENDED for ISSUE-243 (was: `before-quit` tore down today's runtime, `LegacyRuntimeRoute.beforeQuit`): nothing of
  // today's runtime is composed to tear down.
  lifecycle.onWillQuit(() => {
    toggle?.dispose()
    trayProcess?.dispose()
    notificationPresenter?.dispose()
    departedDwarfs?.dispose()
    stopConnectionPush?.()
    uiSession?.dispose()
    stopResetListening?.()
    stopDwarf?.dispose()
    providerRouting?.dispose()
    minesAdmin?.dispose()
    hostReads?.dispose()
    stopHearingVisibility?.()
    shell?.dispose()
    host?.client.dispose()
  })
  // The app lives in the tray with every window hidden: closing the last window never quits it
  // (only Stop everything and quit does; before cut 0, today's tray Quit), as today. It enters tray-only, so the UI
  // session store is cleared (S10.14; ADR-024 item 3).
  lifecycle.onWindowAllClosed(() => {
    shell?.coordinator.closed('windows-closed')
    uiSession?.clear()
  })
  /** The step of the start running now, recorded when the start fails (`ui.start`). */
  let step: UiStartStep = 'ready'
  try {
    await lifecycle.whenReady()
    // "Start with the system" is applied before any window (S40.01, S40.02); a refusal is logged, never shown (S40.07).
    startWithSystem?.applyAtStart()
    if (panel !== undefined) {
      // A second launch shows the rebuilt Panel from now on; it is built hidden with its page loading, as today's
      // start built today's. A `--background` start builds no window: the Panel is built when the person opens the app
      // (S10.03, S10.13).
      secondLaunch.attach(shownPanel)
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
            open: () => shownPanel.show(),
            // With the coordinator, Quit is S27.10 and S10.15: a run in progress ends and the ladder is tray-only.
            closeAll: () => (shell === undefined ? panel.hide() : shell.coordinator.closed('quit'))
          },
          // Quit enters tray-only: the UI-main session store is cleared (S10.15; ADR-024 item 3).
          sessionStore: { clear: () => uiSession?.clear() },
          stopEverything: stop,
          onHostClosing: (h) => host.client.onClosing(h),
          exit: () => lifecycle.quit(),
          // No system tray (13 FM-050): the Panel is the only way back to the app, so it is shown; the renderer
          // offers Stop everything and quit there (A-N34).
          offerFromWindow: () => shownPanel.show()
        })
      }
      // The Dock, the `.env` file, the candidate login entry and the app's identity, where today's composition did
      // them (shellStart.ts).
      step = 'shell'
      await shellStart?.start()
    }
  } catch (error) {
    // The start cannot go on. The UI log says which step failed and the error's class or code, never its message
    // (ADR-026 items 3-4), and is written out before the process ends.
    uiLog?.record(uiStartFailed(step, error))
    await uiLog?.flush?.().catch(() => {})
    lifecycle.exit(1)
  }
  return { reopen }
}

/**
 * What this Electron process was started for. `--revert-integrations` (ADR-016 item 7; ISSUE-225 lead decision) runs
 * the Host copy in its revert mode (hostLauncher/revertIntegrations.ts) and exits with its code: nothing of the UI
 * starts, so no single-instance lock is taken (an uninstall hook runs it while the app may be open), no route, window,
 * tray or shortcut exists and today's runtime is never composed. Every other start is the UI's (`start`).
 */
export async function startUiProcess(deps: {
  argv: readonly string[]
  revertIntegrations: () => Promise<number>
  start: () => void
  exit: (code: number) => void
}): Promise<void> {
  if (!wantsRevertIntegrations(deps.argv)) {
    deps.start()
    return
  }
  let code = REVERT_FAILED_EXIT_CODE
  try {
    code = await deps.revertIntegrations()
  } catch {
    // The Host copy could not run the revert; the uninstall goes on (FM-128).
  }
  deps.exit(code)
}

/** A revert that could not run (ADR-016 item 7: "a non-zero code"). */
const REVERT_FAILED_EXIT_CODE = 1

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
function electronPanelWindow(
  store: UiPreferenceStore,
  uiLog: UiLog
): {
  factory: (modeWindows: ModeWindowRegistry) => PanelWindowUseCases
  veta: () => VetaWindowParts
  /** Whether a `webContents` id is the Veta window's (none before it is built). */
  isVeta(webContentsId: number): boolean
  composed(): PanelWindowUseCases | null
} {
  let panel: PanelWindowUseCases | null = null
  let built: { windows: ElectronWindows; screenArea: ElectronScreenArea } | null = null
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
    built = { windows, screenArea }
    return panel
  }
  // The Veta window over the same factory and displays (ISSUE-285): composing it builds nothing; the window is built
  // on its first move, at the place its dock keeps per display (ISSUE-286; 07 machine 21), and the dock hears the
  // display events once Electron is ready (S21.12–S21.14).
  const veta = (): VetaWindowParts => {
    if (built === null) throw new Error('the Veta window was composed before the Panel')
    const { windows, screenArea } = built
    const platform = currentUiPlatform()
    // The controller and its dock read each other late: the dock places the window once it exists, the window is
    // placed where the dock says.
    let controller: VetaWindowController | null = null
    const window = (): ModeWindow | null => (controller?.built() ? controller.window() : null)
    const dock = createVetaDockService({
      screen: screenArea,
      prefs: createUiPreferences({ store, modeWindows: () => [] }),
      panelSide: () => store.load('dockSide'),
      window: {
        placeAt: (bounds) => window()?.placeAt(bounds),
        send: (push, payload) => window()?.send(push, payload)
      },
      dockingAvailable: () => controller?.limits().dockingAvailable ?? true,
      island: { length: VETA_ISLAND_PLACEHOLDER.width, thickness: VETA_ISLAND_PLACEHOLDER.height },
      log: uiLog
    })
    controller = createVetaWindowController({
      factory: windows,
      surface: () => windows.vetaSurface(),
      screen: screenArea,
      displayKey: () => dock.current().displayKey,
      dock: () => dock.current().dock,
      island: () => ({ width: dock.island().length, height: dock.island().thickness }),
      platform,
      session: platform === 'linux' ? runningLinuxSession(process.env, process.argv) : null,
      log: uiLog
    })
    void app.whenReady().then(() => screenArea.onChange(() => dock.displaysChanged()))
    return {
      controller,
      dock,
      isVeta: (webContentsId) => windows.vetaWebContentsId() === webContentsId
    }
  }
  return {
    factory,
    veta,
    isVeta: (webContentsId) => built?.windows.vetaWebContentsId() === webContentsId,
    composed: () => panel
  }
}

/**
 * The native rows over Electron (ISSUE-050; 14 §2.1 A-21, A-22, A-24, A-28, A-29): the attachment picker attached to
 * the Panel window, the system clipboard, the allowlisted external opener, and the build info and feature flags. The
 * flags are read on the first call (`contracts/config` over the environment and the userData config file): today's
 * runtime reads the same layers when it is composed and stops the start on a wrong value, so UI main never answers
 * from a configuration today's runtime refused. The same actions carry A-30's folder picker and A-20's opener for the
 * mines admin rows (ISSUE-091).
 */
function electronNativeRows(panelWindow: () => BrowserWindow | undefined): {
  rows: RouteTarget
  actions: ServedNativeActions
} {
  let info: AppInfo | null = null
  const appInfo = (): AppInfo =>
    (info ??= createAppInfo({
      build: { version: app.getVersion(), packaged: app.isPackaged },
      env: process.env,
      readConfigFile: () => readUserDataConfigFile(app.getPath('userData'))
    }))
  const actions = createNativeActions({
    files: new ElectronFilePicker({
      dialog,
      windowOf: (ref) => BrowserWindow.fromId(ref.windowId)
    }),
    // A-30's folder picker (ISSUE-091), attached like the attachment picker.
    folders: new ElectronFolderPicker({
      dialog,
      windowOf: (ref) => BrowserWindow.fromId(ref.windowId)
    }),
    clipboard: new ElectronClipboard(clipboard),
    opener: new ElectronExternalOpener(shell),
    // AMENDED for ISSUE-288 (was: the Panel, cut 0's one mode window): the window the person pressed the control in,
    // which holds the focus as they press it — Veta for its mine picker's Add a mine (07 S22.10), the Panel for its
    // own controls — so the dialog is modal to, and shows over, the window that asked. With no window of the app
    // focused, the Panel.
    parentWindow: () => ({
      windowId: (BrowserWindow.getFocusedWindow() ?? panelWindow())?.id ?? -1
    }),
    // A-13's execute half (ISSUE-170): the console target the Host resolved, raised or opened in the OS terminal.
    consoles: new TerminalConsoleRaiser()
  })
  return {
    rows: createNativeRows({
      actions,
      appInfo: { build: () => appInfo().build(), featureFlags: () => appInfo().featureFlags() }
    }),
    actions
  }
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

/**
 * The shell's own start work (shellStart.ts), run right before today's runtime is composed, where today's composition
 * did it: macOS's Dock tile hidden (`app.dock` exists there only), the working folder's `.env` read quietly, and the
 * candidate login entry (candidateAutostart.ts; 21 §2 cut 1) in a packaged build of an OS where S-027-4 has not passed
 * (`loginEntryGate.ts`), the old writer of the entry until v1. It writes today's entry: the packaged executable with no
 * arguments, the once-only default marker in Electron's userData. Then the app's identity (`APP_USER_MODEL_ID`), as
 * today's composition set it at every start until ISSUE-243 deleted it.
 */
function electronShellStart(uiLog: UiLog): UiShellStart {
  const platform = currentUiPlatform()
  const candidateAutostart =
    app.isPackaged && !loginEntryOffered(platform)
      ? createCandidateAutostart({
          entry: candidateLoginEntryFor({
            platform,
            command: { executable: process.execPath, args: [] },
            home: homedir(),
            env: process.env,
            reg: runRegExe
          }),
          marker: candidateDefaultMarkerAt(
            join(app.getPath('userData'), 'autostart-default-v1.marker')
          ),
          log: (record) => uiLog.record(record)
        })
      : undefined
  return createUiShellStart({
    dock: app.dock,
    loadEnvironmentFile: () => void loadDotenv({ quiet: true }),
    ...(candidateAutostart === undefined ? {} : { candidateAutostart }),
    // Every OS, as today's composition called it (Electron applies it on Windows only).
    setAppUserModelId: () => app.setAppUserModelId(APP_USER_MODEL_ID)
  })
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
  // `--revert-integrations` (ADR-016 item 7; ISSUE-225) runs the Host copy's revert mode and exits; any other start is
  // the UI's.
  void startUiProcess({
    argv: process.argv,
    revertIntegrations: () => electronRevertIntegrations(uiLog, dataDir),
    start: () => startElectronUi(dataDir, uiLog),
    exit: (code) => void uiLog.flush().finally(() => app.exit(code))
  })
}

/**
 * `--revert-integrations` over the Node host launcher (ISSUE-225): the same Host data folder, build manifest, entry
 * and versioned-copy root as the Host attach (electronHostClient), so the revert runs this build's Host copy against
 * the Host data of this profile.
 */
function electronRevertIntegrations(uiLog: UiLog, dataDir: string): Promise<number> {
  const outDir = join(import.meta.dirname, '..')
  return createNodeRevertIntegrations({
    hostDataDir: join(dataDir, 'host'),
    build: app.isPackaged ? 'release' : 'dev',
    execPath: process.execPath,
    hostManifest: nodeHostManifestPath({
      packaged: app.isPackaged,
      outDir,
      resourcesPath: process.resourcesPath
    }),
    hostEntry: join(outDir, 'host', 'main.js'),
    log: uiLog,
    client: { appVersion: app.getVersion(), buildId: __DWARFAI_BUILD_ID__ }
  })()
}

/** The UI's own start (16 §8.4): everything a normal or `--background` start composes, the lock first. */
function startElectronUi(dataDir: string, uiLog: ReturnType<typeof createUiLogger>): void {
  // ADR-025 item 6 (ISSUE-285): on a Wayland session with XWayland the app runs on X11, so positioning and
  // always-on-top work as there. Electron picks its display backend before this script runs, so a packaged start
  // without `--ozone-platform=x11` relaunches itself once with it, before it takes the single-instance lock or builds
  // a window. A development start keeps the backend it was given (the dev server owns its process).
  const relaunchArgs = app.isPackaged
    ? ozoneRelaunchArgs(currentUiPlatform(), process.env, process.argv.slice(1))
    : null
  if (relaunchArgs !== null) {
    app.relaunch({ args: relaunchArgs })
    app.exit(0)
    return
  }
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
  const rebuiltPanel = electronPanelWindow(uiPreferenceStore, uiLog)
  /** The Panel window, where every picker is attached: never the Veta window (ISSUE-285). */
  const panelBrowserWindow = (): BrowserWindow | undefined =>
    BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && !rebuiltPanel.isVeta(window.webContents.id)
    )
  // AMENDED for ISSUE-243, the deletion of today's runtime (was: today's runtime composed here through
  // `LegacyRuntimeRoute`, without its window, tray and shortcut, its pushes and pickers reaching the rebuilt Panel): no
  // row is `legacy` any more (21 §2 cut 5), so nothing of it is composed.
  void startUiMain({
    lock: new ElectronSingleInstanceLock(app),
    appVersion: app.getVersion(),
    lifecycle: electronLifecycle(),
    // The release's table for this build (ISSUE-188; 21 §2 row 3e; ADR-009 D6): a development build adds its
    // development-only rows (Antigravity's launch), a packaged build is a public one, as the Host's `isPublicBuild`.
    routes: routesForBuild({ publicBuild: app.isPackaged }),
    ipc: electronIpcMain(),
    appEntry: appEntryUrl(),
    appWindows,
    uiPreferences: { store: uiPreferenceStore, windows: appWindows },
    uiLog,
    panelWindow: rebuiltPanel.factory,
    vetaWindow: rebuiltPanel.veta,
    ...(() => {
      const native = electronNativeRows(panelBrowserWindow)
      return { nativeRows: native.rows, minesNative: native.actions, consoles: native.actions }
    })(),
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
      drawsWithoutWindow: drawsWithoutWindow(currentUiPlatform()),
      windowFocused: () => BrowserWindow.getFocusedWindow() !== null
    },
    launch: uiStartPlanOf(process.argv),
    ...electronStartWithSystem(uiPreferenceStore, uiLog),
    shellStart: electronShellStart(uiLog)
  })
}
