import { config as loadDotenv } from 'dotenv'
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
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
import { AgentRuntime } from './runtime'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { createTray } from './tray'
import { createMainWindow, hidePanel, markQuitting, showPanel, togglePanel } from './window'

let runtime: AgentRuntime | null = null

function removeIpcHandlers(): void {
  ipcMain.removeAllListeners(IPC_CHANNELS.hidePanel)
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

  const mainWindow = createMainWindow() // starts hidden
  await createTray()
  registerShortcuts(togglePanel)

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

  const noActivation = { focused: false, openedTerminal: false, feed: [] }
  ipcMain.on(IPC_CHANNELS.hidePanel, () => hidePanel())
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
    removeIpcHandlers()
    markQuitting()
  })
  app.on('will-quit', () => unregisterShortcuts())

  // Keep running in the tray even with every window hidden.
  app.on('window-all-closed', () => {
    // no-op: quitting happens only via the tray "Quit" item
  })
}
