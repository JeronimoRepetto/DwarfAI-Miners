import { config as loadDotenv } from 'dotenv'
import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ShortcutPlatform } from '../shared/accelerator'
import type {
  AgentLaunchRequest,
  AgentModelCatalogList,
  AgentProviderList,
  AgentLaunchResult,
  AppBuild,
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
  DwarfTuningResult,
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
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  JevRouteLaunchResult,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  JevSettings
  /* --- end of the #509 follow-up block --------------------------------------- */
} from '../shared/contracts'
import {
  IPC_CHANNELS,
  isDwarfProvider,
  isHeldPermissionMode,
  isMessagePanelDragPhase,
  isMineTier,
  parseAudioPreferences,
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  parseTypographyPreferences,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Message attachments (#408) — one block, appended -------------------- */
  DWARF_IMAGE_EXTENSIONS,
  MAX_DWARF_ATTACHMENTS,
  parseDwarfAttachments,
  parseDwarfText,
  /* --- end of the #408 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  parseJevApiKeyInput,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  parseJevRouteLaunchRequest,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  parseJevPreferences
  /* --- end of the #509 follow-up block --------------------------------------- */
} from '../shared/contracts'
import { describeAttachments, type AttachmentFilePort } from './textDelivery/attachmentFiles'
import type { AttachmentReader } from './textDelivery/attachmentDelivery'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from './shell/autostart'
import {
  cliOverridesFrom,
  darwinConsoleInputOverride,
  linuxConsoleInputOverride,
  loadConfig
} from './config/config'
import {
  CONFIG_FILE_NAME,
  createConfigFileStore,
  withConfigFileFallback
} from './config/configFile'
import { sumTokensObserved } from './domain/aggregate'
import { parseLaunchTuning } from './domain/launchTuning'
import { HookChannel } from './hooks/hookChannel'
import { NodeHookFs } from './hooks/hookFs'
import { DelegationService } from './mcp/delegationService'
import { NodeFs } from './adapters/fsLike'
import { NodeSqlite } from './adapters/sqliteLike'
import { createPlatformAdapters } from './platform/platformAdapters'
import {
  MINE_PATH_OUTSIDE_REASON,
  MINE_PATH_UNOPENABLE_REASON,
  parseMineOpenPathRequest,
  verifyMinePath
} from './shell/openMineFile'
import { EXTERNAL_LINK_REFUSED_REASON, parseExternalLinkRequest } from './shell/openExternalLink'
import { parseDwarfFeedPageRequest } from './providers/feedWindow'
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
import { createJevApiKeyStore, type JevKeyVerdict } from './shell/jevApiKey'
import {
  createJevPreferenceStore,
  type JevPreferenceSaveRefusalReason
} from './shell/jevPreferences'
import { createJevLaunchRouter } from './jev/routeLaunch'
import { createTypesafeJevRouter, jevDebugEnabled } from './jev/typesafeJevRouter'
import { createMessagePanelPositionStore } from './shell/messagePanelPosition'
import { createPanelEdgePreferenceStore } from './shell/panelEdgePreference'
import { createPinPreferenceStore } from './shell/pinPreference'
import { AgentRuntime, expandHomePath } from './runtime/runtime'
import { createShortcutPreferenceStore } from './shell/shortcutPreference'
import { createTypographyPreferenceStore } from './shell/typographyPreference'
import { createToggleShortcut, type ToggleShortcutController } from './shell/shortcuts'
import { createTray } from './shell/tray'
import {
  applyAlwaysOnTop,
  createMainWindow,
  dockMessagePanel,
  dragMessagePanel,
  hidePanel,
  loadPanelPage,
  markQuitting,
  messagePanelState,
  messagePanelSurfaceSettled,
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
  parseAnswerRequest,
  parseDwarfDeliveryReport,
  parseMessagePanelHeight,
  parseMessagePanelState
} from './shell/messagePanelState'
/* --- System notifications (#316) — one block, appended --------------------- */
import { APP_USER_MODEL_ID, needsAppUserModelId } from './notifications/appUserModelId'
import { createElectronNotifications } from './notifications/electronNotifications'
import { createNotificationPreferenceStore } from './notifications/notificationPreference'
import { createNotifier, type Notifier } from './notifications/notifier'
/* --- end of the #316 block ------------------------------------------------- */

let runtime: AgentRuntime | null = null
let hooks: HookChannel | null = null
/**
 * The MCP subtask-delegation loopback listener (#511 T3). `issueLaunchToken`/
 * `revoke` are called from `AgentRuntime`'s own gate check now (#511 T4),
 * through the closures the `delegation` option below hands it.
 */
let delegationService: DelegationService | null = null
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

/**
 * The `warn` every port here is handed.
 *
 * Every one of those ports declares its second argument OPTIONAL — `warn?:
 * (message: string, error?: unknown) => void` — and several call sites use
 * the one-argument form because they already put the cause in the sentence.
 * Passing `error` straight through then printed a bare `undefined` on the end
 * of a line somebody is reading precisely because something went wrong (#555,
 * observed as "...is not valid JSON undefined"). The caller is obeying the
 * contract; this is the side that was not.
 */
/**
 * A store refusal, in words the panel can show.
 *
 * The store answers with a CODE, because it is a rule rather than a sentence;
 * the wording belongs on this side, the same split every other
 * fact-here/prose-there pair in this app holds.
 */
const JEV_PREFERENCE_REFUSALS: Record<JevPreferenceSaveRefusalReason, string> = {
  'default-provider-not-launchable':
    'That default launch names a provider this build cannot start, so nothing was saved. Pick another provider under Default launch.',
  'default-tuning-invalid':
    'That default launch pairs a model or effort its provider would refuse, so nothing was saved. Clear it under Default launch and try again.'
}

function warnWithOptionalCause(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
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
  ipcMain.removeAllListeners(IPC_CHANNELS.reportMessagePanelSettled)
  ipcMain.removeAllListeners(IPC_CHANNELS.reportDwarfDelivery)
  ipcMain.removeHandler(IPC_CHANNELS.getPanelVisible)
  ipcMain.removeHandler(IPC_CHANNELS.getAudioPreferences)
  ipcMain.removeHandler(IPC_CHANNELS.setAudioPreferences)
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  ipcMain.removeHandler(IPC_CHANNELS.getTypographyPreferences)
  ipcMain.removeHandler(IPC_CHANNELS.setTypographyPreferences)
  /* --- end of the #370 block ----------------------------------------------- */
  ipcMain.removeHandler(IPC_CHANNELS.getToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.setToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.getMines)
  ipcMain.removeHandler(IPC_CHANNELS.activateDwarf)
  ipcMain.removeHandler(IPC_CHANNELS.getDwarfFeed)
  ipcMain.removeHandler(IPC_CHANNELS.getDwarfFeedPage)
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
  /* --- Message attachments (#408) — one block, appended -------------------- */
  ipcMain.removeHandler(IPC_CHANNELS.chooseDwarfAttachments)
  ipcMain.removeHandler(IPC_CHANNELS.describeDwarfAttachments)
  /* --- end of the #408 block ----------------------------------------------- */
  /* --- System notifications (#316) — one block, appended ------------------- */
  ipcMain.removeHandler(IPC_CHANNELS.getNotificationsEnabled)
  ipcMain.removeHandler(IPC_CHANNELS.setNotificationsEnabled)
  ipcMain.removeAllListeners(IPC_CHANNELS.setOpenMine)
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  ipcMain.removeHandler(IPC_CHANNELS.getJevSettings)
  ipcMain.removeHandler(IPC_CHANNELS.setJevApiKey)
  ipcMain.removeHandler(IPC_CHANNELS.clearJevApiKey)
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  ipcMain.removeHandler(IPC_CHANNELS.routeJevLaunch)
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  ipcMain.removeHandler(IPC_CHANNELS.setJevPreferences)
  /* --- end of the #509 follow-up block --------------------------------------- */
}

/**
 * The renderer is trusted-but-typed: validate the shape at the boundary so a
 * malformed payload becomes an explained refusal instead of a main-process
 * throw. The message itself is never logged.
 */
function parseTextRequest(payload: unknown): DwarfTextRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string') return null
  // The one field that can refuse a well-formed request on its CONTENT (#431):
  // a message past the wire ceiling is one no channel could carry, so the
  // whole request goes down rather than arriving cut. See parseDwarfText for
  // why the handler's generic sentence is the honest one here.
  const text = parseDwarfText(record.text)
  if (text === null) return null
  // All-or-nothing, and the one field here that can refuse the whole request
  // (#408): a list trimmed to what fits would deliver some of somebody's files
  // and report success. The limits it reads are the wire's own, so this cannot
  // come to disagree with the composer about which message was too big.
  const attachments = parseDwarfAttachments(record.attachments)
  if (attachments === null) return null
  return {
    dwarfId: record.dwarfId,
    text,
    pressEnter: record.pressEnter === true,
    ...(attachments.length === 0 ? {} : { attachments })
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
  return {
    mineId: record.mineId,
    provider: record.provider,
    prompt: record.prompt,
    ...tuning,
    // Whether a Jev DECISION was applied to this launch (#511) — trusted only
    // as `true`; anything else (absent, junk) reads as not routed, the same
    // "say nothing" boundary discipline model/effort hold above.
    ...(record.routedByJev === true ? { routedByJev: true } : {})
  }
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
    ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }),
    // Same rule and same reasoning as parseLaunchRequest's own (#511).
    ...(record.routedByJev === true ? { routedByJev: true } : {})
  }
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
 * The composer's attach control, the second dialog in the app (#408).
 *
 * Files only and no directory, which is the issue's own rule and is enforced
 * again in `describeAttachments` — the picker's `properties` govern this one
 * button, and a dropped folder never passed through it at all.
 *
 * It answers PATHS, and stops. What each path is comes back from
 * `describeDwarfAttachments`, the same call a drop makes, so neither entry
 * point can grow a rule the other lacks.
 */
async function chooseAttachmentFiles(parent: BrowserWindow): Promise<string[]> {
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openFile', 'multiSelections']
  })
  return result.canceled ? [] : result.filePaths
}

/**
 * The real filesystem behind `describeAttachments`.
 *
 * `nativeImage` is what keeps an arbitrary path out of the renderer: it decodes
 * the file main was pointed at and hands back a data URL bounded to twice the
 * chip's own size, so the panel draws a preview without ever being given a
 * location it could load. A file that will not decode answers null and the chip
 * falls back to the file glyph — an image that cannot be previewed is still an
 * image, and refusing it would be a stricter rule than the session's.
 */
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

/**
 * One attached image's bytes, for a held session's content block (#408).
 *
 * The media type comes from the NAME rather than from sniffing the file, which
 * is the same rule `attachmentKindFor` uses to call it an image at all — one
 * answer, so a file the panel drew as an image cannot become something else on
 * its way to the stream. The wire admits four extensions and `.jpg` and
 * `.jpeg` are one media type, which is the only mapping here that is not the
 * extension itself.
 *
 * The size is bounded before this is reached: the boundary refuses anything
 * over `MAX_DWARF_ATTACHMENT_BYTES`, so nothing arbitrary is ever read whole
 * into memory here.
 */
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

/** Twice the design's 40px chip, so the preview is sharp on a 2× display. */
const ATTACHMENT_THUMBNAIL_PX = 80

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

  /* --- System notifications (#316) — one block, appended ------------------- */
  // Windows attributes a toast to an application identity, and a DEV build has
  // no installer shortcut to have told it one. Set before anything can raise a
  // notification, so the Action Center lists them under this app rather than
  // under Electron's default — NOT because a toast fails without it, which was
  // measured and did not reproduce (see appUserModelId.ts). The platform is
  // asked once here rather than inside the notification path, which is the
  // composition-point rule `platform-ports` asks for; the other two families
  // route by the bundle and by the D-Bus name and need nothing from us.
  if (needsAppUserModelId(currentPlatform())) app.setAppUserModelId(APP_USER_MODEL_ID)
  /* --- end of the #316 block ---------------------------------------------- */

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
    warn: warnWithOptionalCause
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

  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  // Read like the audio settings — after the window exists — but PRIMED here
  // rather than only inside its own IPC handler: the launch router (#509) reads the
  // decrypted key synchronously off this same store instance through
  // readKey(), and may run before Settings is ever opened this session, so
  // the cache it reads has to be warm before that can happen.
  const jevApiKeyStore = createJevApiKeyStore({ userDataDir: app.getPath('userData') })
  await jevApiKeyStore.load()
  /* --- end of the #509 block ------------------------------------------------ */

  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  // Composed beside the key store rather than merged into it: two different
  // files on disk (a secret and a preference, `config-layering`'s own split),
  // one shape on the wire — `getJevSettings`/`setJevApiKey`/`clearJevApiKey`/
  // `setJevPreferences` below all merge the two verdicts themselves.
  const jevPreferenceStore = createJevPreferenceStore({ userDataDir: app.getPath('userData') })
  /* --- end of the #509 follow-up block --------------------------------------- */

  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  // The SDK adapter reads the key through readKey() above — never a channel,
  // never the renderer. listProviders/listModels close over the module-level
  // `runtime` variable rather than a value captured here: it is still null at
  // this point in startup, and reading it lazily inside the closure is what
  // lets every call ask what THIS machine can launch NOW rather than a stale
  // answer from before the runtime existed.
  // JEV_DEBUG (#525/T4): the dev-console trace, read straight from the real
  // environment here and deliberately never through `config` — on for
  // `1`/`true` only (blank, `0` and junk mean off, per jevDebugEnabled), and
  // reachable from the repo `.env` because this runs after loadDotenv()
  // above. ONE sink, shared by both the SDK adapter's own request/answer
  // trace and the launch router's local-decision trace below, so a route
  // call reads as one continuous [jev:debug] story on the dev console
  // rather than two independently-wired sinks that could drift out of step.
  // It prints the person's own prompt, so the only thing ever wired into
  // either `debugLog` is this one console line, and only when the flag says so.
  const jevDebugLog = jevDebugEnabled() ? (line: string) => console.log(line) : undefined
  const jevRouterPort = createTypesafeJevRouter({
    readKey: jevApiKeyStore.readKey,
    ...(jevDebugLog === undefined ? {} : { debugLog: jevDebugLog })
  })
  const jevLaunchRouter = createJevLaunchRouter({
    router: jevRouterPort,
    listProviders: async () => (await runtime?.listAgentProviders())?.providers ?? [],
    listModels: async () => (await runtime?.listAgentModels())?.catalogs ?? [],
    // Read fresh on every call, same reason listProviders/listModels are:
    // Settings' Jev section (profile, default launch) can change between
    // one launch and the next (jev-routing-profiles T3).
    readPreferences: jevPreferenceStore.load,
    // OpenCode's own RAW live catalogue (#547) — routeLaunch.ts's own
    // capability derivation needs the cost/limit/capabilities/status facts
    // listAgentModels' folded AgentModelCatalog already drops; `runtime` is
    // still null this early exactly as the two closures above already
    // account for, and readOpenCodeCatalogue never throws on its own (see
    // runtime.ts's own comment), so `?? []` only ever covers a null runtime.
    readOpenCodeCatalogue: async () => (await runtime?.readOpenCodeCatalogue()) ?? [],
    ...(jevDebugLog === undefined ? {} : { debugLog: jevDebugLog })
  })
  /* --- end of the #509 block ------------------------------------------------ */

  /* --- Typography preferences (#370) — one block, appended ----------------- */
  // The eighth userData preference, read like the audio settings: after the
  // window exists, because the renderer paints the documented defaults on its
  // first frame and corrects itself on mount. Not held in a variable beside the
  // file, unlike the notifications switch — nothing in main READS a face, so
  // there is no poll to keep off the disk.
  const typographyStore = createTypographyPreferenceStore({
    filePath: join(app.getPath('userData'), 'typography-preferences-v1.json')
  })
  /* --- end of the #370 block ----------------------------------------------- */

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

  /* --- System notifications (#316) — one block, appended ------------------- */
  // The seventh userData preference, read the same way the audio settings are
  // — after the window exists, because nothing about the first frame depends
  // on it. Held in a variable as well as in the file so the poll can read the
  // switch without awaiting a disk read on every board.
  const notificationStore = createNotificationPreferenceStore({
    filePath: join(app.getPath('userData'), 'notification-preference-v1.json')
  })
  let notificationsEnabled = await notificationStore.load()

  /**
   * Which mine INTERIOR the shell has open, as the renderer last reported it.
   *
   * Main cannot derive this: `panelLayout().mineOpen` is a boolean about the
   * window's SHAPE and does not move when the person walks from one mine
   * straight into another, which is precisely the case #316's rule turns on.
   * So the renderer says, on its own one-way channel, and main believes it.
   *
   * Together with `panelVisible()` — which is main's own reading and the half
   * a page cannot honestly answer for a hidden window — this is the whole of
   * "focused".
   */
  let openMineId: string | null = null

  const notifier: Notifier = createNotifier({
    port: createElectronNotifications(),
    enabled: () => notificationsEnabled,
    focus: () => ({ panelVisible: panelVisible(), openMineId }),
    // The click route, and main owns all of it: showPanel restores a hidden or
    // minimised window and raises it, then the shell is TOLD which mine to
    // open. No dwarf is selected — the person clicks the dwarf to read the ask,
    // and a notification that opened a message panel for them would be
    // choosing what they look at.
    openMine: (mineId: string) => {
      showPanel()
      shellWebContents()?.send(IPC_CHANNELS.showMine, mineId)
    }
  })
  /* --- end of the #316 block ---------------------------------------------- */

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
  // will not start. openProjectsStore logs the reason once; the KIND of
  // refusal travels on into AgentRuntime (#572) so a database a newer build
  // wrote can be told apart from every other way this file fails to open.
  const openedProjects = await openProjectsStore({
    database: appDatabase,
    warn: (message) => console.warn(message)
  })
  projects = openedProjects.store
  const projectsRefusal = openedProjects.failure

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

  // Unset (the common case) leaves DARWIN_CONSOLE_INPUT_ENABLED — now `true`
  // — in charge; a stated override wins in either direction (#367 items 1
  // and 3).
  const darwinConsoleInputSetting = darwinConsoleInputOverride()
  // The same round trip for Linux's own tier (#471), read from its own
  // variable: LINUX_CONSOLE_INPUT_ENABLED is `true` too, and a stated override
  // wins in either direction. Two switches rather than one, because a macOS
  // operator turning their path off must not take Linux's tmux tier with it.
  const linuxConsoleInputSetting = linuxConsoleInputOverride()

  // `fs`, `home` and `appPaths` compose the real platform adapters below AND
  // reach the runtime as its own options — the same three values, read once.
  const home = homedir()
  const fs = new NodeFs()
  const appPaths = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  }
  // `AgentRuntime` composed this itself until #477: a `platformAdapters`
  // default meant a test that omitted the option got the REAL host's
  // adapters, which is how a fold walk in a linked worktree ended up reading
  // this checkout's own `.git`. `platformAdapters` has no default any more,
  // so the one production composition root builds it explicitly, on exactly
  // the terms the removed default used to.
  const platformAdapters = createPlatformAdapters({
    home,
    appPaths,
    relayModel: config.sendTextRelayModel,
    relayTimeoutMs: config.sendTextTimeoutS * 1_000,
    // CLI detection (#91) reads the same fs the providers do, and honours an
    // explicit override path per CLI; blank means "detect it".
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
    home,
    fs,
    appPaths,
    platformAdapters,
    chooseDirectory: () => chooseProjectDirectory(mainWindow),
    readAttachment,
    /* --- MCP subtask delegation: the gate's live inputs and the service's own port (#511 T4) — one block, appended --- */
    // `keyConfigured`/`delegationAllowed` read exactly the same two stores
    // the loopback service's own options do, below — the "ask fresh, never
    // cache" discipline that whole block already states applies here too.
    // `issueLaunchToken`/`revoke` close over the module-level
    // `delegationService`, which is still null at THIS point in startup
    // (constructed after `runtime.start()`, further down): reading it
    // lazily, inside these two closures, is what lets a launch made after
    // startup see the real instance — the identical trick
    // `delegationService`'s own `launch` option already plays on `runtime`.
    delegation: {
      keyConfigured: () => jevApiKeyStore.readKey() !== undefined,
      delegationAllowed: async () => (await jevPreferenceStore.load()).delegation,
      issueLaunchToken: (context) => delegationService?.issueLaunchToken(context),
      revoke: (token) => delegationService?.revoke(token)
    },
    /* --- end of the #511 T4 block ---------------------------------------------- */
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
      /* --- System notifications (#316) — one block, appended --------------- */
      // Folded here and nowhere else: this is already the one place a board is
      // published, and the PublishGate above it means an unchanged poll never
      // arrives — which is exactly the poll that could carry no new fact. So
      // #316 costs one fold over a snapshot that was being sent anyway, with
      // no timer, no queue and no second traversal of the runtime.
      //
      // AFTER the renderers, deliberately: the panel's own paint is what the
      // person is most likely to be looking at, and an OS call must not stand
      // in front of it.
      notifier.update(mines)
      /* --- end of the #316 block ------------------------------------------ */
    },
    // #263. Both windows, for the same reason `onMinesUpdated` reaches both:
    // the Add Panel that made the launch lives in whichever window opened it,
    // and main does not track which one that was.
    onLaunchFailed: (push: LaunchFailedPush) => {
      for (const contents of appWebContents()) {
        contents.send(IPC_CHANNELS.launchFailed, push)
      }
    },
    // #457. Both windows, for the reason above: the composer that held this
    // message lives in whichever window has that dwarf open, and main does
    // not track which one that was. One-way — the verdict of a message
    // already answered for has no verdict of its own.
    onSendSettled: (push: DwarfSendSettledPush) => {
      for (const contents of appWebContents()) {
        contents.send(IPC_CHANNELS.dwarfSendSettled, push)
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

  /* --- MCP subtask delegation: the loopback service (#511 T3) — one block, appended --- */
  // Always started, like `jevLaunchRouter` above — this listener answers
  // every request with a typed refusal until a token is presented, so
  // running it costs nothing for a build with delegation off; only T4's
  // injection adapters ever call `issueLaunchToken`, and this task wires
  // none of them in. `launch`/`route` close over `runtime`/`jevLaunchRouter`
  // exactly as the Jev block above does, for the same reason: `runtime` is
  // still null at THIS point in startup for any closure defined earlier, and
  // reading it lazily is what lets a call made after startup see the real
  // instance. `keyConfigured`/`delegationAllowed` are read fresh on every
  // `/delegate` call (never cached at token-issue time) — the same "ask
  // fresh" discipline the whole Jev block already holds, and the one that
  // lets a person turn delegation off or clear the key while a long-running
  // parent session's token is still valid.
  delegationService = new DelegationService({
    port: 0,
    launch: (request, hooks) =>
      runtime?.launchAgent(request, hooks) ??
      Promise.resolve({
        launched: false,
        provider: 'none',
        error: 'The panel is still starting up.'
      }),
    route: jevLaunchRouter.route,
    keyConfigured: () => jevApiKeyStore.readKey() !== undefined,
    delegationAllowed: async () => (await jevPreferenceStore.load()).delegation
  })
  await delegationService.start()
  /* --- end of the #511 T3 block ---------------------------------------------- */

  // The historical coal pile, produced once and never again (see #22).
  //
  // Deliberately NOT awaited: it reads through transcript trees that can be
  // very large, and startup must not wait on history. It is internally bounded
  // and resumable, so a launch that runs out of budget simply continues on the
  // next one, and its credits reach the panel through the next ordinary poll.
  void runCoalBackfill({
    fs: new NodeFs(),
    // A fresh port, exactly as the live OpenCode provider opens its own
    // (registry.ts): SqliteLike carries no state worth sharing across a
    // one-time scan and a running poll loop.
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
    warn: warnWithOptionalCause
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
  /**
   * A page this process cannot answer (#364). `reachedStart` stays false on
   * purpose: true would tell the panel it had reached the beginning of a
   * conversation nobody could read a word of, and it would stop asking.
   */
  const noFeedPage: DwarfFeedPage = { readable: false, messages: [], reachedStart: false }
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
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  /*
   * Settings' Typography section (#370).
   *
   * `set` answers with what was STORED, the discipline every preference channel
   * here holds: the shared parser refuses a face this build cannot draw — Tiny5
   * for messaging above all — so a segment can only ever be drawn selected for
   * a choice that is really in force.
   *
   * And then it BROADCASTS, which no other preference does. Settings is in the
   * shell; the messaging face is what the panel window draws its bubbles and
   * its Add Panel in, so a change made in one window has to reach the other in
   * the same frame rather than at its next reload. Sent to every window
   * including the sender: the renderer adopts main's verdict from one path, so
   * a window that also awaits the reply simply applies the same document twice.
   */
  ipcMain.handle(IPC_CHANNELS.getTypographyPreferences, () => typographyStore.load())
  ipcMain.handle(IPC_CHANNELS.setTypographyPreferences, async (_event, payload: unknown) => {
    const preferences = parseTypographyPreferences(payload)
    try {
      await typographyStore.save(preferences)
    } catch (error) {
      // The faces already changed on screen; a persistence hiccup only means
      // the next launch falls back to the stored document.
      console.warn('[typography] Failed to persist the typography preferences:', error)
    }
    for (const contents of appWebContents()) {
      contents.send(IPC_CHANNELS.typographyPreferencesChanged, preferences)
    }
    return preferences
  })
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- System notifications (#316) — one block, appended ------------------- */
  /*
   * Settings' Notifications switch, and the shell reporting which mine it has
   * open.
   *
   * `set` answers with what is IN FORCE rather than with the request, the
   * discipline every preference channel here holds — and the in-memory value is
   * what the poll reads, so the switch takes effect on the very next board
   * instead of on the next launch. A failed WRITE costs the next launch's
   * memory of the choice and nothing about this run.
   */
  ipcMain.handle(IPC_CHANNELS.getNotificationsEnabled, () => notificationsEnabled)
  ipcMain.handle(IPC_CHANNELS.setNotificationsEnabled, async (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing and
    // the caller still gets the real state back.
    if (typeof payload !== 'boolean') return notificationsEnabled
    notificationsEnabled = payload
    try {
      await notificationStore.save(payload)
    } catch (error) {
      // The switch itself already took effect; a persistence hiccup only means
      // the next launch falls back to whatever the file still says.
      console.warn('[notifications] Failed to persist the notifications switch:', error)
    }
    return notificationsEnabled
  })
  // One-way, like setWatchedDwarf. A non-string is null rather than '' because
  // null is a real answer here — "no mine interior is open" — and the map or
  // the browse with nothing open is exactly that state.
  ipcMain.on(IPC_CHANNELS.setOpenMine, (_event, payload: unknown) => {
    openMineId = typeof payload === 'string' && payload !== '' ? payload : null
  })
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  /*
   * Settings' Jev API-key control (#509).
   *
   * None of the three ever answers with the key: `get` re-reads the store,
   * which is the same "answer with what was STORED" discipline every
   * preference channel here holds, and `set`/`clear` derive their own answer
   * from `readKey()` rather than the request, so a refusal this store made
   * cannot be echoed back as success.
   *
   * AMENDED for the #509 follow-up: all three now answer the MERGED shape —
   * this store's own verdict plus `jevPreferenceStore.load()` — through
   * `withJevPreferences` below, because `preferences` rides on every
   * `JevSettings` the wire ever carries, not only on `getJevSettings`.
   */
  async function withJevPreferences(verdict: JevKeyVerdict): Promise<JevSettings> {
    return { ...verdict, preferences: await jevPreferenceStore.load() }
  }
  ipcMain.handle(IPC_CHANNELS.getJevSettings, async () =>
    withJevPreferences(await jevApiKeyStore.load())
  )
  ipcMain.handle(IPC_CHANNELS.setJevApiKey, async (_event, payload: unknown) => {
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
      // A shape the shared parser refuses (not a string, empty once trimmed,
      // too long, or carrying a character no key uses) never reaches the
      // store at all — the boundary trusted-but-typed discipline every
      // request here holds.
      console.warn('[jev] Refused to save an API key:', error)
    }
    return withJevPreferences({ configured: jevApiKeyStore.readKey() !== undefined })
  })
  ipcMain.handle(IPC_CHANNELS.clearJevApiKey, async () => {
    try {
      await jevApiKeyStore.clear()
    } catch (error) {
      // The key is already gone from memory; a persistence hiccup only means
      // the next launch falls back to whatever the file still says.
      console.warn('[jev] Failed to clear the stored API key:', error)
    }
    return withJevPreferences({ configured: jevApiKeyStore.readKey() !== undefined })
  })
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  // A payload the shared parser refuses never reaches the router at all — the
  // same trusted-but-typed discipline every request here holds — and becomes
  // a typed fallback rather than a thrown IPC error, so the renderer always
  // has something honest to fall back the launch to.
  const jevRouteRefused: JevRouteLaunchResult = { kind: 'fallback', reason: 'invalid-response' }
  ipcMain.handle(
    IPC_CHANNELS.routeJevLaunch,
    async (_event, payload: unknown): Promise<JevRouteLaunchResult> => {
      try {
        const request = parseJevRouteLaunchRequest(payload)
        return await jevLaunchRouter.route(request)
      } catch (error) {
        console.warn('[jev] Refused a route request:', error)
        return jevRouteRefused
      }
    }
  )
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  // Parsed through the SHARED parser first — the shape half, degrading a bad
  // document rather than throwing — then re-validated by the store's own
  // `save`, which refuses a default the launch gate would reject. Either way
  // this answers the MERGED shape actually STORED, never the request: a
  // refused write re-reads whatever preference is really in force, exactly
  // like `setJevApiKey` does for the key.
  ipcMain.handle(IPC_CHANNELS.setJevPreferences, async (_event, payload: unknown) => {
    const preferences = parseJevPreferences(payload)
    let failure: string | undefined
    try {
      const result = await jevPreferenceStore.save(preferences)
      if (!result.saved) failure = JEV_PREFERENCE_REFUSALS[result.reason]
    } catch (error) {
      // The write itself broke — a locked file, a full disk, a rename the OS
      // refused. It used to escape the handler and reject the renderer's
      // invoke, which showed up there as a silent revert.
      failure = `The preference could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    // Always the state actually in force, and the reason it is not the state
    // that was asked for. The console line stays for the terminal; the field
    // is what reaches the person.
    if (failure !== undefined) console.warn(`[jev] Preferences not saved: ${failure}`)
    const stored = await withJevPreferences(await jevApiKeyStore.load())
    return failure === undefined ? stored : { ...stored, preferencesError: failure }
  })
  /* --- end of the #509 follow-up block --------------------------------------- */
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
    // #409: only the shell's OWN click selects or switches a dwarf. The panel
    // window can set this same surface for itself — adopting the dwarf its
    // own launch produced (#162) — and that transition must not steal the
    // keyboard from wherever the person already is. `event.sender` is the
    // one place that distinction is knowable at all.
    const fromShell = event.sender === shellWebContents()
    const applied = setMessagePanel(request, fromShell)
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
  // The panel's surface has finished leaving (#389), so the window main held
  // open for exactly that can go. Nothing crosses and nothing is validated:
  // the message IS the report, and main re-checks its own state before acting
  // on it — see messagePanelHideIsDue for what a report can still be refused
  // for, a reopen inside the wait above all.
  ipcMain.on(IPC_CHANNELS.reportMessagePanelSettled, () => {
    messagePanelSurfaceSettled()
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
  // One page of conversation older than the cursor the panel sent (#364).
  // Boundary discipline as elsewhere: a payload this process cannot read is
  // refused outright rather than coerced — a defaulted cursor would answer a
  // page for a place the reader never was. See parseDwarfFeedPageRequest for
  // the two refusals and the one field that legitimately arrives empty.
  ipcMain.handle(IPC_CHANNELS.getDwarfFeedPage, (_event, payload: unknown) => {
    const request = parseDwarfFeedPageRequest(payload)
    if (request === null) return noFeedPage
    return runtime?.dwarfFeedPage(request) ?? noFeedPage
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

  ipcMain.handle(IPC_CHANNELS.chooseDwarfAttachments, () => chooseAttachmentFiles(mainWindow))

  ipcMain.handle(IPC_CHANNELS.describeDwarfAttachments, (_event, payload: unknown) => {
    // A path is a string and nothing here defaults one: a payload that is not a
    // list of strings is a request this process cannot run, and answering about
    // a path nobody sent is how a picker would come to describe the wrong file.
    if (!Array.isArray(payload)) return []
    const paths = payload.filter((item): item is string => typeof item === 'string' && item !== '')
    if (paths.length !== payload.length) return []
    return describeAttachments(paths.slice(0, MAX_DWARF_ATTACHMENTS), attachmentFiles)
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

  // Loaded LAST, after every ipcMain.handle/on above (#570): the window was
  // built near the top of this function so the tray, the shortcut and the
  // panel placement could all have it early, but starting the page load that
  // early let a fast-mounting renderer invoke a channel before its handler
  // existed. Nothing above this line pushes into the page rather than
  // registering a listener for later — see window.ts's own comment on
  // loadPanelPage for the two exceptions that are pushes (onMinesUpdated's
  // first poll, and the panel-visibility relay), both of which are safe here
  // for the same reason: the renderer re-asks for its own state on mount, so
  // a push that arrives before the page exists is merely one this ordering
  // does not depend on.
  loadPanelPage()
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
    // #511 T3: releases the loopback port only, same terms as the hooks
    // channel just above — nothing here is written to disk to bring back.
    void delegationService?.stop()
    delegationService = null
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
