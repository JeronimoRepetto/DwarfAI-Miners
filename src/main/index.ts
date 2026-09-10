import { config as loadDotenv } from 'dotenv'
import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShortcutPlatform } from '../shared/accelerator'
import type {
  AgentLaunchRequest,
  AgentModelCatalogList,
  AgentProviderList,
  AgentLaunchResult,
  AppBuild,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfPermissionAnswerRequest,
  DwarfPermissionDecision,
  DwarfQuestionAnswerRequest,
  DwarfQuestionAnswerResult,
  DwarfTextRequest,
  DwarfTextResult,
  DwarfTuningRequest,
  DwarfTuningResult,
  ExternalLinkResult,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  HostedLaunchRequest,
  HostedLaunchResult,
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
  WatchedFeedPush
} from '../shared/contracts'
import {
  IPC_CHANNELS,
  isDwarfProvider,
  isHeldPermissionMode,
  isMessagePanelDragPhase,
  isMineTier,
  parseAudioPreferences
} from '../shared/contracts'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from './shell/autostart'
import { darwinConsoleInputEnabled, loadConfig } from './config/config'
import {
  CONFIG_FILE_NAME,
  createConfigFileStore,
  withConfigFileFallback
} from './config/configFile'
import { sumTokensObserved } from './domain/aggregate'
import { parseLaunchTuning } from './domain/launchTuning'
import { HookChannel } from './hooks/hookChannel'
import { NodeHookFs } from './hooks/hookFs'
import { NodeFs } from './adapters/fsLike'
import {
  MINE_PATH_OUTSIDE_REASON,
  MINE_PATH_UNOPENABLE_REASON,
  parseMineOpenPathRequest,
  verifyMinePath
} from './shell/openMineFile'
import { EXTERNAL_LINK_REFUSED_REASON, parseExternalLinkRequest } from './shell/openExternalLink'
import { currentPlatform } from './platform/platform'
import { APP_DB_FILENAME, createAppDatabase } from './appDatabase/appDatabase'
import { runCoalBackfill } from './ledger/coalBackfill'
import { LEDGER_JSON_FILENAME } from './ledger/ledgerStore'
import { MaterialLedger } from './ledger/materialLedger'
import { openLedgerStore } from './ledger/openLedgerStore'
import { openProjectsStore } from './projects/openProjectsStore'
import { createSqliteLaunchedSessionStore } from './sessionLaunch/launchedSessionStore'
import { TUNING_NOT_HELD } from './sessionLaunch/heldSessionRegistry'
import type { ProjectsStore } from './projects/projectsStore'
import { createAudioPreferenceStore } from './shell/audioPreference'
import { createMessagePanelPositionStore } from './shell/messagePanelPosition'
import { createPanelEdgePreferenceStore } from './shell/panelEdgePreference'
import { createPinPreferenceStore } from './shell/pinPreference'
import { AgentRuntime, expandHomePath } from './runtime/runtime'
import { createShortcutPreferenceStore } from './shell/shortcutPreference'
import { createToggleShortcut, type ToggleShortcutController } from './shell/shortcuts'
import { createTray } from './shell/tray'
import {
  applyAlwaysOnTop,
  createMainWindow,
  dockMessagePanel,
  dragMessagePanel,
  hidePanel,
  markQuitting,
  messagePanelState,
  messagePanelWebContents,
  mirrorMessagePanelPin,
  panelLayout,
  raiseWindowOf,
  seedMessagePanelPosition,
  seedPanelEdge,
  setMessagePanel,
  setMessagePanelHeight,
  setPanelLayout,
  shellWebContents,
  showPanel,
  togglePanel
} from './shell/window'
import {
  parseDwarfDeliveryReport,
  parseMessagePanelHeight,
  parseMessagePanelState
} from './shell/messagePanelState'

let runtime: AgentRuntime | null = null
let hooks: HookChannel | null = null
/** Held at module scope so the quit handler can close the database handle. */
let projects: ProjectsStore | null = null
/** Held at module scope so the will-quit handler can release the OS claim. */
let toggleShortcut: ToggleShortcutController | null = null

/**
 * Only the distinctions that change a modifier's printed NAME matter to the
 * settings panel (Cmd/Option vs Ctrl/Alt vs Win); everything else is 'other'.
 */
function shortcutPlatform(): ShortcutPlatform {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'other'
}

function removeIpcHandlers(): void {
  ipcMain.removeAllListeners(IPC_CHANNELS.hidePanel)
  ipcMain.removeAllListeners(IPC_CHANNELS.raisePanel)
  ipcMain.removeHandler(IPC_CHANNELS.getAlwaysOnTop)
  ipcMain.removeHandler(IPC_CHANNELS.setAlwaysOnTop)
  ipcMain.removeHandler(IPC_CHANNELS.getPanelLayout)
  ipcMain.removeHandler(IPC_CHANNELS.setPanelLayout)
  ipcMain.removeHandler(IPC_CHANNELS.getMessagePanel)
  ipcMain.removeHandler(IPC_CHANNELS.setMessagePanel)
  ipcMain.removeAllListeners(IPC_CHANNELS.setMessagePanelHeight)
  ipcMain.removeAllListeners(IPC_CHANNELS.dragMessagePanel)
  ipcMain.removeAllListeners(IPC_CHANNELS.dockMessagePanel)
  ipcMain.removeAllListeners(IPC_CHANNELS.reportDwarfDelivery)
  ipcMain.removeHandler(IPC_CHANNELS.getPanelVisible)
  ipcMain.removeHandler(IPC_CHANNELS.getAudioPreferences)
  ipcMain.removeHandler(IPC_CHANNELS.setAudioPreferences)
  ipcMain.removeHandler(IPC_CHANNELS.getToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.setToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.getMines)
  ipcMain.removeHandler(IPC_CHANNELS.activateDwarf)
  ipcMain.removeHandler(IPC_CHANNELS.getDwarfFeed)
  ipcMain.removeAllListeners(IPC_CHANNELS.setWatchedDwarf)
  ipcMain.removeAllListeners(IPC_CHANNELS.refreshDwarfTelemetry)
  ipcMain.removeHandler(IPC_CHANNELS.setDwarfTuning)
  ipcMain.removeHandler(IPC_CHANNELS.getMineHistory)
  ipcMain.removeHandler(IPC_CHANNELS.openMinePath)
  ipcMain.removeHandler(IPC_CHANNELS.openExternalLink)
  ipcMain.removeHandler(IPC_CHANNELS.sendDwarfText)
  ipcMain.removeHandler(IPC_CHANNELS.kickDwarf)
  ipcMain.removeAllListeners(IPC_CHANNELS.retireDwarf)
  ipcMain.removeHandler(IPC_CHANNELS.getAppBuild)
  ipcMain.removeHandler(IPC_CHANNELS.declareMine)
  ipcMain.removeHandler(IPC_CHANNELS.declareMainProject)
  ipcMain.removeHandler(IPC_CHANNELS.undeclareMine)
  ipcMain.removeHandler(IPC_CHANNELS.resetMetrics)
  ipcMain.removeHandler(IPC_CHANNELS.queryProjects)
  ipcMain.removeHandler(IPC_CHANNELS.launchAgent)
  ipcMain.removeHandler(IPC_CHANNELS.listAgentProviders)
  ipcMain.removeHandler(IPC_CHANNELS.listAgentModels)
  ipcMain.removeHandler(IPC_CHANNELS.launchHeldSession)
  ipcMain.removeHandler(IPC_CHANNELS.answerDwarfQuestion)
  ipcMain.removeHandler(IPC_CHANNELS.answerDwarfPermission)
  ipcMain.removeHandler(IPC_CHANNELS.launchHostedProcess)
}

/**
 * The renderer is trusted-but-typed: validate the shape at the boundary so a
 * malformed payload becomes an explained refusal instead of a main-process
 * throw. The message itself is never logged.
 */
function parseTextRequest(payload: unknown): DwarfTextRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.text !== 'string') return null
  return {
    dwarfId: record.dwarfId,
    text: record.text,
    pressEnter: record.pressEnter === true
  }
}

/**
 * Same boundary discipline as parseTextRequest, and the prompt is never logged
 * here either. Note what is NOT accepted: a directory. The renderer names a
 * mine and the runtime decides which folder that is, so this channel cannot be
 * talked into starting a process somewhere the panel is not showing.
 */
function parseLaunchRequest(payload: unknown): AgentLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  // A provider this build does not have takes the whole request down (#168).
  // Not defaulted, for the reason the preload does not default it either: a
  // launch starts a real process, and picking one for a name nobody sent would
  // be starting the wrong agent rather than refusing an unreadable request.
  if (!isDwarfProvider(record.provider)) return null
  // The model and effort this launch asked for (#239), checked against this
  // provider's own boundary rule before either is kept: an absent field
  // degrades to the CLI's own default, and a present-but-unusable one takes
  // the whole request down rather than being silently dropped — see
  // parseLaunchTuning for why.
  const tuning = parseLaunchTuning(record.provider, record)
  if (tuning === null) return null
  return { mineId: record.mineId, provider: record.provider, prompt: record.prompt, ...tuning }
}

/**
 * The same boundary discipline for the one launch channel that names no
 * provider (#194) — and the same refusal of a directory, which matters most
 * here: the program is the caller's own, so the mine must stay the only way to
 * say where it may start.
 *
 * The command is checked for being a string and nothing more. What it means is
 * the runtime's question — `parseHostedCommand` is where a program name, an
 * argv array and a refusal of shell metacharacters are decided, and a second
 * reading here would be a second answer to what will actually run.
 */
function parseHostedLaunchRequest(payload: unknown): HostedLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  if (typeof record.command !== 'string') return null
  return { mineId: record.mineId, command: record.command, prompt: record.prompt }
}

/** Same boundary discipline as parseTextRequest: kick carries no user text at all. */
function parseKickRequest(payload: unknown): DwarfKickRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string') return null
  return { dwarfId: record.dwarfId }
}

/**
 * Same boundary discipline again, over a payload that NAMES AN ACT (issue
 * #96) — the same class of field as `parseProjectQuery`'s `sortBy` and
 * `parsePermissionRequest`'s `decision`, and checked the same way: against
 * the closed set this build recognises, with anything else refused outright
 * rather than resolved to a default.
 *
 * There is no lesser act to fall back to here. Both members change a session
 * that is already running, so a payload whose `kind` this build cannot read
 * must take the whole request down — the preload collapses an unrecognised
 * one to exactly the shape this refuses, so the two ends agree.
 *
 * The VALUE is checked for being a non-empty string and nothing more. Which
 * models exist is the provider's own answer (see AgentModelCatalog) and which
 * efforts a model takes is per-model (ModelOption.effortLevels) — neither is
 * a list this file may hold a second copy of, and the session itself refuses
 * what it does not recognise.
 */
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

/**
 * Same boundary discipline as parseTextRequest, and the prompt is never logged
 * here either. Note what is NOT accepted: a directory. The renderer names a
 * mine and the runtime decides which folder that is, so this channel cannot be
 * talked into starting a process somewhere the panel is not showing.
 */
function parseHeldLaunchRequest(payload: unknown): HeldSessionLaunchRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.mineId !== 'string' || typeof record.prompt !== 'string') return null
  // Same ruling as parseLaunchRequest, and for the same reason (#168): which
  // provider is being held is checked against this build's own list, and the
  // registry then refuses the ones it has no stream for by name.
  if (!isDwarfProvider(record.provider)) return null
  // Same boundary check as parseLaunchRequest, and for the same reason (#239).
  const tuning = parseLaunchTuning(record.provider, record)
  if (tuning === null) return null
  // The permission mode this HELD launch asked for (#239), checked against
  // HELD_PERMISSION_MODES — a list that deliberately has no `bypassPermissions`
  // member, so a request naming it is refused here exactly as an unrecognised
  // mode would be, never carried through as a lesser choice. Held-only: a
  // detached or hosted launch has no `canUseTool` callback for a mode to
  // change the behaviour of, which is why this channel alone checks it.
  if (record.permissionMode !== undefined && !isHeldPermissionMode(record.permissionMode)) {
    return null
  }
  return {
    mineId: record.mineId,
    provider: record.provider,
    prompt: record.prompt,
    ...tuning,
    ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode })
  }
}

/**
 * Same boundary discipline again, plus the one thing no other channel carries:
 * a RECORD of strings.
 *
 * Every key and value is checked here, and an entry that is not a string pair
 * takes the whole answer down rather than being dropped — a partly-read answer
 * is one the panel would be answering differently from how the user did. What
 * the strings MEAN is not judged here: they are matched against the ask the
 * agent actually made, in main, where the ask is (see HeldSessionRegistry). So
 * this refuses a shape and never a choice.
 */
function parseAnswerRequest(payload: unknown): DwarfQuestionAnswerRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.toolUseId !== 'string') return null
  if (typeof record.answers !== 'object' || record.answers === null) return null
  const answers: Record<string, string> = {}
  for (const [question, label] of Object.entries(record.answers as Record<string, unknown>)) {
    if (typeof label !== 'string') return null
    answers[question] = label
  }
  return { dwarfId: record.dwarfId, toolUseId: record.toolUseId, answers }
}

const PERMISSION_DECISIONS: readonly DwarfPermissionDecision[] = ['allow', 'deny']

/**
 * Same boundary discipline as parseAnswerRequest, narrower: a permission
 * decision carries no record to walk, only `decision` itself, which NAMES A
 * VERDICT rather than travelling as a value — so it is checked against the
 * closed list DwarfPermissionDecision allows, the same discipline
 * parseProjectQuery holds for `sortBy` and `direction`. A decision this build
 * does not recognise is refused outright rather than passed on as a guess.
 */
function parsePermissionRequest(payload: unknown): DwarfPermissionAnswerRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.toolUseId !== 'string') return null
  if (!isOneOf(record.decision, PERMISSION_DECISIONS)) return null
  return { dwarfId: record.dwarfId, toolUseId: record.toolUseId, decision: record.decision }
}

const PROJECT_SORT_KEYS: readonly ProjectSortKey[] = ['addedAt', 'lastOpenedAt']
const PROJECT_SORT_DIRECTIONS: readonly ProjectSortDirection[] = ['asc', 'desc']

/**
 * Same boundary discipline as parseTextRequest, with one thing the other
 * channels never had to check: two of these fields NAME PARTS OF A STATEMENT
 * rather than travelling as values.
 *
 * `sortBy` and `direction` become a column and a keyword in the ORDER BY, so
 * both are checked against a closed list here and a payload naming anything
 * else is refused outright — a sort key that fell through would reach SQLite as
 * a column that does not exist. Everything else IS a value and is bound as a
 * parameter downstream, `nameContains` above all: the user's search term is
 * never inspected here beyond its type, and never concatenated anywhere.
 *
 * The two numbers are only checked for being numbers. Their policy — a default,
 * a cap, a floor — belongs to the query builder, so that main's own callers get
 * it too rather than only the ones that came over the wire.
 */
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
    // An unrecognised tier is dropped rather than refused: it means "no tier
    // filter", which is a browse that shows everything instead of an error.
    ...(isMineTier(record.tier) ? { tier: record.tier } : {}),
    ...(typeof record.nameContains === 'string' ? { nameContains: record.nameContains } : {}),
    ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
    ...(typeof record.offset === 'number' ? { offset: record.offset } : {})
  }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * Open the operating system's folder picker (#85) — the first use of Electron's
 * `dialog` anywhere in this app.
 *
 * Owned by the panel window so it comes up in front of an always-on-top panel
 * rather than behind it, and so the two cannot be interacted with at once. The
 * renderer never reaches this: it asks on `mine:declare`, and the path exists
 * only inside main.
 */
async function chooseProjectDirectory(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/**
 * Wraps a mines list with its vault totals for both getMines() and the push.
 *
 * The two numbers answer different questions and both travel: tokensObserved
 * is the LIVE gauge over the crews visible this instant, while `materials` is
 * the cumulative, persisted vault — which is why it is passed in rather than
 * derived from `mines`. Summing the mines would silently drop every project
 * with no dwarf running right now, and that is exactly where backfilled coal
 * lives.
 */
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

/**
 * Every window of this app whose page is still alive (#162).
 *
 * Two surfaces now share one poll and one set of pushes, and both can be gone
 * — the panel window does not exist until a panel is first opened, and either
 * page can be mid-teardown on quit. A push to a destroyed webContents throws,
 * so the check is here once rather than at each of the four call sites.
 */
function appWebContents(): WebContents[] {
  return [shellWebContents(), messagePanelWebContents()].filter(
    (contents): contents is WebContents => contents !== null
  )
}

async function init(): Promise<void> {
  app.setAppUserModelId('com.jeronimorepetto.dwarfaiminers')

  // DwarfAI-Miners lives in the tray/menu bar and its only window is a hidden
  // floating panel, so it has no business owning a Dock tile. `app.dock` only
  // exists on macOS; every other platform leaves this untouched.
  app.dock?.hide()

  // Typed config, fails fast on invalid values before any window exists.
  //
  // Two transports feed one parser (see #38). dotenv reads a repo `.env`
  // relative to process.cwd(), which only ever resolves in a development
  // checkout; an installed app is configured through the userData file below.
  // Environment beats file beats defaults, so a dev checkout keeps behaving
  // exactly as it did before this file existed.
  loadDotenv({ quiet: true })
  // The store also writes, so a settings surface can eventually persist
  // changes through this same path instead of inventing a second mechanism.
  const configFile = createConfigFileStore({
    filePath: join(app.getPath('userData'), CONFIG_FILE_NAME),
    onWarn: (message) => console.warn(message)
  })
  const config = loadConfig(withConfigFileFallback(process.env, await configFile.load()))
  console.log('[main] Config loaded:', config)

  // One-time rename migration, before the marker-gated first-run default below.
  await migrateLegacyAutostart(app.isPackaged)

  // userData follows productName (AgentName -> DwarfAI-Miners), so this path
  // moved with the rename. Nothing had been written under the old name beyond
  // this first-run marker, so the rename needed no data migration.
  await ensureDefaultAutostart({
    isPackaged: app.isPackaged,
    markerPath: join(app.getPath('userData'), 'autostart-default-v1.marker'),
    enable: enableAutostart,
    warn: (message, error) => console.warn(message, error)
  })

  // The pin ("always on top") preference lives next to the autostart marker
  // in userData (see #35). It is loaded before the window exists so the very
  // first frame already has the right stacking, with pinned as the default.
  const pinStore = createPinPreferenceStore({
    filePath: join(app.getPath('userData'), 'pin-preference-v1.json')
  })

  // The Settings position preference (#138) is the fourth userData
  // preference, read before the window exists for the same reason the pin
  // preference is: the very first frame should already open on the user's
  // chosen edge rather than always starting 'right' and jumping the moment
  // the renderer syncs.
  const panelEdgeStore = createPanelEdgePreferenceStore({
    filePath: join(app.getPath('userData'), 'panel-edge-v1.json')
  })
  seedPanelEdge(await panelEdgeStore.load())

  // Where the person left the message panel (#296) — the fifth userData
  // marker, read before any window exists for the reason the edge preference
  // is: a panel that had been dragged somewhere should open there rather than
  // dock beside the shell and jump on the first apply. A missing or corrupt
  // file reads as "never moved", which is the docked placement.
  const messagePanelPositionStore = createMessagePanelPositionStore({
    filePath: join(app.getPath('userData'), 'message-panel-position-v1.json')
  })
  seedMessagePanelPosition(await messagePanelPositionStore.load())

  const mainWindow = createMainWindow({ alwaysOnTop: await pinStore.load() }) // starts hidden

  // Settings' Audio section (#174, #173) is the sixth userData preference.
  // Read AFTER the window exists, unlike the pin and the edge: nothing about
  // the first frame depends on it — the renderer asks for it on mount and
  // starts the music itself — so there is no reason to make startup wait.
  const audioStore = createAudioPreferenceStore({
    filePath: join(app.getPath('userData'), 'audio-preferences-v1.json')
  })

  /*
   * Whether the shell is really on screen (#174, #173).
   *
   * `isVisible()` alone is not the answer on every platform: a minimised
   * window reports differently on Windows and macOS, and the renderer's rule
   * is "every sound stops while the app is not on screen" — which minimised
   * plainly is not. Both are asked, and main is the one process that can.
   */
  const panelVisible = (): boolean => mainWindow.isVisible() && !mainWindow.isMinimized()
  const publishPanelVisibility = (): void => {
    shellWebContents()?.send(IPC_CHANNELS.panelVisibilityChanged, panelVisible())
  }
  // Subscribed to the window rather than to `showPanel`/`hidePanel`, so the
  // ways round those two — a minimise from the OS, the tray, a shortcut, the
  // app mark — all reach the renderer through one path.
  mainWindow.on('show', publishPanelVisibility)
  mainWindow.on('hide', publishPanelVisibility)
  mainWindow.on('minimize', publishPanelVisibility)
  mainWindow.on('restore', publishPanelVisibility)

  // The panel-toggle shortcut is the third userData preference (see #17), read
  // here so the accelerator is in hand before anything is claimed from the OS.
  // A missing or unusable file yields the documented Ctrl+Alt+Shift+P default.
  const shortcutStore = createShortcutPreferenceStore({
    filePath: join(app.getPath('userData'), 'shortcut-preference-v1.json')
  })
  const storedAccelerator = await shortcutStore.load()

  // The app's own database, and the only one it writes (#93). Both tenants —
  // the material vault and the projects list — share this ONE handle, because
  // two handles on one file take turns at SQLITE_BUSY rather than sharing a
  // write queue. The path is injected for the same reason the ledger's always
  // was: neither store imports Electron.
  //
  // Deliberately never closed on quit. The last thing the app does is force the
  // ledger's final save past its throttle without awaiting it (runtime.ts:446),
  // so closing the handle in the same tick would drop the last poll's ore. WAL
  // means an unclosed handle costs nothing: every write is already committed.
  const appDatabase = createAppDatabase({
    filePath: join(app.getPath('userData'), APP_DB_FILENAME)
  })

  // The cumulative material vault (see #22), loaded before the runtime exists
  // so the very first published poll already carries real totals instead of
  // briefly showing an empty vault.
  //
  // Which backing it gets is decided once, here: the database normally, the
  // JSON document while the migration has not happened and could not, and
  // nothing at all when neither can be trusted. That last case is the honest
  // answer to an unanswerable question rather than a bug — openLedgerStore
  // carries the reasoning and states the outcome in the log either way.
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

  // Every project the app has been shown (#93), the other tenant of that file.
  //
  // A null here is a state, not a failure to handle later. The store refuses
  // loudly by design — a locked or corrupt database answers with a reason
  // instead of an empty list — and this is the one place that can turn that
  // refusal into a panel missing its declared mines rather than an app that
  // will not start. openProjectsStore logs the reason once.
  projects = await openProjectsStore({
    database: appDatabase,
    warn: (message) => console.warn(message)
  })

  // What this app launched, kept so a session started before the last restart
  // still has an exit (#231). The third tenant of that same file, and the one
  // whose rows describe something outside it — see the schema comment on why a
  // pid is never enough on its own.
  //
  // Null on the same terms as `projects`: a database that will not open costs
  // the exit from a PREVIOUS run's session and nothing else, because the
  // in-memory register #217 added is unaffected.
  const launchedSessionStore =
    projects === null ? null : createSqliteLaunchedSessionStore({ database: appDatabase })

  runtime = new AgentRuntime({
    config,
    ledger,
    projects,
    launchedSessionStore,
    appPaths: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    },
    // The system clipboard the Windows paste path saves, sets and restores
    // (#319). Composed here at the one place Electron is imported — the runtime
    // and the platform adapters never import it — and passed straight through.
    // This Electron's clipboard is promise-based (readText/writeText return
    // promises); ClipboardPort accepts that, and pasteToConsole awaits it.
    clipboard: {
      read: () => clipboard.readText(),
      write: (value: string) => clipboard.writeText(value)
    },
    chooseDirectory: () => chooseProjectDirectory(mainWindow),
    // Passed only when the variable is set (#367): unset leaves the shipped
    // constant in charge rather than pinning it to false from here.
    ...(darwinConsoleInputEnabled() ? { darwinConsoleInput: true } : {}),
    onMinesUpdated: (mines: Mine[], materials: MaterialTotals, watchedFeed?: WatchedFeedPush) => {
      // Both windows (#162). The panel window reads the board for the same
      // reasons the shell does — the open dwarf's own status and words, the
      // proof a session reacted to a delivery, and the arrival of a dwarf a
      // launch is waiting for — so one poll feeds two surfaces rather than
      // the panel asking main for a snapshot main just published.
      const snapshot = toMinesSnapshot(mines, materials, watchedFeed)
      for (const contents of appWebContents()) {
        contents.send(IPC_CHANNELS.minesUpdated, snapshot)
      }
    },
    // #263. Both windows, for the same reason `onMinesUpdated` reaches both:
    // the Add Panel that made the launch lives in whichever window opened it,
    // and main does not track which one that was.
    onLaunchFailed: (push: LaunchFailedPush) => {
      for (const contents of appWebContents()) {
        contents.send(IPC_CHANNELS.launchFailed, push)
      }
    }
  })
  // Before the loop starts, exactly as the ledger is loaded before the runtime
  // exists: the first published poll then already carries the user's own mines
  // instead of drawing an empty valley and filling it a moment later.
  await runtime.loadDeclared()
  // Before start(), and before anything in this run can be launched: a restored
  // launch and a new one must never be handed the same id (#231).
  await runtime.restoreLaunchedSessions()
  runtime.start()

  // The historical coal pile, produced once and never again (see #22).
  //
  // Deliberately NOT awaited: it reads through transcript trees that can be
  // very large, and startup must not wait on history. It is internally bounded
  // and resumable, so a launch that runs out of budget simply continues on the
  // next one, and its credits reach the panel through the next ordinary poll.
  void runCoalBackfill({
    fs: new NodeFs(),
    markerFs: { readFile, writeFile, rename },
    markerPath: join(app.getPath('userData'), 'coal-backfill-v1.json'),
    claudeRoots: config.providers.claude.configDirs.map((path) => expandHomePath(path)),
    codexSessionsRoot: expandHomePath(config.providers.codex.sessionsRoot),
    credit: (mineId, tokens) => ledger.creditCoal(mineId, tokens),
    now: Date.now,
    warn: (message, error) => console.warn(message, error)
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

  // Optional push channel. Nothing binds a port and nothing is written to the
  // user's Claude configuration until they tick the tray item; restore() only
  // brings back a choice they already made on a previous launch.
  hooks = new HookChannel({
    fs: new NodeHookFs(),
    roots: config.providers.claude.configDirs.map((path) => expandHomePath(path)),
    userDataDir: app.getPath('userData'),
    port: config.hooksPort,
    platform: process.platform,
    onEvent: (event) => {
      // The notification type is the whole point of reading it (issue #94):
      // 'agent_needs_input' and 'idle_prompt' arrive as the same event name and
      // mean opposite things, and the log is where that first becomes visible.
      const kind = event.notificationType === undefined ? '' : ` (${event.notificationType})`
      console.log(
        `[hooks] ${event.event}${kind}${event.cwd === undefined ? '' : ` in ${event.cwd}`}`
      )
      // Recorded before the rescan is asked for, so the poll it triggers is
      // already the one that draws the mark (#203). What the runtime does with
      // an event is its own business: this boundary reads the payload and
      // hands it over whole.
      runtime?.noteHookEvent(event)
      runtime?.nudge()
    },
    log: (message) => console.log(message),
    warn: (message, error) => console.warn(message, error)
  })
  await hooks.restore()

  await createTray({ hooks })

  // Claim the shortcut. A refusal is no longer just a console warning: the
  // failure lives in the state the settings panel reads, so the user can see
  // which combination is unavailable and record a different one.
  const toggle = createToggleShortcut({
    initial: storedAccelerator,
    onToggle: togglePanel,
    globalShortcut,
    platform: shortcutPlatform()
  })
  toggleShortcut = toggle
  const startupState = toggle.start()
  if (startupState.error !== undefined) console.warn(`[shortcuts] ${startupState.error}`)

  // Which build is running (#79). Asked of Electron rather than answered from
  // anything this repo compiles in, so the panel's number is the executable's
  // number by construction instead of by coincidence.
  //
  // One trap, measured rather than assumed: getVersion() falls back to
  // ELECTRON's own version, silently, when the app's package.json carries no
  // `version` field. Never let that field go missing — the fallback is a
  // plausible-looking number that answers a different question.
  const appBuild: AppBuild = { version: app.getVersion(), packaged: app.isPackaged }
  ipcMain.handle(IPC_CHANNELS.getAppBuild, () => appBuild)

  const noActivation = { focused: false, openedTerminal: false, feed: [] }
  /** A dwarf this process cannot read at all — never "it has said nothing". */
  const noFeed: DwarfFeedResult = { readable: false, messages: [] }
  ipcMain.on(IPC_CHANNELS.hidePanel, () => hidePanel())
  // The shell reports every click on itself, because a frameless transparent
  // window is not reliably raised by the platform's own click-to-front (#165).
  // Answers for the SENDER rather than always for the shell (#162): the panel
  // is the same frameless transparent window and needs the same help, and a
  // press on it that raised the shell instead would leave the surface being
  // typed into exactly where it was.
  ipcMain.on(IPC_CHANNELS.raisePanel, (event) => raiseWindowOf(event.sender))
  ipcMain.handle(IPC_CHANNELS.getAlwaysOnTop, () => mainWindow.isAlwaysOnTop())
  ipcMain.handle(IPC_CHANNELS.setAlwaysOnTop, async (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing
    // and the caller still gets the real state back.
    if (typeof payload !== 'boolean') return mainWindow.isAlwaysOnTop()
    const real = applyAlwaysOnTop(mainWindow, payload)
    // One surface in two windows, one answer about its stacking (#162): the
    // panel mirrors what the SHELL actually became, never the request.
    mirrorMessagePanelPin(real)
    try {
      // Persist what the window actually is, not the request — a declined
      // change must not resurrect itself as a stored preference.
      await pinStore.save(real)
    } catch (error) {
      // The toggle itself already happened; a persistence hiccup only means
      // the next launch falls back to whatever the file still says.
      console.warn('[pin] Failed to persist the always-on-top preference:', error)
    }
    return real
  })
  /*
   * Whether the shell is on screen (#174, #173) — pulled once on the page's
   * own mount, which is the moment no push can reach because the window is
   * still hidden while its page loads.
   */
  ipcMain.handle(IPC_CHANNELS.getPanelVisible, () => panelVisible())
  /*
   * Settings' Audio section (#174, over #173's two volumes).
   *
   * `set` answers with what was STORED rather than with the request, which is
   * the discipline every other preference channel here holds: the shared
   * parser clamps each volume into 0..1 and falls back field by field, so a
   * slider can only ever be drawn at a value that is really in force.
   */
  ipcMain.handle(IPC_CHANNELS.getAudioPreferences, () => audioStore.load())
  ipcMain.handle(IPC_CHANNELS.setAudioPreferences, async (_event, payload: unknown) => {
    const preferences = parseAudioPreferences(payload)
    try {
      await audioStore.save(preferences)
    } catch (error) {
      // The change itself already took effect in the renderer; a persistence
      // hiccup only means the next launch falls back to the stored document.
      console.warn('[audio] Failed to persist the audio preferences:', error)
    }
    return preferences
  })
  // The docked shell's own shape (#90). Both channels answer with what the
  // window IS after the move, never the request: main derives the rectangle
  // from the display, so a screen that could not hold the whole composition has
  // to reach the renderer as a fact.
  ipcMain.handle(IPC_CHANNELS.getPanelLayout, () => panelLayout())
  ipcMain.handle(IPC_CHANNELS.setPanelLayout, async (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload moves nothing and
    // the caller still gets the real layout back.
    if (typeof payload !== 'object' || payload === null) return panelLayout()
    const { expanded, mineOpen, edge } = payload as Record<string, unknown>
    if (typeof expanded !== 'boolean' || typeof mineOpen !== 'boolean') return panelLayout()
    // edge is optional (#138): only the Settings position control ever sends
    // one, and an unrecognised value is treated exactly like an absent one —
    // the rail toggle and the mine-open resize must never nudge the docked
    // side by accident.
    const requestedEdge: PanelEdge | undefined =
      edge === 'left' || edge === 'right' ? edge : undefined
    const result = setPanelLayout({
      expanded,
      mineOpen,
      ...(requestedEdge ? { edge: requestedEdge } : {})
    })
    if (requestedEdge !== undefined) {
      try {
        // Persist what the window actually ended up on, not the request —
        // same discipline as the pin preference just above.
        await panelEdgeStore.save(result.edge)
      } catch (error) {
        console.warn('[panel] Failed to persist the position preference:', error)
      }
    }
    return result
  })
  /*
   * The message panel's own window (#162).
   *
   * `setMessagePanel` answers with what main STORED, for the reason the layout
   * channels do: a real BrowserWindow is created, moved, shown or hidden off
   * the back of it, and the caller must render the fact. Both windows may send
   * it — the shell opens the panel on a dwarf or on the mine's Add action, the
   * panel closes itself and adopts the dwarf a launch produced — so the window
   * that did NOT ask is told, and neither renderer ever polls state it does
   * not own. `getMessagePanel` exists for the one moment a push cannot reach:
   * the panel window's own first mount, when the state that opened it was set
   * before its page existed.
   */
  ipcMain.handle(IPC_CHANNELS.getMessagePanel, () => messagePanelState())
  ipcMain.handle(IPC_CHANNELS.setMessagePanel, (event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload opens nothing and
    // the caller still gets the real state back. See parseMessagePanelState
    // for the one refusal that is not about types — a surface has to be ABOUT
    // something, and a message panel open on nobody is not a narrower request.
    const request = parseMessagePanelState(payload)
    if (request === null) return messagePanelState()
    const applied = setMessagePanel(request)
    for (const contents of appWebContents()) {
      if (contents !== event.sender) contents.send(IPC_CHANNELS.messagePanelChanged, applied)
    }
    return applied
  })
  // The design's vertical-only resize reaching the window that has to carry it
  // (#162): the renderer measures its own surface in DESIGN pixels and main
  // multiplies by the same uiScale every other dimension goes through. One-way
  // — there is no verdict, and the first report is also what reveals a window
  // deliberately created hidden.
  ipcMain.on(IPC_CHANNELS.setMessagePanelHeight, (_event, payload: unknown) => {
    const height = parseMessagePanelHeight(payload)
    if (height === null) return
    setMessagePanelHeight(height)
  })
  /*
   * The panel window being dragged anywhere, and snapped back (#296).
   *
   * Both are one-way for the reason the height report is, and a stronger one:
   * neither page draws the panel's position, so there is no verdict to answer
   * with. What comes back from main is for THIS process to persist — the
   * position the window actually ended up at, never the gesture that asked for
   * it, which is the same discipline the pin and the edge preference hold.
   */
  ipcMain.on(IPC_CHANNELS.dragMessagePanel, (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a phase main cannot read moves
    // nothing. There is no safe default — see isMessagePanelDragPhase.
    if (!isMessagePanelDragPhase(payload)) return
    const anchor = dragMessagePanel(payload)
    // Persisted once per gesture rather than once per frame: 'start' answers
    // with the position that was already stored, and only the release can have
    // produced a new one.
    if (payload !== 'end') return
    void messagePanelPositionStore.save(anchor).catch((error: unknown) => {
      console.warn('[panel] Failed to persist the message panel position:', error)
    })
  })
  ipcMain.on(IPC_CHANNELS.dockMessagePanel, () => {
    void messagePanelPositionStore.save(dockMessagePanel()).catch((error: unknown) => {
      console.warn('[panel] Failed to forget the message panel position:', error)
    })
  })
  // The delivery verdicts the panel window is the only writer of, relayed to
  // the shell so the mine can draw its markers (#162, see DwarfDeliveryReport).
  // Relayed rather than held: the stores expire their own entries, so main
  // keeping a copy would mean main deciding when a marker is stale.
  ipcMain.on(IPC_CHANNELS.reportDwarfDelivery, (event, payload: unknown) => {
    const report = parseDwarfDeliveryReport(payload)
    if (report === null) return
    for (const contents of appWebContents()) {
      if (contents !== event.sender) contents.send(IPC_CHANNELS.dwarfDeliveryReported, report)
    }
  })
  ipcMain.handle(IPC_CHANNELS.getToggleShortcut, () => toggle.state())
  ipcMain.handle(IPC_CHANNELS.setToggleShortcut, async (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing
    // and the caller still gets the real state back.
    if (typeof payload !== 'string') return toggle.state()
    const state = toggle.apply(payload)
    try {
      // Persist the VERDICT, not the request: a combination another
      // application owns was reverted, and must not resurrect itself on the
      // next launch as a shortcut that never worked.
      await shortcutStore.save(state.accelerator)
    } catch (error) {
      // The re-binding itself already happened; a persistence hiccup only
      // means the next launch falls back to whatever the file still says.
      console.warn('[shortcuts] Failed to persist the panel-toggle shortcut:', error)
    }
    return state
  })
  ipcMain.handle(IPC_CHANNELS.getMines, () =>
    toMinesSnapshot(runtime?.getMines() ?? [], runtime?.materialTotals())
  )
  ipcMain.handle(IPC_CHANNELS.activateDwarf, (_event, dwarfId: unknown) => {
    if (typeof dwarfId !== 'string') return noActivation
    return runtime?.activateDwarf(dwarfId) ?? noActivation
  })
  ipcMain.handle(IPC_CHANNELS.getDwarfFeed, (_event, dwarfId: unknown) => {
    if (typeof dwarfId !== 'string') return noFeed
    return runtime?.dwarfFeed(dwarfId) ?? noFeed
  })
  // The renderer reporting which observed dwarf its message panel has open,
  // or that none is (#196). Boundary is string-or-null, unlike every other id
  // here: null is itself a real answer ("nobody is watched") rather than a
  // malformed payload collapsed to ''. Anything else is refused outright —
  // main's watch state changes only from a value this boundary could prove.
  ipcMain.on(IPC_CHANNELS.setWatchedDwarf, (_event, payload: unknown) => {
    if (payload !== null && typeof payload !== 'string') return
    runtime?.watchDwarfFeed(payload)
  })
  // The mine asking a held session for its own context reading (issue #96).
  // One-way, like setWatchedDwarf: main's own boundary check only ever
  // reasons about a string, and a malformed payload is refused outright
  // rather than coerced — the reading itself rides the next ordinary poll.
  ipcMain.on(IPC_CHANNELS.refreshDwarfTelemetry, (_event, dwarfId: unknown) => {
    if (typeof dwarfId !== 'string') return
    runtime?.refreshDwarfTelemetry(dwarfId)
  })
  // Changing a held session's own model or effort (issue #96) — the mutating
  // half of the surface above, and request/response for the reason the
  // channel's own doc comment gives: the strip has to render the refusal.
  // A payload this boundary cannot read is refused with the same words the
  // registry uses for a session it does not hold, because from the panel's
  // side those are the same fact: nothing was changed and nothing will be.
  const notTuned: DwarfTuningResult = { applied: false, reason: TUNING_NOT_HELD }
  ipcMain.handle(IPC_CHANNELS.setDwarfTuning, (_event, payload: unknown) => {
    const request = parseTuningRequest(payload)
    if (request === null) return notTuned
    return runtime?.setDwarfTuning(request) ?? notTuned
  })
  // A mine this process could not read history for (#192) — never "nobody has
  // spoken here", which is what an empty list with `readable: true` would say.
  const noHistory: MineHistoryResult = { readable: false, speakers: [] }
  ipcMain.handle(IPC_CHANNELS.getMineHistory, (_event, mineId: unknown) => {
    if (typeof mineId !== 'string' || mineId === '') return noHistory
    return runtime?.mineHistory(mineId) ?? noHistory
  })

  // A click on an activity line's own path (#279). The mine id resolves to a
  // folder ONLY through the runtime's own board — never a folder the
  // renderer could name itself — and the refusal, when there is one, is
  // always this app's own fixed sentence: verifyMinePath never returns the
  // filesystem's wording, and shell.openPath's own error string is swallowed
  // below for the same reason.
  ipcMain.handle(
    IPC_CHANNELS.openMinePath,
    async (_event, payload: unknown): Promise<MineOpenPathResult> => {
      const request = parseMineOpenPathRequest(payload)
      const outside: MineOpenPathResult = { opened: false, reason: MINE_PATH_OUTSIDE_REASON }
      if (request === null) return outside
      // The dwarf's own worktree when the click named one (#348), the mine's
      // folder otherwise — resolved inside the runtime against the board, so
      // this boundary still never takes a folder from the renderer.
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
    }
  )

  // A press on a link inside a message bubble (#347). Opened in the SYSTEM
  // browser and never inside the app: `shell.openExternal` hands the address to
  // whatever the machine registered, and this window is never navigated.
  //
  // The renderer already refused anything that is not `http:`/`https:` before
  // drawing the link at all, and the SAME rule runs again here — a renderer's
  // word is never a permission, and this channel is reachable by anything
  // holding the bridge. The one refusal is this app's own sentence, and
  // openExternal's own error is swallowed for the reason openMinePath's is.
  ipcMain.handle(
    IPC_CHANNELS.openExternalLink,
    async (_event, payload: unknown): Promise<ExternalLinkResult> => {
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
    }
  )

  const notDelivered: DwarfTextResult = {
    delivered: false,
    via: 'none',
    error: 'The message could not be delivered.'
  }
  ipcMain.handle(IPC_CHANNELS.sendDwarfText, (_event, payload: unknown) => {
    const request = parseTextRequest(payload)
    if (request === null) return notDelivered
    return runtime?.sendDwarfText(request) ?? notDelivered
  })

  const notKicked: DwarfKickResult = {
    delivered: false,
    via: 'none',
    error: 'The kick could not be delivered.'
  }
  ipcMain.handle(IPC_CHANNELS.kickDwarf, (_event, payload: unknown) => {
    const request = parseKickRequest(payload)
    if (request === null) return notKicked
    return runtime?.kickDwarf(request) ?? notKicked
  })

  const notLaunched: AgentLaunchResult = {
    launched: false,
    provider: 'none',
    error: 'The agent could not be started.'
  }
  ipcMain.handle(IPC_CHANNELS.launchAgent, (_event, payload: unknown) => {
    const request = parseLaunchRequest(payload)
    if (request === null) return notLaunched
    return runtime?.launchAgent(request) ?? notLaunched
  })

  // Which providers the Add Panel may offer (#86). No payload to validate: the
  // question is about this machine. A runtime that never came up answers with
  // an empty list rather than a guess — the panel then shows Other alone,
  // which is exactly what "nothing was detected" looks like.
  const noProviders: AgentProviderList = { providers: [] }
  ipcMain.handle(
    IPC_CHANNELS.listAgentProviders,
    () => runtime?.listAgentProviders() ?? noProviders
  )

  // What each provider can start ON, live (#239) — the same reasoning as
  // listAgentProviders' comment above, applied to a model list instead of a
  // CLI. No payload to validate, and a runtime that never came up answers
  // with an empty list rather than a guess.
  const noModels: AgentModelCatalogList = { catalogs: [] }
  ipcMain.handle(IPC_CHANNELS.listAgentModels, () => runtime?.listAgentModels() ?? noModels)

  // Adding a mine and removing one (#85, #169). declare takes no payload: the
  // folder picker runs here, so there is no path for the renderer to send and
  // none to validate. Both refusals below are what a runtime that never came up
  // would say, phrased for the panel rather than left silent.
  //
  // `undeclare` is the one removal channel and removes any mine the store
  // holds, declared or discovered, logically rather than physically — see
  // MineUndeclareResult. Nothing about the boundary changed with #169: the same
  // id, the same validation, the same refusal for a payload that is not one.
  const notDeclared: MineDeclareResult = {
    outcome: 'failed',
    reason: 'The panel is still starting up.'
  }
  const notUndeclared: MineUndeclareResult = {
    outcome: 'failed',
    reason: 'The panel is still starting up.'
  }
  ipcMain.handle(IPC_CHANNELS.declareMine, () => runtime?.declareMine() ?? notDeclared)
  // The answer to declare s worktree question (#348), and payloadless for the
  // same reason declare is: main remembers which project it resolved for the
  // folder it opened the picker for, so the renderer confirms rather than names.
  ipcMain.handle(
    IPC_CHANNELS.declareMainProject,
    () => runtime?.declareMainProject() ?? notDeclared
  )
  ipcMain.handle(IPC_CHANNELS.undeclareMine, (_event, mineId: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing,
    // and says so rather than resolving as a removal that never happened.
    if (typeof mineId !== 'string' || mineId === '') {
      return { outcome: 'unchanged', reason: 'No mine was named.' } satisfies MineUndeclareResult
    }
    return runtime?.undeclareMine(mineId) ?? notUndeclared
  })

  // Settings' "Reset metrics" action (#138). No payload: the typed
  // confirmation is validated entirely in the renderer, so this channel only
  // ever carries an already-confirmed intent. See MetricsResetResult and
  // AgentRuntime.resetMetrics for exactly what this does and does not wipe.
  const notReset: MetricsResetResult = {
    outcome: 'failed',
    reason: 'The panel is still starting up.'
  }
  ipcMain.handle(IPC_CHANNELS.resetMetrics, () => runtime?.resetMetrics() ?? notReset)

  // Browsing every remembered project (#92). Both refusals answer with an
  // EMPTY list and `answered: false` rather than no list at all, so the panel
  // renders one way and still cannot read "nothing to show" as "no projects".
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
  ipcMain.handle(IPC_CHANNELS.queryProjects, (_event, payload: unknown) => {
    const query = parseProjectQuery(payload)
    if (query === null) return notAQuery
    return runtime?.queryProjects(query) ?? notQueried
  })

  // Starting a session the panel holds, and answering what it asks (#86, #94).
  // Both refusals below are what a runtime that never came up would say,
  // phrased for the panel rather than left silent.
  const notHeldLaunched: HeldSessionLaunchResult = {
    launched: false,
    error: 'The agent could not be started.'
  }
  const notAnswered: DwarfQuestionAnswerResult = {
    answered: false,
    error: 'That answer could not be delivered.'
  }
  ipcMain.handle(IPC_CHANNELS.launchHeldSession, (_event, payload: unknown) => {
    const request = parseHeldLaunchRequest(payload)
    if (request === null) return notHeldLaunched
    return runtime?.launchHeldSession(request) ?? notHeldLaunched
  })
  ipcMain.handle(IPC_CHANNELS.answerDwarfQuestion, (_event, payload: unknown) => {
    const request = parseAnswerRequest(payload)
    if (request === null) return notAnswered
    return runtime?.answerDwarfQuestion(request) ?? notAnswered
  })
  ipcMain.handle(IPC_CHANNELS.answerDwarfPermission, (_event, payload: unknown) => {
    const request = parsePermissionRequest(payload)
    if (request === null) return notAnswered
    return runtime?.answerDwarfPermission(request) ?? notAnswered
  })

  // Starting a command of the person's own and holding it over stdio (#194).
  // Its own refusal rather than the launch channel's, because the sentence has
  // to be about the right thing: nothing here is an "agent" this app knows.
  const notHostedLaunched: HostedLaunchResult = {
    launched: false,
    error: 'That command could not be started.'
  }
  ipcMain.handle(IPC_CHANNELS.launchHostedProcess, (_event, payload: unknown) => {
    const request = parseHostedLaunchRequest(payload)
    if (request === null) return notHostedLaunched
    return runtime?.launchHostedProcess(request) ?? notHostedLaunched
  })

  // The panel watched a kicked agent stop (#46). One-way: main decides what
  // that costs the dwarf, and the answer travels back on the next poll.
  ipcMain.on(IPC_CHANNELS.retireDwarf, (_event, dwarfId: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing.
    if (typeof dwarfId !== 'string' || dwarfId === '') return
    runtime?.retireDwarf(dwarfId)
  })
}

// Single instance: a second launch just shows the existing panel.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showPanel())

  app
    .whenReady()
    .then(init)
    .catch((error: unknown) => {
      console.error('[main] Fatal startup error:', error)
      app.exit(1)
    })

  app.on('before-quit', () => {
    runtime?.stop()
    runtime = null
    // Releases the port only: the installed hooks and the opt-in marker are
    // what bring the channel back on the next launch. A hook that fires while
    // the app is closed simply fails to connect, which Claude Code treats as a
    // non-blocking error.
    void hooks?.shutdown()
    hooks = null
    // Drops the store's reference. It no longer closes the database — that file
    // is shared with the vault, whose forced final save is still in flight at
    // this point (see the composition block above). Whatever the last poll
    // observed here has already been written or has already missed its window;
    // there is nothing buffered for a final flush to save, unlike the ledger.
    void projects?.close()
    projects = null
    removeIpcHandlers()
    markQuitting()
  })
  app.on('will-quit', () => {
    toggleShortcut?.dispose()
    toggleShortcut = null
  })

  // Keep running in the tray even with every window hidden.
  app.on('window-all-closed', () => {
    // no-op: quitting happens only via the tray "Quit" item
  })
}
