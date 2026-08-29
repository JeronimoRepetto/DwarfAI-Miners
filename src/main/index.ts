import { config as loadDotenv } from 'dotenv'
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type { Mine } from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import {
  enable as enableAutostart,
  ensureDefaultAutostart,
  migrateLegacyAutostart
} from './autostart'
import { loadConfig } from './config'
import { AgentRuntime } from './runtime'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { createTray } from './tray'
import { createMainWindow, hidePanel, markQuitting, showPanel, togglePanel } from './window'

let runtime: AgentRuntime | null = null

function removeIpcHandlers(): void {
  ipcMain.removeAllListeners(IPC_CHANNELS.hidePanel)
  ipcMain.removeHandler(IPC_CHANNELS.getMines)
  ipcMain.removeHandler(IPC_CHANNELS.activateDwarf)
}

async function init(): Promise<void> {
  app.setAppUserModelId('com.jeronimorepetto.dwarfaiminers')

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
        mainWindow.webContents.send(IPC_CHANNELS.minesUpdated, mines)
      }
    }
  })
  runtime.start()

  const noActivation = { focused: false, openedTerminal: false, feed: [] }
  ipcMain.on(IPC_CHANNELS.hidePanel, () => hidePanel())
  ipcMain.handle(IPC_CHANNELS.getMines, () => runtime?.getMines() ?? [])
  ipcMain.handle(IPC_CHANNELS.activateDwarf, (_event, dwarfId: unknown) => {
    if (typeof dwarfId !== 'string') return noActivation
    return runtime?.activateDwarf(dwarfId) ?? noActivation
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
