import { config as loadDotenv } from 'dotenv'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PanelWindowController } from '../ui-main/window/ports/panelWindowController'
import type { ShortcutPlatform } from '../shared/accelerator'
import type {
  AgentLaunchRequest,
  AgentModelCatalogList,
  AgentProviderList,
  AgentLaunchResult,
  AppBuild,
  FeatureFlags,
  DwarfFeedPage,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfPermissionAnswerRequest,
  DwarfPermissionDecision,
  DwarfQuestionAnswerResult,
  DwarfTextRequest,
  DwarfTextResult,
  DwarfTuningRequest,
  DwarfNameResult,
  DwarfTuningResult,
  CopyTextResult,
  ExternalLinkResult,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  HostedLaunchRequest,
  HostedLaunchResult,
  DwarfSendSettledPush,
  LaunchFailedPush,
  MaterialTotals,
  MetricsResetResult,
  Mine,
  MineDeclareResult,
  MineHistoryResult,
  MineOpenPathResult,
  MinesSnapshot,
  MineUndeclareResult,
  PanelEdge,
  ProjectQuery,
  ProjectQueryResult,
  ProjectSortDirection,
  ProjectSortKey,
  WatchedFeedPush,
  JevRouteLaunchResult,
  JevSettings,
  OpenCodeSettings
} from '../shared/contracts'
import {
  IPC_CHANNELS,
  isDwarfProvider,
  isHeldPermissionMode,
  isMineTier,
  parseAudioPreferences,
  parseLaunchView,
  parseTypographyPreferences,
  DWARF_IMAGE_EXTENSIONS,
  MAX_DWARF_ATTACHMENTS,
  parseDwarfAttachments,
  parseDwarfText,
  parseJevApiKeyInput,
  parseJevRouteLaunchRequest,
  parseJevPreferences,
  parseOpenCodeServerPasswordInput
} from '../shared/contracts'
import { describeAttachments, type AttachmentFilePort } from '../main/textDelivery/attachmentFiles'
import type { AttachmentReader } from '../main/textDelivery/attachmentDelivery'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from '../main/shell/autostart'
import {
  cliOverridesFrom,
  darwinConsoleInputOverride,
  linuxConsoleInputOverride,
  loadConfig
} from '../main/config/config'
import {
  CONFIG_FILE_NAME,
  createConfigFileStore,
  withConfigFileFallback
} from '../main/config/configFile'
import { sumTokensObserved } from '../main/domain/aggregate'
import { parseLaunchTuning } from '../main/domain/launchTuning'
import { parseLaunchPermissionMode } from '../main/domain/codexPermissions'
import { HookChannel } from '../main/hooks/hookChannel'
import { NodeHookFs } from '../main/hooks/hookFs'
import { DelegationService } from '../main/mcp/delegationService'
import { delegationFailure } from '../main/mcp/delegationServerProtocol'
import { HookListener } from '../main/hooks/hookListener'
import type { HookEvent } from '../main/hooks/hookPayload'
import { OpenCodePluginChannel } from '../main/opencodePermissions/openCodePluginChannel'
import { openCodeGlobalPluginDir } from '../main/opencodePermissions/openCodePluginInstaller'
import { createOpenCodeServerPasswordStore } from '../main/opencodePermissions/openCodeServerPassword'
import { createOpenCodePermissionAnswerPort } from '../main/opencodePermissions/answerOpenCodePermission'
import type { OpenCodePermissionPush } from '../main/opencodePermissions/permissionPushPayload'
import { NodeFs } from '../main/adapters/fsLike'
import { NodeSqlite } from '../main/adapters/sqliteLike'
import { createPlatformAdapters } from '../main/platform/platformAdapters'
import {
  MINE_PATH_OUTSIDE_REASON,
  MINE_PATH_UNOPENABLE_REASON,
  parseMineOpenPathRequest,
  verifyMinePath
} from '../main/shell/openMineFile'
import {
  EXTERNAL_LINK_REFUSED_REASON,
  parseExternalLinkRequest
} from '../main/shell/openExternalLink'
import { copyTextToClipboard, type ClipboardPort } from '../main/shell/copyText'
import { parseDwarfFeedPageRequest } from '../main/providers/feedWindow'
import { currentPlatform } from '../main/platform/platform'
import { APP_DB_FILENAME, createAppDatabase } from '../main/appDatabase/appDatabase'
import { runCoalBackfill } from '../main/ledger/coalBackfill'
import { LEDGER_JSON_FILENAME } from '../main/ledger/ledgerStore'
import { MaterialLedger } from '../main/ledger/materialLedger'
import { openLedgerStore } from '../main/ledger/openLedgerStore'
import { openProjectsStore } from '../main/projects/openProjectsStore'
import { createSqliteLaunchedSessionStore } from '../main/sessionLaunch/launchedSessionStore'
import { createSqliteDwarfNameStore } from '../main/dwarfNames/dwarfNameStore'
import { DWARF_NAME_NOT_ON_BOARD, parseDwarfNameRequest } from '../main/dwarfNames/dwarfNames'
import { TUNING_NOT_HELD } from '../main/sessionLaunch/heldSessionRegistry'
import type { ProjectsStore } from '../main/projects/projectsStore'
import { createAudioPreferenceStore } from '../main/shell/audioPreference'
import { createLaunchViewStore } from '../main/shell/launchViewPreference'
import { createJevApiKeyStore, type JevKeyVerdict } from '../main/shell/jevApiKey'
import {
  createJevPreferenceStore,
  type JevPreferenceSaveRefusalReason
} from '../main/shell/jevPreferences'
import { createJevLaunchRouter } from '../main/jev/routeLaunch'
import { createTypesafeJevRouter, jevDebugEnabled } from '../main/jev/typesafeJevRouter'
import { createPanelEdgePreferenceStore } from '../main/shell/panelEdgePreference'
import { createPinPreferenceStore } from '../main/shell/pinPreference'
import { AgentRuntime, expandHomePath } from '../main/runtime/runtime'
import { createShortcutPreferenceStore } from '../main/shell/shortcutPreference'
import { createTypographyPreferenceStore } from '../main/shell/typographyPreference'
import {
  createToggleShortcut,
  type GlobalShortcutLike,
  type ToggleShortcutController
} from '../main/shell/shortcuts'
import { createTray } from '../main/shell/tray'
import {
  applyAlwaysOnTop,
  createMainWindow,
  hidePanel,
  loadPanelPage,
  markQuitting,
  panelLayout,
  raiseWindowOf,
  seedPanelEdge,
  setPanelLayout,
  shellWebContents,
  showPanel,
  togglePanel
} from '../main/shell/window'
import { parseAnswerRequest } from '../main/shell/answerRequest'
import { APP_USER_MODEL_ID, needsAppUserModelId } from '../main/notifications/appUserModelId'
import { createElectronNotifications } from '../main/notifications/electronNotifications'
import { createNotificationPreferenceStore } from '../main/notifications/notificationPreference'
import { createNotifier, type Notifier } from '../main/notifications/notifier'

/** Today's handler of one seam A row: the body `src/main/index.ts` registers for that wire name. */
export type LegacyHandler = (payload: unknown) => unknown

/** Today's runtime and its Electron-main collaborators, composed. */
export interface LegacyRuntimeComposition {
  /** Today's handler per wire name (every `ipcMain.handle` and `ipcMain.on` of the legacy root). */
  readonly handlers: ReadonlyMap<string, LegacyHandler>
  /** Today's Panel window behind the window module's port, until ISSUE-047 rebuilds it. */
  readonly panelWindow: PanelWindowController
}

/**
 * Composes today's runtime, and tears it down on quit. The teardown is today's: it releases what
 * was composed so far, so it is safe before, during and after `compose()`.
 */
export interface LegacyRuntimeComposer {
  compose(): Promise<LegacyRuntimeComposition>
  /** Today's `before-quit` teardown. */
  beforeQuit(): void
  /** Today's `will-quit` release. */
  willQuit(): void
}

/**
 * The one door from the new Electron root to today's runtime (21 §3 `LegacyRuntimeRoute`, cuts
 * 0–5; ADR-001 item 3; lint R16). It composes the legacy runtime once and serves a `legacy` row
 * with today's handler, unchanged.
 */
export interface LegacyRuntimeRoute {
  /** Composes the legacy runtime (once) and answers its Panel window. */
  compose(): Promise<PanelWindowController>
  /** Serves a `legacy` row by today's wire name with today's handler result. */
  serve(channel: string, payload: unknown): Promise<unknown>
  beforeQuit(): void
  willQuit(): void
}

export function createLegacyRuntimeRoute(composer: LegacyRuntimeComposer): LegacyRuntimeRoute {
  let composing: Promise<LegacyRuntimeComposition> | null = null
  const composition = (): Promise<LegacyRuntimeComposition> => (composing ??= composer.compose())

  return {
    async compose() {
      return (await composition()).panelWindow
    },
    async serve(channel, payload) {
      const handler = (await composition()).handlers.get(channel)
      if (handler === undefined) {
        throw new Error(`LegacyRuntimeRoute: no legacy handler for ${channel}`)
      }
      return handler(payload)
    },
    beforeQuit() {
      composer.beforeQuit()
    },
    willQuit() {
      composer.willQuit()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Today's composition, adapted from `src/main/index.ts` (21 §2 cut 0: "composes today's
// AgentRuntime and its Electron-main collaborators exactly as src/main/index.ts does, from inside
// src/legacy-bridge/**"). Candidate decision (21 §6): the legacy entry is ADAPTED, not kept — it
// registers its handlers on `ipcMain` and runs itself on import, so it cannot be served through
// one door. Its wiring is carried here unchanged in what it composes and answers, with three
// adaptations only: every handler is put in the table `serve` reads instead of `ipcMain`; the
// Electron APIs it called directly arrive from the Electron root (lint R7: no `electron` import
// here); and its module-level singletons live in one closure. `src/main/index.ts` itself is
// untouched and stays the app entry until ISSUE-056.
// ---------------------------------------------------------------------------------------------

/** The main window today's composition creates (legacy `shell/window.ts`). */
type LegacyMainWindow = ReturnType<typeof createMainWindow>

/** What `nativeImage.createFromPath` answers, as far as the attachment thumbnail uses it. */
interface LegacyNativeImage {
  isEmpty(): boolean
  resize(options: { width: number; quality: 'good' }): { toDataURL(): string }
}

/**
 * The Electron main-process APIs today's composition calls directly, handed in by the Electron
 * root (the only tree that may import `electron`, lint R7). Every other Electron use of today's
 * runtime stays inside the legacy modules it composes.
 */
export interface LegacyElectronMain {
  app: {
    setAppUserModelId(id: string): void
    readonly dock?: { hide(): void } | undefined
    getPath(name: 'userData'): string
    readonly isPackaged: boolean
    getAppPath(): string
    getVersion(): string
  }
  dialog: {
    showOpenDialog(
      window: LegacyMainWindow,
      options: { properties: Array<'openDirectory' | 'openFile' | 'multiSelections'> }
    ): Promise<{ canceled: boolean; filePaths: string[] }>
  }
  nativeImage: { createFromPath(path: string): LegacyNativeImage }
  shell: {
    openPath(path: string): Promise<string>
    openExternal(url: string): Promise<void>
  }
  clipboard: ClipboardPort
  globalShortcut: GlobalShortcutLike
}

/** Twice the design's 40px chip, so the preview is sharp on a 2× display (#408). */
const ATTACHMENT_THUMBNAIL_PX = 80

/** A store refusal, in words the panel can show (#509 follow-up). */
const JEV_PREFERENCE_REFUSALS: Record<JevPreferenceSaveRefusalReason, string> = {
  'default-provider-not-launchable':
    'That default launch names a provider this build cannot start, so nothing was saved. Pick another provider under Default launch.',
  'default-tuning-invalid':
    'That default launch pairs a model or effort its provider would refuse, so nothing was saved. Clear it under Default launch and try again.'
}

const PERMISSION_DECISIONS: readonly DwarfPermissionDecision[] = ['allow', 'deny']
const PROJECT_SORT_KEYS: readonly ProjectSortKey[] = ['addedAt', 'lastOpenedAt']
const PROJECT_SORT_DIRECTIONS: readonly ProjectSortDirection[] = ['asc', 'desc']

/** Only the distinctions that change a modifier's printed name matter to the settings panel. */
function shortcutPlatform(): ShortcutPlatform {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'other'
}

/** The `warn` every port is handed: a missing cause is not printed as `undefined` (#555). */
function warnWithOptionalCause(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/** Boundary check of `sendDwarfText`; the message itself is never logged (#431, #408). */
function parseTextRequest(payload: unknown): DwarfTextRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string') return null
  const text = parseDwarfText(record.text)
  if (text === null) return null
  const attachments = parseDwarfAttachments(record.attachments)
  if (attachments === null) return null
  return {
    dwarfId: record.dwarfId,
    text,
    pressEnter: record.pressEnter === true,
    ...(attachments.length === 0 ? {} : { attachments })
  }
}

/** Boundary check of `launchAgent`: never a directory, never a defaulted provider (#168, #239, #635, #511). */
function parseLaunchRequest(payload: unknown): AgentLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  if (!isDwarfProvider(record.provider)) return null
  const tuning = parseLaunchTuning(record.provider, record)
  if (tuning === null) return null
  const permission = parseLaunchPermissionMode(record.provider, record)
  if (permission === null) return null
  return {
    mineId: record.mineId,
    provider: record.provider,
    prompt: record.prompt,
    ...tuning,
    ...permission,
    ...(record.routedByJev === true ? { routedByJev: true } : {})
  }
}

/** Boundary check of `launchHostedProcess` (#194): the command is only checked for being a string. */
function parseHostedLaunchRequest(payload: unknown): HostedLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  if (typeof record.command !== 'string') return null
  return { mineId: record.mineId, command: record.command, prompt: record.prompt }
}

function parseKickRequest(payload: unknown): DwarfKickRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string') return null
  return { dwarfId: record.dwarfId }
}

/** Boundary check of `setDwarfTuning` (#96): a `kind` this build cannot read takes the request down. */
function parseTuningRequest(payload: unknown): DwarfTuningRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || record.dwarfId === '') return null
  const change = record.change
  if (typeof change !== 'object' || change === null) return null
  const named = change as Record<string, unknown>
  if (named.kind === 'model' && typeof named.model === 'string' && named.model !== '') {
    return { dwarfId: record.dwarfId, change: { kind: 'model', model: named.model } }
  }
  if (named.kind === 'effort' && typeof named.effort === 'string' && named.effort !== '') {
    return { dwarfId: record.dwarfId, change: { kind: 'effort', effort: named.effort } }
  }
  return null
}

/** Boundary check of `launchHeldSession` (#168, #239, #511): no `bypassPermissions` ever passes. */
function parseHeldLaunchRequest(payload: unknown): HeldSessionLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  if (!isDwarfProvider(record.provider)) return null
  const tuning = parseLaunchTuning(record.provider, record)
  if (tuning === null) return null
  if (record.permissionMode !== undefined && !isHeldPermissionMode(record.permissionMode)) {
    return null
  }
  return {
    mineId: record.mineId,
    provider: record.provider,
    prompt: record.prompt,
    ...tuning,
    ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }),
    ...(record.routedByJev === true ? { routedByJev: true } : {})
  }
}

/** Boundary check of `answerDwarfPermission`: the decision is one of the closed list. */
function parsePermissionRequest(payload: unknown): DwarfPermissionAnswerRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.toolUseId !== 'string') return null
  if (!isOneOf(record.decision, PERMISSION_DECISIONS)) return null
  return { dwarfId: record.dwarfId, toolUseId: record.toolUseId, decision: record.decision }
}

/** Boundary check of `queryProjects` (#92): the sort key and direction name parts of a statement. */
function parseProjectQuery(payload: unknown): ProjectQuery | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const sortBy = record.sortBy
  const direction = record.direction
  if (!isOneOf(sortBy, PROJECT_SORT_KEYS)) return null
  if (!isOneOf(direction, PROJECT_SORT_DIRECTIONS)) return null
  return {
    sortBy,
    direction,
    ...(isMineTier(record.tier) ? { tier: record.tier } : {}),
    ...(typeof record.nameContains === 'string' ? { nameContains: record.nameContains } : {}),
    ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
    ...(typeof record.offset === 'number' ? { offset: record.offset } : {})
  }
}

/** One attached image's bytes for a held session's content block (#408). */
const readAttachment: AttachmentReader = async (path) => {
  const lower = path.toLowerCase()
  const extension = DWARF_IMAGE_EXTENSIONS.find((candidate) => lower.endsWith(candidate))
  if (extension === undefined) return null
  const mediaType =
    extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`
  try {
    const bytes = await readFile(path)
    return { base64: bytes.toString('base64'), mediaType }
  } catch {
    return null
  }
}

/** A mines list with its vault totals, for `getMines` and the push. */
function toMinesSnapshot(
  mines: Mine[],
  materials: MaterialTotals | undefined,
  watchedFeed?: WatchedFeedPush
): MinesSnapshot {
  return {
    mines,
    tokensObserved: sumTokensObserved(mines),
    ...(materials === undefined ? {} : { materials }),
    ...(watchedFeed === undefined ? {} : { watchedFeed })
  }
}

/** Every window of the app whose page is still alive: since #635 the one shell window. */
function appWebContents(): NonNullable<ReturnType<typeof shellWebContents>>[] {
  return [shellWebContents()].filter(
    (contents): contents is NonNullable<typeof contents> => contents !== null
  )
}

/**
 * Today's composition of the legacy runtime (the body of `init()` in `src/main/index.ts`) and its
 * quit teardown (that file's `before-quit` and `will-quit` handlers).
 */
export function composeLegacyRuntime(electron: LegacyElectronMain): LegacyRuntimeComposer {
  const { app, dialog, nativeImage, shell, clipboard, globalShortcut } = electron

  // Today's module-level singletons: the quit teardown reads them, null-safe, at any time.
  let runtime: AgentRuntime | null = null
  let hooks: HookChannel | null = null
  let delegationService: DelegationService | null = null
  let hookListener: HookListener | null = null
  let openCodePlugin: OpenCodePluginChannel | null = null
  let projects: ProjectsStore | null = null
  let toggleShortcut: ToggleShortcutController | null = null

  /** The OS folder picker, owned by the panel window (#85). */
  async function chooseProjectDirectory(parent: LegacyMainWindow): Promise<string | null> {
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  }

  /** The composer's attach control (#408): files only, paths only. */
  async function chooseAttachmentFiles(parent: LegacyMainWindow): Promise<string[]> {
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  }

  /** The real filesystem behind `describeAttachments` (#408). */
  const attachmentFiles: AttachmentFilePort = {
    async stat(path) {
      try {
        const stats = await stat(path)
        return { bytes: stats.size, directory: stats.isDirectory() }
      } catch {
        return null
      }
    },
    async thumbnail(path) {
      try {
        const image = nativeImage.createFromPath(path)
        if (image.isEmpty()) return null
        return image.resize({ width: ATTACHMENT_THUMBNAIL_PX, quality: 'good' }).toDataURL()
      } catch {
        return null
      }
    }
  }

  async function init(): Promise<LegacyRuntimeComposition> {
    const handlers = new Map<string, LegacyHandler>()
    const handle = (channel: string, handler: LegacyHandler): void => {
      handlers.set(channel, handler)
    }

    app.setAppUserModelId('com.jeronimorepetto.dwarfaiminers')
    // A tray app with a hidden floating panel owns no Dock tile (macOS only).
    app.dock?.hide()

    // System notifications (#316): the toast identity, before anything can raise one.
    if (needsAppUserModelId(currentPlatform())) app.setAppUserModelId(APP_USER_MODEL_ID)

    // Typed config, fails fast before any window exists (#38): env beats file beats defaults.
    loadDotenv({ quiet: true })
    const configFile = createConfigFileStore({
      filePath: join(app.getPath('userData'), CONFIG_FILE_NAME),
      onWarn: (message) => console.warn(message)
    })
    const config = loadConfig(withConfigFileFallback(process.env, await configFile.load()))
    console.log('[main] Config loaded:', config)

    await migrateLegacyAutostart(app.isPackaged)
    await ensureDefaultAutostart({
      isPackaged: app.isPackaged,
      markerPath: join(app.getPath('userData'), 'autostart-default-v1.marker'),
      enable: enableAutostart,
      warn: warnWithOptionalCause
    })

    // Read before the window exists, so the first frame has the right stacking and edge (#35, #138).
    const pinStore = createPinPreferenceStore({
      filePath: join(app.getPath('userData'), 'pin-preference-v1.json')
    })
    const panelEdgeStore = createPanelEdgePreferenceStore({
      filePath: join(app.getPath('userData'), 'panel-edge-v1.json')
    })
    seedPanelEdge(await panelEdgeStore.load())

    const mainWindow = createMainWindow({ alwaysOnTop: await pinStore.load() }) // starts hidden

    const audioStore = createAudioPreferenceStore({
      filePath: join(app.getPath('userData'), 'audio-preferences-v1.json')
    })

    // Jev API key (#509): primed here, the launch router reads it synchronously.
    const jevApiKeyStore = createJevApiKeyStore({ userDataDir: app.getPath('userData') })
    await jevApiKeyStore.load()

    // OpenCode server password (#588 T6, F1): primed for the same reason; never from the environment.
    const openCodePasswordStore = createOpenCodeServerPasswordStore({
      userDataDir: app.getPath('userData')
    })
    await openCodePasswordStore.load()
    /** Why the OpenCode relay is not on when it was asked to be. */
    let openCodePluginError: string | undefined

    const jevPreferenceStore = createJevPreferenceStore({ userDataDir: app.getPath('userData') })

    // Jev launch routing (#509, #525/T4): one debug sink, only when JEV_DEBUG says so.
    const jevDebugLog = jevDebugEnabled() ? (line: string) => console.log(line) : undefined
    const jevRouterPort = createTypesafeJevRouter({
      readKey: jevApiKeyStore.readKey,
      ...(jevDebugLog === undefined ? {} : { debugLog: jevDebugLog })
    })
    const jevLaunchRouter = createJevLaunchRouter({
      router: jevRouterPort,
      listProviders: async () => (await runtime?.listAgentProviders())?.providers ?? [],
      listModels: async () => (await runtime?.listAgentModels())?.catalogs ?? [],
      readPreferences: jevPreferenceStore.load,
      readOpenCodeCatalogue: async () => (await runtime?.readOpenCodeCatalogue()) ?? [],
      ...(jevDebugLog === undefined ? {} : { debugLog: jevDebugLog })
    })

    // Typography (#370, v2 presets #635): the v1 document is read once to migrate it.
    const typographyStore = createTypographyPreferenceStore({
      filePath: join(app.getPath('userData'), 'typography-preferences-v2.json'),
      legacyFilePath: join(app.getPath('userData'), 'typography-preferences-v1.json')
    })

    // The launch view (#635, PANEL-QUESTIONS 25).
    const launchViewStore = createLaunchViewStore({
      filePath: join(app.getPath('userData'), 'launch-view-v1.json')
    })

    // Whether the shell is really on screen (#174, #173): visible and not minimised.
    const panelVisible = (): boolean => mainWindow.isVisible() && !mainWindow.isMinimized()
    const publishPanelVisibility = (): void => {
      shellWebContents()?.send(IPC_CHANNELS.panelVisibilityChanged, panelVisible())
    }
    mainWindow.on('show', publishPanelVisibility)
    mainWindow.on('hide', publishPanelVisibility)
    mainWindow.on('minimize', publishPanelVisibility)
    mainWindow.on('restore', publishPanelVisibility)

    // System notifications (#316).
    const notificationStore = createNotificationPreferenceStore({
      filePath: join(app.getPath('userData'), 'notification-preference-v1.json')
    })
    let notificationsEnabled = await notificationStore.load()
    /** Which mine interior the shell has open, as the renderer last reported it. */
    let openMineId: string | null = null
    const notifier: Notifier = createNotifier({
      port: createElectronNotifications(),
      enabled: () => notificationsEnabled,
      focus: () => ({ panelVisible: panelVisible(), openMineId }),
      openMine: (mineId: string) => {
        showPanel()
        shellWebContents()?.send(IPC_CHANNELS.showMine, mineId)
      }
    })

    // The panel-toggle shortcut (#17).
    const shortcutStore = createShortcutPreferenceStore({
      filePath: join(app.getPath('userData'), 'shortcut-preference-v1.json')
    })
    const storedAccelerator = await shortcutStore.load()

    // The app's own database (#93), one handle for its tenants, deliberately never closed on quit.
    const appDatabase = createAppDatabase({
      filePath: join(app.getPath('userData'), APP_DB_FILENAME)
    })

    // The material vault (#22), loaded before the runtime exists.
    const vault = await openLedgerStore({
      database: appDatabase,
      jsonPath: join(app.getPath('userData'), LEDGER_JSON_FILENAME),
      now: Date.now,
      warn: (message) => console.warn(message),
      log: (message) => console.log(message)
    })
    const ledger = new MaterialLedger({
      store: vault.store,
      onError: (message, error) => console.warn(message, error)
    })
    await ledger.load()

    // Every project the app has been shown (#93, #572): a null store is a state, not a failure.
    const openedProjects = await openProjectsStore({
      database: appDatabase,
      warn: (message) => console.warn(message)
    })
    projects = openedProjects.store
    const projectsRefusal = openedProjects.failure

    // What this app launched (#231), and the names a person gives dwarfs (#635).
    const launchedSessionStore =
      projects === null ? null : createSqliteLaunchedSessionStore({ database: appDatabase })
    const dwarfNameStore =
      projects === null ? null : createSqliteDwarfNameStore({ database: appDatabase })

    // Console input overrides per OS (#367, #471).
    const darwinConsoleInputSetting = darwinConsoleInputOverride()
    const linuxConsoleInputSetting = linuxConsoleInputOverride()

    const home = homedir()
    const fs = new NodeFs()
    const appPaths = {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }
    // The production platform adapters, built explicitly (#477).
    const platformAdapters = createPlatformAdapters({
      home,
      appPaths,
      relayModel: config.sendTextRelayModel,
      relayTimeoutMs: config.sendTextTimeoutS * 1_000,
      fs,
      cliOverrides: cliOverridesFrom(config),
      ...(darwinConsoleInputSetting !== undefined
        ? { darwinConsoleInput: darwinConsoleInputSetting }
        : {}),
      ...(linuxConsoleInputSetting !== undefined
        ? { linuxConsoleInput: linuxConsoleInputSetting }
        : {})
    })

    runtime = new AgentRuntime({
      config,
      ledger,
      projects,
      projectsRefusal,
      launchedSessionStore,
      dwarfNameStore,
      home,
      fs,
      appPaths,
      platformAdapters,
      chooseDirectory: () => chooseProjectDirectory(mainWindow),
      readAttachment,
      // MCP subtask delegation (#511 T4, M1a, #601): the service is read lazily, it starts later.
      delegation: {
        keyConfigured: () => jevApiKeyStore.readKey() !== undefined,
        delegationAllowed: async () => (await jevPreferenceStore.load()).delegation,
        issueLaunchToken: (context) => delegationService?.issueLaunchToken(context),
        revoke: (token) => delegationService?.revoke(token),
        delegate: async (token, task, context) =>
          delegationService === null
            ? {
                failure: delegationFailure(
                  'link-unconfigured',
                  'The delegation service is not running.'
                )
              }
            : delegationService.delegateDirect(token, task, context),
        result: (token, ticket) =>
          delegationService === null
            ? {
                status: 'failed',
                failure: delegationFailure(
                  'link-unconfigured',
                  'The delegation service is not running.'
                )
              }
            : delegationService.resultDirect(token, ticket),
        waitEnded: (ticket) => delegationService?.waitEnded(ticket)
      },
      // #588 T6 (F1): the answer port reads the Settings password on every answer.
      answerOpenCodePermission: createOpenCodePermissionAnswerPort(globalThis.fetch, {
        readPassword: openCodePasswordStore.readPassword
      }),
      onMinesUpdated: (mines: Mine[], materials: MaterialTotals, watchedFeed?: WatchedFeedPush) => {
        const snapshot = toMinesSnapshot(mines, materials, watchedFeed)
        for (const contents of appWebContents()) {
          contents.send(IPC_CHANNELS.minesUpdated, snapshot)
        }
        // After the renderers (#316): the panel's own paint comes first.
        notifier.update(mines)
      },
      onLaunchFailed: (push: LaunchFailedPush) => {
        for (const contents of appWebContents()) {
          contents.send(IPC_CHANNELS.launchFailed, push)
        }
      },
      onSendSettled: (push: DwarfSendSettledPush) => {
        for (const contents of appWebContents()) {
          contents.send(IPC_CHANNELS.dwarfSendSettled, push)
        }
      }
    })
    await runtime.loadDeclared()
    await runtime.restoreLaunchedSessions()
    runtime.start()

    // MCP subtask delegation: the loopback service (#511 T3, #601), always started.
    delegationService = new DelegationService({
      port: 0,
      launch: (request, delegationHooks) =>
        runtime?.launchAgent(request, delegationHooks) ??
        Promise.resolve({
          launched: false,
          provider: 'none',
          error: 'The panel is still starting up.'
        }),
      route: jevLaunchRouter.route,
      keyConfigured: () => jevApiKeyStore.readKey() !== undefined,
      delegationAllowed: async () => (await jevPreferenceStore.load()).delegation,
      deliverToHeldParent: (token, text) => runtime?.pushToHeldParent(token, text) ?? false
    })
    await delegationService.start()

    // The historical coal pile (#22), deliberately not awaited.
    void runCoalBackfill({
      fs: new NodeFs(),
      sqlite: new NodeSqlite(),
      markerFs: { readFile, writeFile, rename },
      markerPath: join(app.getPath('userData'), 'coal-backfill-v1.json'),
      claudeRoots: config.providers.claude.configDirs.map((path) => expandHomePath(path)),
      codexSessionsRoot: expandHomePath(config.providers.codex.sessionsRoot),
      opencodeStoreRoot: expandHomePath(config.providers.opencode.storeRoot),
      credit: (mineId, tokens) => ledger.creditCoal(mineId, tokens),
      now: Date.now,
      warn: warnWithOptionalCause
    })
      .then((result) => {
        if (!result.ran) return
        console.log(
          `[coal] Backfilled ${result.tokensCredited} historical tokens across ` +
            `${result.projectsCredited} project(s) from ${result.filesRead} file(s); ` +
            `${result.done ? 'complete' : 'will continue on the next launch'}.`
        )
      })
      .catch((error: unknown) => console.warn('[coal] Historical backfill failed:', error))

    // Optional push channels (#94, #203, #588 T6 F5): one shared listener, opt-in routes.
    const hookFs = new NodeHookFs()
    const onHookEvent = (event: HookEvent): void => {
      const kind = event.notificationType === undefined ? '' : ` (${event.notificationType})`
      console.log(
        `[hooks] ${event.event}${kind}${event.cwd === undefined ? '' : ` in ${event.cwd}`}`
      )
      runtime?.noteHookEvent(event)
      runtime?.nudge()
    }
    const onOpenCodePush = (push: OpenCodePermissionPush): void => {
      runtime?.noteOpenCodePush(push)
      runtime?.nudge()
    }
    hookListener = new HookListener({
      fs: hookFs,
      userDataDir: app.getPath('userData'),
      port: config.hooksPort,
      onEvent: onHookEvent,
      onOpenCodePush,
      log: (message) => console.log(message),
      warn: warnWithOptionalCause
    })
    hooks = new HookChannel({
      fs: hookFs,
      roots: config.providers.claude.configDirs.map((path) => expandHomePath(path)),
      userDataDir: app.getPath('userData'),
      port: config.hooksPort,
      platform: process.platform,
      onEvent: onHookEvent,
      listener: hookListener,
      log: (message) => console.log(message),
      warn: warnWithOptionalCause
    })
    await hooks.restore()
    openCodePlugin = new OpenCodePluginChannel({
      fs: hookFs,
      pluginDir: openCodeGlobalPluginDir(home, process.env, currentPlatform()),
      userDataDir: app.getPath('userData'),
      listener: hookListener,
      log: (message) => console.log(message),
      warn: warnWithOptionalCause
    })
    openCodePluginError = (await openCodePlugin.restore())?.error

    await createTray({ hooks })

    // Claim the shortcut; a refusal lives in the state the settings panel reads.
    const toggle = createToggleShortcut({
      initial: storedAccelerator,
      onToggle: togglePanel,
      globalShortcut,
      platform: shortcutPlatform()
    })
    toggleShortcut = toggle
    const startupState = toggle.start()
    if (startupState.error !== undefined) console.warn(`[shortcuts] ${startupState.error}`)

    // Which build is running (#79), asked of Electron.
    const appBuild: AppBuild = { version: app.getVersion(), packaged: app.isPackaged }
    handle(IPC_CHANNELS.getAppBuild, () => appBuild)

    // The features that ship hidden (#635).
    const featureFlags: FeatureFlags = { guildAreasEnabled: config.guildAreasEnabled }
    handle(IPC_CHANNELS.getFeatureFlags, () => featureFlags)

    const noActivation = { focused: false, openedTerminal: false, feed: [] }
    const noFeed: DwarfFeedResult = { readable: false, messages: [] }
    const noFeedPage: DwarfFeedPage = { readable: false, messages: [], reachedStart: false }
    handle(IPC_CHANNELS.hidePanel, () => hidePanel())
    // Raise and focus the window that sent the click (#165): since #635 always the shell window.
    handle(IPC_CHANNELS.raisePanel, () => {
      const contents = shellWebContents()
      if (contents !== null) raiseWindowOf(contents)
    })
    handle(IPC_CHANNELS.getAlwaysOnTop, () => mainWindow.isAlwaysOnTop())
    handle(IPC_CHANNELS.setAlwaysOnTop, async (payload) => {
      if (typeof payload !== 'boolean') return mainWindow.isAlwaysOnTop()
      const real = applyAlwaysOnTop(mainWindow, payload)
      try {
        await pinStore.save(real)
      } catch (error) {
        console.warn('[pin] Failed to persist the always-on-top preference:', error)
      }
      return real
    })
    handle(IPC_CHANNELS.getPanelVisible, () => panelVisible())
    handle(IPC_CHANNELS.getAudioPreferences, () => audioStore.load())
    handle(IPC_CHANNELS.setAudioPreferences, async (payload) => {
      const preferences = parseAudioPreferences(payload)
      try {
        await audioStore.save(preferences)
      } catch (error) {
        console.warn('[audio] Failed to persist the audio preferences:', error)
      }
      return preferences
    })
    handle(IPC_CHANNELS.getTypographyPreferences, () => typographyStore.load())
    handle(IPC_CHANNELS.setTypographyPreferences, async (payload) => {
      const preferences = parseTypographyPreferences(payload)
      try {
        await typographyStore.save(preferences)
      } catch (error) {
        console.warn('[typography] Failed to persist the typography preferences:', error)
      }
      for (const contents of appWebContents()) {
        contents.send(IPC_CHANNELS.typographyPreferencesChanged, preferences)
      }
      return preferences
    })
    handle(IPC_CHANNELS.getNotificationsEnabled, () => notificationsEnabled)
    handle(IPC_CHANNELS.setNotificationsEnabled, async (payload) => {
      if (typeof payload !== 'boolean') return notificationsEnabled
      notificationsEnabled = payload
      try {
        await notificationStore.save(payload)
      } catch (error) {
        console.warn('[notifications] Failed to persist the notifications switch:', error)
      }
      return notificationsEnabled
    })
    handle(IPC_CHANNELS.setOpenMine, (payload) => {
      openMineId = typeof payload === 'string' && payload !== '' ? payload : null
    })
    handle(IPC_CHANNELS.getLaunchView, () => launchViewStore.load())
    handle(IPC_CHANNELS.setLaunchView, (payload) => {
      void launchViewStore.remember(parseLaunchView(payload))
    })

    // Jev API key (#509): never answered with the key; the merged shape with the preferences.
    async function withJevPreferences(verdict: JevKeyVerdict): Promise<JevSettings> {
      return { ...verdict, preferences: await jevPreferenceStore.load() }
    }
    handle(IPC_CHANNELS.getJevSettings, async () => withJevPreferences(await jevApiKeyStore.load()))
    handle(IPC_CHANNELS.setJevApiKey, async (payload) => {
      try {
        const key = parseJevApiKeyInput(payload)
        const result = await jevApiKeyStore.save(key)
        if (!result.saved) {
          console.warn(`[jev] API key not saved: ${result.reason}`)
          if (result.reason === 'encryption-unavailable') {
            return withJevPreferences({
              configured: false,
              unavailableReason: 'encryption-unavailable'
            })
          }
        }
      } catch (error) {
        console.warn('[jev] Refused to save an API key:', error)
      }
      return withJevPreferences({ configured: jevApiKeyStore.readKey() !== undefined })
    })
    handle(IPC_CHANNELS.clearJevApiKey, async () => {
      try {
        await jevApiKeyStore.clear()
      } catch (error) {
        console.warn('[jev] Failed to clear the stored API key:', error)
      }
      return withJevPreferences({ configured: jevApiKeyStore.readKey() !== undefined })
    })
    const jevRouteRefused: JevRouteLaunchResult = { kind: 'fallback', reason: 'invalid-response' }
    handle(IPC_CHANNELS.routeJevLaunch, async (payload): Promise<JevRouteLaunchResult> => {
      try {
        const request = parseJevRouteLaunchRequest(payload)
        return await jevLaunchRouter.route(request)
      } catch (error) {
        console.warn('[jev] Refused a route request:', error)
        return jevRouteRefused
      }
    })
    handle(IPC_CHANNELS.setJevPreferences, async (payload) => {
      const preferences = parseJevPreferences(payload)
      let failure: string | undefined
      try {
        const result = await jevPreferenceStore.save(preferences)
        if (!result.saved) failure = JEV_PREFERENCE_REFUSALS[result.reason]
      } catch (error) {
        failure = `The preference could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
      if (failure !== undefined) console.warn(`[jev] Preferences not saved: ${failure}`)
      const stored = await withJevPreferences(await jevApiKeyStore.load())
      return failure === undefined ? stored : { ...stored, preferencesError: failure }
    })

    // OpenCode permission relay (#588 T6): the state in force, never the password.
    async function openCodeSettings(): Promise<OpenCodeSettings> {
      const password = await openCodePasswordStore.load()
      return {
        pluginEnabled: openCodePlugin?.isActive() ?? false,
        ...(openCodePluginError === undefined ? {} : { pluginError: openCodePluginError }),
        passwordConfigured: password.configured,
        ...(password.unavailableReason === undefined
          ? {}
          : { passwordUnavailableReason: password.unavailableReason })
      }
    }
    handle(IPC_CHANNELS.getOpenCodeSettings, () => openCodeSettings())
    handle(IPC_CHANNELS.setOpenCodePluginEnabled, async (payload) => {
      if (typeof payload !== 'boolean' || openCodePlugin === null) return openCodeSettings()
      try {
        if (payload) {
          const result = await openCodePlugin.enable()
          openCodePluginError = result.enabled ? undefined : result.error
          if (!result.enabled)
            console.warn(`[opencode] Permission relay not enabled: ${result.error}`)
        } else {
          await openCodePlugin.disable()
          openCodePluginError = undefined
        }
      } catch (error) {
        openCodePluginError = error instanceof Error ? error.message : String(error)
        console.warn('[opencode] Permission relay switch failed:', error)
      }
      return openCodeSettings()
    })
    handle(IPC_CHANNELS.setOpenCodeServerPassword, async (payload) => {
      try {
        const result = await openCodePasswordStore.save(parseOpenCodeServerPasswordInput(payload))
        if (!result.saved) console.warn(`[opencode] Server password not saved: ${result.reason}`)
      } catch (error) {
        console.warn(
          `[opencode] Refused to save a server password: ${error instanceof Error ? error.message : 'unknown'}`
        )
      }
      return openCodeSettings()
    })
    handle(IPC_CHANNELS.clearOpenCodeServerPassword, async () => {
      try {
        await openCodePasswordStore.clear()
      } catch (error) {
        console.warn('[opencode] Failed to clear the stored server password:', error)
      }
      return openCodeSettings()
    })

    // The docked shell's own shape (#90, #138): answered with what the window is after the move.
    handle(IPC_CHANNELS.getPanelLayout, () => panelLayout())
    handle(IPC_CHANNELS.setPanelLayout, async (payload) => {
      if (typeof payload !== 'object' || payload === null) return panelLayout()
      const { mineOpen, dockOpen, edge } = payload as Record<string, unknown>
      if (typeof mineOpen !== 'boolean' || typeof dockOpen !== 'boolean') return panelLayout()
      const requestedEdge: PanelEdge | undefined =
        edge === 'left' || edge === 'right' ? edge : undefined
      const result = setPanelLayout({
        mineOpen,
        dockOpen,
        ...(requestedEdge ? { edge: requestedEdge } : {})
      })
      if (requestedEdge !== undefined) {
        try {
          await panelEdgeStore.save(result.edge)
        } catch (error) {
          console.warn('[panel] Failed to persist the position preference:', error)
        }
      }
      return result
    })
    handle(IPC_CHANNELS.getToggleShortcut, () => toggle.state())
    handle(IPC_CHANNELS.setToggleShortcut, async (payload) => {
      if (typeof payload !== 'string') return toggle.state()
      const state = toggle.apply(payload)
      try {
        await shortcutStore.save(state.accelerator)
      } catch (error) {
        console.warn('[shortcuts] Failed to persist the panel-toggle shortcut:', error)
      }
      return state
    })
    handle(IPC_CHANNELS.getMines, () =>
      toMinesSnapshot(runtime?.getMines() ?? [], runtime?.materialTotals())
    )
    handle(IPC_CHANNELS.activateDwarf, (dwarfId) => {
      if (typeof dwarfId !== 'string') return noActivation
      return runtime?.activateDwarf(dwarfId) ?? noActivation
    })
    handle(IPC_CHANNELS.getDwarfFeed, (dwarfId) => {
      if (typeof dwarfId !== 'string') return noFeed
      return runtime?.dwarfFeed(dwarfId) ?? noFeed
    })
    handle(IPC_CHANNELS.getDwarfFeedPage, (payload) => {
      const request = parseDwarfFeedPageRequest(payload)
      if (request === null) return noFeedPage
      return runtime?.dwarfFeedPage(request) ?? noFeedPage
    })
    handle(IPC_CHANNELS.setWatchedDwarf, (payload) => {
      if (payload !== null && typeof payload !== 'string') return
      runtime?.watchDwarfFeed(payload)
    })
    handle(IPC_CHANNELS.refreshDwarfTelemetry, (dwarfId) => {
      if (typeof dwarfId !== 'string') return
      runtime?.refreshDwarfTelemetry(dwarfId)
    })
    const notTuned: DwarfTuningResult = { applied: false, reason: TUNING_NOT_HELD }
    handle(IPC_CHANNELS.setDwarfTuning, (payload) => {
      const request = parseTuningRequest(payload)
      if (request === null) return notTuned
      return runtime?.setDwarfTuning(request) ?? notTuned
    })
    const notRenamed: DwarfNameResult = { saved: false, reason: DWARF_NAME_NOT_ON_BOARD }
    handle(IPC_CHANNELS.setDwarfName, (payload) => {
      const request = parseDwarfNameRequest(payload)
      if (request === null) return notRenamed
      return runtime?.setDwarfName(request) ?? notRenamed
    })
    handle(IPC_CHANNELS.resetDwarfName, (dwarfId) => {
      if (typeof dwarfId !== 'string' || dwarfId === '') return notRenamed
      return runtime?.resetDwarfName(dwarfId) ?? notRenamed
    })
    const noHistory: MineHistoryResult = { readable: false, speakers: [] }
    handle(IPC_CHANNELS.getMineHistory, (mineId) => {
      if (typeof mineId !== 'string' || mineId === '') return noHistory
      return runtime?.mineHistory(mineId) ?? noHistory
    })

    // A click on an activity line's own path (#279, #348): folders only from the runtime's board.
    handle(IPC_CHANNELS.openMinePath, async (payload): Promise<MineOpenPathResult> => {
      const request = parseMineOpenPathRequest(payload)
      const outside: MineOpenPathResult = { opened: false, reason: MINE_PATH_OUTSIDE_REASON }
      if (request === null) return outside
      const mineFolder = runtime?.mineFolderOf(request.mineId, request.dwarfId)
      if (mineFolder === undefined) return outside
      const verdict = await verifyMinePath(
        mineFolder,
        request.target,
        currentPlatform(),
        new NodeFs()
      )
      if (!verdict.opened) return verdict
      const openError = await shell.openPath(verdict.absolutePath)
      if (openError !== '') {
        console.warn(`[shell] could not open a mine file: ${openError}`)
        return { opened: false, reason: MINE_PATH_UNOPENABLE_REASON }
      }
      return { opened: true }
    })

    // A link inside a message bubble (#347): the system browser, never this window.
    handle(IPC_CHANNELS.openExternalLink, async (payload): Promise<ExternalLinkResult> => {
      const refused: ExternalLinkResult = { opened: false, reason: EXTERNAL_LINK_REFUSED_REASON }
      const url = parseExternalLinkRequest(payload)
      if (url === null) return refused
      try {
        await shell.openExternal(url)
      } catch (error) {
        console.warn(`[shell] could not open a link: ${String(error)}`)
        return refused
      }
      return { opened: true }
    })

    // Copy on a message that could not be handed over (#635).
    handle(IPC_CHANNELS.copyText, (payload): CopyTextResult =>
      copyTextToClipboard(payload, clipboard)
    )

    const notDelivered: DwarfTextResult = {
      delivered: false,
      via: 'none',
      error: 'The message could not be delivered.'
    }
    handle(IPC_CHANNELS.sendDwarfText, (payload) => {
      const request = parseTextRequest(payload)
      if (request === null) return notDelivered
      return runtime?.sendDwarfText(request) ?? notDelivered
    })

    handle(IPC_CHANNELS.chooseDwarfAttachments, () => chooseAttachmentFiles(mainWindow))

    handle(IPC_CHANNELS.describeDwarfAttachments, (payload) => {
      if (!Array.isArray(payload)) return []
      const paths = payload.filter(
        (item): item is string => typeof item === 'string' && item !== ''
      )
      if (paths.length !== payload.length) return []
      return describeAttachments(paths.slice(0, MAX_DWARF_ATTACHMENTS), attachmentFiles)
    })

    const notKicked: DwarfKickResult = {
      delivered: false,
      via: 'none',
      error: 'The kick could not be delivered.'
    }
    handle(IPC_CHANNELS.kickDwarf, (payload) => {
      const request = parseKickRequest(payload)
      if (request === null) return notKicked
      return runtime?.kickDwarf(request) ?? notKicked
    })

    const notLaunched: AgentLaunchResult = {
      launched: false,
      provider: 'none',
      error: 'The agent could not be started.'
    }
    handle(IPC_CHANNELS.launchAgent, (payload) => {
      const request = parseLaunchRequest(payload)
      if (request === null) return notLaunched
      return runtime?.launchAgent(request) ?? notLaunched
    })

    const noProviders: AgentProviderList = { providers: [] }
    handle(IPC_CHANNELS.listAgentProviders, () => runtime?.listAgentProviders() ?? noProviders)

    const noModels: AgentModelCatalogList = { catalogs: [] }
    handle(IPC_CHANNELS.listAgentModels, () => runtime?.listAgentModels() ?? noModels)

    const notDeclared: MineDeclareResult = {
      outcome: 'failed',
      reason: 'The panel is still starting up.'
    }
    const notUndeclared: MineUndeclareResult = {
      outcome: 'failed',
      reason: 'The panel is still starting up.'
    }
    handle(IPC_CHANNELS.declareMine, () => runtime?.declareMine() ?? notDeclared)
    handle(IPC_CHANNELS.declareMainProject, () => runtime?.declareMainProject() ?? notDeclared)
    handle(IPC_CHANNELS.undeclareMine, (mineId) => {
      if (typeof mineId !== 'string' || mineId === '') {
        return { outcome: 'unchanged', reason: 'No mine was named.' } satisfies MineUndeclareResult
      }
      return runtime?.undeclareMine(mineId) ?? notUndeclared
    })

    const notReset: MetricsResetResult = {
      outcome: 'failed',
      reason: 'The panel is still starting up.'
    }
    handle(IPC_CHANNELS.resetMetrics, () => runtime?.resetMetrics() ?? notReset)

    const notQueried: ProjectQueryResult = {
      answered: false,
      projects: [],
      reason: 'The panel is still starting up.'
    }
    const notAQuery: ProjectQueryResult = {
      answered: false,
      projects: [],
      reason: 'That is not a search this panel can run.'
    }
    handle(IPC_CHANNELS.queryProjects, (payload) => {
      const query = parseProjectQuery(payload)
      if (query === null) return notAQuery
      return runtime?.queryProjects(query) ?? notQueried
    })

    const notHeldLaunched: HeldSessionLaunchResult = {
      launched: false,
      error: 'The agent could not be started.'
    }
    const notAnswered: DwarfQuestionAnswerResult = {
      answered: false,
      error: 'That answer could not be delivered.'
    }
    handle(IPC_CHANNELS.launchHeldSession, (payload) => {
      const request = parseHeldLaunchRequest(payload)
      if (request === null) return notHeldLaunched
      return runtime?.launchHeldSession(request) ?? notHeldLaunched
    })
    handle(IPC_CHANNELS.answerDwarfQuestion, (payload) => {
      const request = parseAnswerRequest(payload)
      if (request === null) return notAnswered
      return runtime?.answerDwarfQuestion(request) ?? notAnswered
    })
    handle(IPC_CHANNELS.answerDwarfPermission, (payload) => {
      const request = parsePermissionRequest(payload)
      if (request === null) return notAnswered
      return runtime?.answerDwarfPermission(request) ?? notAnswered
    })

    const notHostedLaunched: HostedLaunchResult = {
      launched: false,
      error: 'That command could not be started.'
    }
    handle(IPC_CHANNELS.launchHostedProcess, (payload) => {
      const request = parseHostedLaunchRequest(payload)
      if (request === null) return notHostedLaunched
      return runtime?.launchHostedProcess(request) ?? notHostedLaunched
    })

    handle(IPC_CHANNELS.retireDwarf, (dwarfId) => {
      if (typeof dwarfId !== 'string' || dwarfId === '') return
      runtime?.retireDwarf(dwarfId)
    })

    // Loaded last, after every handler exists (#570).
    loadPanelPage()

    const panelWindow: PanelWindowController = {
      hide: () => hidePanel(),
      show: () => showPanel(),
      toggleVisible: () => togglePanel(),
      setAlwaysOnTop: (on) => {
        const real = applyAlwaysOnTop(mainWindow, on)
        void pinStore.save(real).catch((error: unknown) => {
          console.warn('[pin] Failed to persist the always-on-top preference:', error)
        })
        return real
      },
      layout: () => panelLayout(),
      setLayout: (request) => {
        const result = setPanelLayout(request)
        if (request.edge !== undefined) {
          void panelEdgeStore.save(result.edge).catch((error: unknown) => {
            console.warn('[panel] Failed to persist the position preference:', error)
          })
        }
        return result
      }
    }

    return { handlers, panelWindow }
  }

  return {
    async compose() {
      try {
        return await init()
      } catch (error) {
        console.error('[main] Fatal startup error:', error)
        throw error
      }
    },
    beforeQuit() {
      runtime?.stop()
      runtime = null
      // Releases the ports only: the installed hooks and opt-ins bring the channels back next launch.
      void hooks?.shutdown()
      hooks = null
      void delegationService?.stop()
      delegationService = null
      void openCodePlugin?.shutdown()
      openCodePlugin = null
      void hookListener?.shutdown()
      hookListener = null
      // Drops the store's reference; the shared database is never closed here (see the vault).
      void projects?.close()
      projects = null
      // Today's `removeIpcHandlers()` has no counterpart: nothing here is registered on `ipcMain`.
      markQuitting()
    },
    willQuit() {
      toggleShortcut?.dispose()
      toggleShortcut = null
    }
  }
}
