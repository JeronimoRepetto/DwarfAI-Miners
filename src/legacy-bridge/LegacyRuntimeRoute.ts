import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PanelWindowController } from '../ui-main/window/ports/panelWindowController'
import { createLegacyDiagnostics, type LegacyArea, type LegacyLog } from './legacyDiagnostics'
import { withoutObserverWrites } from './legacyObserverSwitch'
import type {
  AgentModelCatalogList,
  AgentProviderList,
  AppBuild,
  FeatureFlags,
  DwarfFeedPage,
  DwarfFeedResult,
  DwarfTuningRequest,
  DwarfNameResult,
  DwarfTuningResult,
  CopyTextResult,
  ExternalLinkResult,
  MineDeclareResult,
  MineHistoryResult,
  MineOpenPathResult,
  MineUndeclareResult,
  ProjectQuery,
  ProjectQueryResult,
  ProjectSortDirection,
  ProjectSortKey
} from '../shared/contracts'
import {
  IPC_CHANNELS,
  isMineTier,
  parseAudioPreferences,
  parseLaunchView,
  parseTypographyPreferences,
  DWARF_IMAGE_EXTENSIONS,
  MAX_DWARF_ATTACHMENTS
} from '../shared/contracts'
import { describeAttachments, type AttachmentFilePort } from '../main/textDelivery/attachmentFiles'
import type { AttachmentReader } from '../main/textDelivery/attachmentDelivery'
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
import { NodeFs } from '../main/adapters/fsLike'
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
import { nullLedgerStore } from '../main/ledger/ledgerStore'
import { MaterialLedger } from '../main/ledger/materialLedger'
import { openProjectsStore } from '../main/projects/openProjectsStore'
import { createSqliteLaunchedSessionStore } from '../main/sessionLaunch/launchedSessionStore'
import { createSqliteDwarfNameStore } from '../main/dwarfNames/dwarfNameStore'
import { DWARF_NAME_NOT_ON_BOARD, parseDwarfNameRequest } from '../main/dwarfNames/dwarfNames'
import { TUNING_NOT_HELD } from '../main/sessionLaunch/heldSessionRegistry'
import type { ProjectsStore } from '../main/projects/projectsStore'
import { createAudioPreferenceStore } from '../main/shell/audioPreference'
import { createLaunchViewStore } from '../main/shell/launchViewPreference'
import { AgentRuntime, type RuntimeOptions } from '../main/runtime/runtime'
import type { GlobalShortcutLike } from '../main/shell/shortcuts'
import { createTypographyPreferenceStore } from '../main/shell/typographyPreference'

/** Today's handler of one seam A row: the body `src/main/index.ts` registers for that wire name. */
export type LegacyHandler = (payload: unknown) => unknown

/** Today's runtime and its Electron-main collaborators, composed. */
export interface LegacyRuntimeComposition {
  /** Today's handler per wire name (every `ipcMain.handle` and `ipcMain.on` of the legacy root). */
  readonly handlers: ReadonlyMap<string, LegacyHandler>
  /**
   * Today's Panel window behind the window module's port, or `null` when the composition was handed the rebuilt
   * Panel (`LegacyPanelSurface`) because the route table serves the window family `ui-local` (21 §2 cut 0).
   */
  readonly panelWindow: PanelWindowController | null
  // AMENDED for ISSUE-241, the end of cut 4 (was: also today's launched register, for `LegacyEndFirstAdapter`, and
  // today's board, for the production `LegacyRuntimeSurface` that `LegacyAgentRegistryFeed` read): both bridges left
  // the tree, and today's runtime builds its own register again.
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
 * with today's handler, unchanged. AMENDED for ISSUE-241 (was: through cut 4 also the way
 * `LegacyEndFirstAdapter` reached today's launched register, and `LegacyAgentRegistryFeed` today's board): both
 * bridges left the tree at the end of cut 4.
 */
export interface LegacyRuntimeRoute {
  /** Composes the legacy runtime (once) and answers its Panel window, `null` when it composed none. */
  compose(): Promise<PanelWindowController | null>
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
// untouched; it stopped being the app entry with the cut-0 switch (ISSUE-056).
//
// The cut-0 retirement (ISSUE-058; 21 §2 cut 0 "Retired at the end"): after the soak (OQ-71) today's window, tray and
// panel-toggle shortcut are gone from this composition. The Electron root hands over the rebuilt Panel
// (`LegacyPanelSurface`), because the route table serves the window family `ui-local`; today's composition builds no
// window, no tray and no shortcut and registers no window-family handler. Its pushes, its pickers and its
// notification click reach the rebuilt Panel. A rollback of cut 0 is no longer possible: after a retirement only
// forward fixes exist (21 §2.1).
// ---------------------------------------------------------------------------------------------

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
    getPath(name: 'userData'): string
    readonly isPackaged: boolean
    getAppPath(): string
    getVersion(): string
  }
  dialog: {
    showOpenDialog(
      window: unknown,
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

/** The options of today's open dialog that today's composition uses. */
export interface LegacyOpenDialogOptions {
  properties: Array<'openDirectory' | 'openFile' | 'multiSelections'>
}

/**
 * The rebuilt Panel as today's runtime reaches it once the route table serves the window family `ui-local` (21 §2
 * cut 0): the window module owns the window, so today's composition only pushes to it, reads whether it is on
 * screen and shows it, as it did with its own window.
 */
export interface LegacyPanelSurface {
  /** Sends a push of a row still served `legacy` (A-P3, A-P4) to every open window of the app. */
  send(channel: string, payload: unknown): void
  /** Today's open dialog, attached to the Panel window when it is open (A-30, A-31 folder picker, #85). */
  showOpenDialog(
    options: LegacyOpenDialogOptions
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** How today's composition is composed: with its own window, tray and shortcut, or onto the rebuilt Panel. */
export interface LegacyCompositionOptions {
  /** The rebuilt Panel; absent while the route table serves the window family `legacy`. */
  panel?: LegacyPanelSurface
  // AMENDED for ISSUE-241, the end of cut 4 (was: `openCodePlugin`, whether today's OpenCode plugin half was composed,
  // true only while A-53 had no `host` route, ISSUE-235): today's plugin installer and the loopback listener its route
  // shared left the composition, since no route of any release left to compose reaches them.
  /**
   * The UI logger (ADR-026): today's warnings reach it as allowlisted records (legacyDiagnostics.ts) instead of the
   * console, which no file of the new trees writes to (eslint.config.mjs deviation 8).
   */
  log: LegacyLog
}

/** Twice the design's 40px chip, so the preview is sharp on a 2× display (#408). */
const ATTACHMENT_THUMBNAIL_PX = 80

const PROJECT_SORT_KEYS: readonly ProjectSortKey[] = ['addedAt', 'lastOpenedAt']
const PROJECT_SORT_DIRECTIONS: readonly ProjectSortDirection[] = ['asc', 'desc']

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
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

/**
 * The pushes of today's runtime as the route composes them. After the cut-1 retirement (21 §2 cut 1 "Retired at the
 * end"; ISSUE-124, ISSUE-125) a board change reaches nothing: A-P2 was `BoardFacadeAdapter`'s push from the Host board
 * until cut 5 (ISSUE-242 deleted both),
 * and the Host's attention policy is the only way to an OS notification (ADR-018 items 1, 7). AMENDED for ISSUE-239,
 * the 4b deletion (was: a failed launch and a settled send still reached the Panel, A-P3 and A-P4): both rows are
 * retired since the 4b switch (successors B-F19 `launch.failed`, B-F12 `message.delivery`), so nothing reaches it.
 */
export function legacyRuntimePushes(
  _panel: LegacyPanelSurface
): Pick<RuntimeOptions, 'onMinesUpdated'> {
  return {
    onMinesUpdated: () => {}
  }
}

/**
 * Today's composition of the legacy runtime (the body of `init()` in `src/main/index.ts`) and its
 * quit teardown (that file's `before-quit` and `will-quit` handlers).
 */
export function composeLegacyRuntime(
  electron: LegacyElectronMain,
  options: LegacyCompositionOptions
): LegacyRuntimeComposer {
  const { app, nativeImage, shell, clipboard } = electron
  const rebuiltPanel = options.panel
  // Today's warnings, as allowlisted UI log records: the area and the error's code, never the text (ADR-026 item 4).
  const diagnostics = createLegacyDiagnostics(options.log)
  /** The `warn` a port of `area` is handed: its message is dropped, its error's code kept. */
  const warnFrom =
    (area: LegacyArea) =>
    (_message: string, error?: unknown): void =>
      diagnostics.warning(area, error)

  // Today's module-level singletons: the quit teardown reads them, null-safe, at any time.
  let runtime: AgentRuntime | null = null
  let projects: ProjectsStore | null = null

  /** The OS folder picker, owned by the panel window (#85): today's window, or the rebuilt Panel's. */
  async function chooseProjectDirectory(panel: LegacyPanelSurface): Promise<string | null> {
    const result = await panel.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
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
    // The macOS Dock tile, the `.env` file and the candidate login entry are UI main's shell start, run right before
    // this composition (ui-main/window/application/shellStart.ts; ISSUE-243 preparation).

    // Typed config, fails fast before any window exists (#38): env beats file beats defaults.
    const configFile = createConfigFileStore({
      filePath: join(app.getPath('userData'), CONFIG_FILE_NAME),
      onWarn: warnFrom('config')
    })
    const config = loadConfig(withConfigFileFallback(process.env, await configFile.load()))

    // Where the pushes, the pickers and the notification click of today's runtime land: the rebuilt Panel, handed over
    // by the Electron root (21 §2 cut 0). Today's own window is retired (ISSUE-058).
    if (rebuiltPanel === undefined) {
      throw new Error(
        'LegacyRuntimeRoute: the legacy window is retired (ISSUE-058): compose over the rebuilt Panel'
      )
    }
    const panel: LegacyPanelSurface = rebuiltPanel

    const audioStore = createAudioPreferenceStore({
      filePath: join(app.getPath('userData'), 'audio-preferences-v1.json')
    })

    // AMENDED for ISSUE-241, the end of cut 4 (was: today's Jev API key, Jev preference and OpenCode server password
    // stores and its Jev launch router, read only by today's delegation service and OpenCode answer port): no launch of
    // today's runtime is left to delegate from or answer for (21 §2 cut 4b), so none of them is composed.

    // Typography (#370, v2 presets #635): the v1 document is read once to migrate it.
    const typographyStore = createTypographyPreferenceStore({
      filePath: join(app.getPath('userData'), 'typography-preferences-v2.json'),
      legacyFilePath: join(app.getPath('userData'), 'typography-preferences-v1.json')
    })

    // The launch view (#635, PANEL-QUESTIONS 25).
    const launchViewStore = createLaunchViewStore({
      filePath: join(app.getPath('userData'), 'launch-view-v1.json')
    })

    // The app's own database (#93), one handle for its tenants, deliberately never closed on quit.
    const appDatabase = createAppDatabase({
      filePath: join(app.getPath('userData'), APP_DB_FILENAME)
    })

    // Today's material vault over a store that remembers nothing (21 §2 cut 1 "Retired at the end", ISSUE-124): today's
    // runtime needs a ledger, but its tick credits nothing anywhere and the Host ledger is the only writer of ore.
    const ledger = new MaterialLedger({
      store: nullLedgerStore(),
      onError: warnFrom('ledger')
    })
    await ledger.load()

    // Every project the app has been shown (#93, #572): a null store is a state, not a failure.
    const openedProjects = await openProjectsStore({
      database: appDatabase,
      warn: warnFrom('projects')
    })
    // Today's projects store is no longer the board's source (21 §2 cut 1 "Retired at the end", ISSUE-124): what a tick
    // observes is written nowhere, while every read and every person's own act stay.
    projects =
      openedProjects.store === null
        ? null
        : withoutObserverWrites(openedProjects.store, currentPlatform())
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

    // AMENDED for ISSUE-241 (was: today's launched register built here as `LegacyLaunchRegister`, so that
    // `LegacyEndFirstAdapter` could end what it launched first, 21 §3): the adapter left the tree, so today's runtime
    // builds its own register, with the same arguments.
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
      chooseDirectory: () => chooseProjectDirectory(panel),
      readAttachment,
      ...legacyRuntimePushes(panel)
    })
    await runtime.loadDeclared()
    await runtime.restoreLaunchedSessions()
    // Today's poll timer is retired (ISSUE-124). AMENDED for ISSUE-241 (was: `LegacyAgentRegistryFeed`'s cycles were
    // the ticks that kept today's board current): the feed left the tree, so nothing ticks it.
    // AMENDED for ISSUE-241, the end of cut 4 (was: today's MCP delegation loopback service, #511, and the OpenCode
    // plugin's push channel over the shared loopback hook listener, #588, composed until 4a): the Host owns delegation
    // (ADR-013) and the OpenCode plugin channel (ISSUE-229), and no launch of today's runtime is left, so neither is
    // composed or bound.

    // Which build is running (#79), asked of Electron.
    const appBuild: AppBuild = { version: app.getVersion(), packaged: app.isPackaged }
    handle(IPC_CHANNELS.getAppBuild, () => appBuild)

    // The features that ship hidden (#635).
    const featureFlags: FeatureFlags = { guildAreasEnabled: config.guildAreasEnabled }
    handle(IPC_CHANNELS.getFeatureFlags, () => featureFlags)

    const noActivation = { focused: false, openedTerminal: false, feed: [] }
    const noFeed: DwarfFeedResult = { readable: false, messages: [] }
    const noFeedPage: DwarfFeedPage = { readable: false, messages: [], reachedStart: false }
    handle(IPC_CHANNELS.getAudioPreferences, () => audioStore.load())
    handle(IPC_CHANNELS.setAudioPreferences, async (payload) => {
      const preferences = parseAudioPreferences(payload)
      try {
        await audioStore.save(preferences)
      } catch (error) {
        diagnostics.preferenceWriteFailed('audio', error)
      }
      return preferences
    })
    handle(IPC_CHANNELS.getTypographyPreferences, () => typographyStore.load())
    handle(IPC_CHANNELS.setTypographyPreferences, async (payload) => {
      const preferences = parseTypographyPreferences(payload)
      try {
        await typographyStore.save(preferences)
      } catch (error) {
        diagnostics.preferenceWriteFailed('typography', error)
      }
      // No push: A-P6 is `ui-local` and the rebuilt window module sends it (the push went to today's window only).
      return preferences
    })
    handle(IPC_CHANNELS.getLaunchView, () => launchViewStore.load())
    handle(IPC_CHANNELS.setLaunchView, (payload) => {
      void launchViewStore.remember(parseLaunchView(payload))
    })

    // AMENDED for ISSUE-236, the 4a retirement (was: today's handlers of A-42, A-43, A-47…A-55): the Host serves the
    // Settings family since the 4a switch (ISSUE-235), and today's handlers left after the soak.

    // AMENDED for ISSUE-242, cut 5 (was: today's A-12 `getMines`): deleted with `BoardFacadeAdapter`, which served the row
    // from the Host board since the cut-1 switch.
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
        diagnostics.warning('mine-path')
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
        diagnostics.warning('external-link', error)
        return refused
      }
      return { opened: true }
    })

    // Copy on a message that could not be handed over (#635).
    handle(IPC_CHANNELS.copyText, (payload): CopyTextResult =>
      copyTextToClipboard(payload, clipboard)
    )

    // AMENDED for ISSUE-239, the 4b deletion (was: today's A-23 `sendDwarfText` handler): every provider's send is the
    // Host's since the 4b switch.

    handle(IPC_CHANNELS.describeDwarfAttachments, (payload) => {
      if (!Array.isArray(payload)) return []
      const paths = payload.filter(
        (item): item is string => typeof item === 'string' && item !== ''
      )
      if (paths.length !== payload.length) return []
      return describeAttachments(paths.slice(0, MAX_DWARF_ATTACHMENTS), attachmentFiles)
    })

    // AMENDED for ISSUE-239, the 4b deletion (was: today's A-35 `launchAgent` handler): every provider's launch is the
    // Host's since the 4b switch, and today's launcher starts none.

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

    // AMENDED for ISSUE-236 (was: today's A-33 `resetMetrics` handler): the Host saga alone serves it since 4a.

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

    // AMENDED for ISSUE-184, the step-3a deletion (was: also the A-38
    // `launchHeldSession` and A-26 `kickDwarf` handlers, both rows retired in 3a).
    // AMENDED for ISSUE-241, the end of cut 4 (was: today's A-40 `answerDwarfQuestion` and A-41 `answerDwarfPermission`
    // handlers, reached through `LegacyAnswerShapeAdapter` for `LegacyAskRelay`'s `legacy:` AskIds): both rows route
    // only to the Host since the deletion.

    // AMENDED for ISSUE-239, the 4b deletion (was: today's A-27 `retireDwarf` handler): A-27 is retired with no route
    // since the 4b switch (successor B-F10 `dwarf.departed`).

    // The rebuilt window module owns the Panel; today's composition has no window controller to hand over.
    return { handlers, panelWindow: null }
  }

  return {
    // A failed composition rejects; the Electron root records it as `ui.start` with the step and the error's class
    // or code (ADR-026 items 3-4) and exits.
    compose: () => init(),
    beforeQuit() {
      runtime?.stop()
      runtime = null
      // Drops the store's reference; the shared database is never closed here (see the vault).
      void projects?.close()
      projects = null
      // Today's `removeIpcHandlers()` has no counterpart: nothing here is registered on `ipcMain`.
    },
    willQuit() {
      // Today's shortcut is retired with its window (ISSUE-058): the rebuilt window module owns the toggle.
    }
  }
}
