import { config as loadDotenv } from 'dotenv'
import { app, globalShortcut, ipcMain } from 'electron'
import { join } from 'node:path'
import type { ShortcutPlatform } from '../shared/accelerator'
import type {
  DwarfKickRequest,
  DwarfKickResult,
  DwarfTextRequest,
  DwarfTextResult,
  Mine,
  MinesSnapshot
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from './autostart'
import { loadConfig } from './config'
import { sumTokensObserved } from './domain/aggregate'
import { HookChannel } from './hooks/hookChannel'
import { NodeHookFs } from './hooks/hookFs'
import { createPinPreferenceStore } from './pinPreference'
import { AgentRuntime, expandHomePath } from './runtime'
import { createShortcutPreferenceStore } from './shortcutPreference'
import { createToggleShortcut, type ToggleShortcutController } from './shortcuts'
import { createTray } from './tray'
import {
  applyAlwaysOnTop,
  createMainWindow,
  hidePanel,
  markQuitting,
  showPanel,
  togglePanel
} from './window'

let runtime: AgentRuntime | null = null
let hooks: HookChannel | null = null
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

/** Wraps a mines list with its vault total for both getMines() and the push. */
function toMinesSnapshot(mines: Mine[]): MinesSnapshot {
  return { mines, tokensObserved: sumTokensObserved(mines) }
}

async function init(): Promise<void> {
  app.setAppUserModelId('com.jeronimorepetto.dwarfaiminers')

  // DwarfAI-Miners lives in the tray/menu bar and its only window is a hidden
  // floating panel, so it has no business owning a Dock tile. `app.dock` only
  // exists on macOS; every other platform leaves this untouched.
  app.dock?.hide()

  // Typed config, fails fast on invalid values before any window exists.
  loadDotenv({ quiet: true })
  const config = loadConfig()
  console.log('[main] Config loaded:', config)

  // One-time rename migration, before the marker-gated first-run default below.
  await migrateLegacyAutostart(app.isPackaged)

  // userData follows productName (AgentName -> DwarfAI-Miners), so this path
  // moved with the rename. The only thing ever written under it is this
  // first-run marker; config is env-based, so no data migration is needed.
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

  runtime = new AgentRuntime({
    config,
    appPaths: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    },
    onMinesUpdated: (mines: Mine[]) => {
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.minesUpdated, toMinesSnapshot(mines))
      }
    }
  })
  runtime.start()

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
  ipcMain.handle(IPC_CHANNELS.getMines, () => toMinesSnapshot(runtime?.getMines() ?? []))
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
