import { config as loadDotenv } from 'dotenv'
import { app, ipcMain } from 'electron'
import { loadConfig } from './config'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { createTray } from './tray'
import { createMainWindow, hidePanel, markQuitting, showPanel, togglePanel } from './window'

async function init(): Promise<void> {
  app.setAppUserModelId('com.ai-tools.agent-name')

  // Typed config, fails fast on invalid values before any window exists.
  loadDotenv({ quiet: true })
  const config = loadConfig()
  console.log('[main] Config loaded:', config)

  createMainWindow() // starts hidden
  await createTray()
  registerShortcuts(togglePanel)

  ipcMain.on('panel:hide', () => hidePanel())
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

  app.on('before-quit', () => markQuitting())
  app.on('will-quit', () => unregisterShortcuts())

  // Keep running in the tray even with every window hidden.
  app.on('window-all-closed', () => {
    // no-op: quitting happens only via the tray "Quit" item
  })
}
