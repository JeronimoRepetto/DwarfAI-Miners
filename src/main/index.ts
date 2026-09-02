import { config as loadDotenv } from 'dotenv'
import { app, dialog, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShortcutPlatform } from '../shared/accelerator'
import type {
  AppBuild,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfTextRequest,
  DwarfTextResult,
  MaterialTotals,
  Mine,
  MineDeclareResult,
  MinesSnapshot,
  MineUndeclareResult
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from './shell/autostart'
import { loadConfig } from './config/config'
import {
  CONFIG_FILE_NAME,
  createConfigFileStore,
  withConfigFileFallback
} from './config/configFile'
import { sumTokensObserved } from './domain/aggregate'
import { HookChannel } from './hooks/hookChannel'
import { NodeHookFs } from './hooks/hookFs'
import { NodeFs } from './adapters/fsLike'
import { runCoalBackfill } from './ledger/coalBackfill'
import { createLedgerStore } from './ledger/ledgerStore'
import { MaterialLedger } from './ledger/materialLedger'
import { openProjectsStore } from './projects/openProjectsStore'
import { PROJECTS_DB_FILENAME, type ProjectsStore } from './projects/projectsStore'
import { createPinPreferenceStore } from './shell/pinPreference'
import { AgentRuntime, expandHomePath } from './runtime/runtime'
import { createShortcutPreferenceStore } from './shell/shortcutPreference'
import { createToggleShortcut, type ToggleShortcutController } from './shell/shortcuts'
import { createTray } from './shell/tray'
import {
  applyAlwaysOnTop,
  createMainWindow,
  hidePanel,
  markQuitting,
  showPanel,
  togglePanel
} from './shell/window'

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
  ipcMain.removeHandler(IPC_CHANNELS.getAlwaysOnTop)
  ipcMain.removeHandler(IPC_CHANNELS.setAlwaysOnTop)
  ipcMain.removeHandler(IPC_CHANNELS.getToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.setToggleShortcut)
  ipcMain.removeHandler(IPC_CHANNELS.getMines)
  ipcMain.removeHandler(IPC_CHANNELS.activateDwarf)
  ipcMain.removeHandler(IPC_CHANNELS.sendDwarfText)
  ipcMain.removeHandler(IPC_CHANNELS.kickDwarf)
  ipcMain.removeAllListeners(IPC_CHANNELS.retireDwarf)
  ipcMain.removeHandler(IPC_CHANNELS.getAppBuild)
  ipcMain.removeHandler(IPC_CHANNELS.declareMine)
  ipcMain.removeHandler(IPC_CHANNELS.undeclareMine)
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

/** Same boundary discipline as parseTextRequest: kick carries no user text at all. */
function parseKickRequest(payload: unknown): DwarfKickRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string') return null
  return { dwarfId: record.dwarfId }
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
function toMinesSnapshot(mines: Mine[], materials: MaterialTotals | undefined): MinesSnapshot {
  return {
    mines,
    tokensObserved: sumTokensObserved(mines),
    ...(materials === undefined ? {} : { materials })
  }
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
  const mainWindow = createMainWindow({ alwaysOnTop: await pinStore.load() }) // starts hidden

  // The panel-toggle shortcut is the third userData preference (see #17), read
  // here so the accelerator is in hand before anything is claimed from the OS.
  // A missing or unusable file yields the documented Ctrl+Alt+Shift+P default.
  const shortcutStore = createShortcutPreferenceStore({
    filePath: join(app.getPath('userData'), 'shortcut-preference-v1.json')
  })
  const storedAccelerator = await shortcutStore.load()

  // The cumulative material vault (see #22), the fourth userData file. Loaded
  // before the runtime exists so the very first published poll already carries
  // real totals instead of briefly showing an empty vault.
  const ledger = new MaterialLedger({
    store: createLedgerStore({
      filePath: join(app.getPath('userData'), 'material-ledger-v1.json')
    }),
    onError: (message, error) => console.warn(message, error)
  })
  await ledger.load()

  // Every project the app has been shown (#93), the fifth userData file and
  // the first that is a database rather than a document. The path is injected
  // for the same reason the ledger's is: the store imports no Electron.
  //
  // A null here is a state, not a failure to handle later. The store refuses
  // loudly by design — a locked or corrupt database answers with a reason
  // instead of an empty list — and this is the one place that can turn that
  // refusal into a panel missing its declared mines rather than an app that
  // will not start. openProjectsStore logs the reason once.
  projects = await openProjectsStore({
    filePath: join(app.getPath('userData'), PROJECTS_DB_FILENAME),
    warn: (message) => console.warn(message)
  })

  runtime = new AgentRuntime({
    config,
    ledger,
    projects,
    appPaths: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    },
    chooseDirectory: () => chooseProjectDirectory(mainWindow),
    onMinesUpdated: (mines: Mine[], materials: MaterialTotals) => {
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.minesUpdated, toMinesSnapshot(mines, materials))
      }
    }
  })
  // Before the loop starts, exactly as the ledger is loaded before the runtime
  // exists: the first published poll then already carries the user's own mines
  // instead of drawing an empty valley and filling it a moment later.
  await runtime.loadDeclared()
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
    claudeRoots: config.claudeConfigDirs.map((path) => expandHomePath(path)),
    codexSessionsRoot: expandHomePath(config.codexSessionsRoot),
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
    roots: config.claudeConfigDirs.map((path) => expandHomePath(path)),
    userDataDir: app.getPath('userData'),
    port: config.hooksPort,
    platform: process.platform,
    onEvent: (event) => {
      console.log(`[hooks] ${event.event}${event.cwd === undefined ? '' : ` in ${event.cwd}`}`)
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
  ipcMain.on(IPC_CHANNELS.hidePanel, () => hidePanel())
  ipcMain.handle(IPC_CHANNELS.getAlwaysOnTop, () => mainWindow.isAlwaysOnTop())
  ipcMain.handle(IPC_CHANNELS.setAlwaysOnTop, async (_event, payload: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing
    // and the caller still gets the real state back.
    if (typeof payload !== 'boolean') return mainWindow.isAlwaysOnTop()
    const real = applyAlwaysOnTop(mainWindow, payload)
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

  // Adding and removing a user-declared mine (#85). declare takes no payload:
  // the folder picker runs here, so there is no path for the renderer to send
  // and none to validate. Both refusals below are what a runtime that never
  // came up would say, phrased for the panel rather than left silent.
  const notDeclared: MineDeclareResult = {
    declared: false,
    reason: 'The panel is still starting up.'
  }
  const notUndeclared: MineUndeclareResult = {
    outcome: 'failed',
    reason: 'The panel is still starting up.'
  }
  ipcMain.handle(IPC_CHANNELS.declareMine, () => runtime?.declareMine() ?? notDeclared)
  ipcMain.handle(IPC_CHANNELS.undeclareMine, (_event, mineId: unknown) => {
    // Boundary discipline as elsewhere: a malformed payload changes nothing,
    // and says so rather than resolving as a removal that never happened.
    if (typeof mineId !== 'string' || mineId === '') {
      return { outcome: 'unchanged', reason: 'No mine was named.' } satisfies MineUndeclareResult
    }
    return runtime?.undeclareMine(mineId) ?? notUndeclared
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
    // Releases the database handle. Whatever the last poll observed has already
    // been written or has already missed its window; there is nothing buffered
    // here for a final flush to save, unlike the ledger above.
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
