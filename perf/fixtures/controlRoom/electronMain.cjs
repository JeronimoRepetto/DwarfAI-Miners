'use strict'
// The bare Electron main of the Control-room scaling page (ISSUE-298, S-034-1), launched by
// perf/valleScaling.perf.ts through Playwright's `_electron` with the E2E harness's
// mainErrorGuard.cjs preloaded, so an error never opens a modal box on the desktop. One window,
// sandboxed, no preload, no menu; the case loads the built page into it. Test-only: no production
// entry names this file. No Host is started and no provider is reached.
const { app, BrowserWindow, Menu } = process
  .getBuiltinModule('node:module')
  .createRequire(__filename)('electron')

app
  .whenReady()
  .then(() => {
    Menu.setApplicationMenu(null)
    const window = new BrowserWindow({
      width: 1280,
      height: 720,
      useContentSize: true,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    return window.loadURL('about:blank')
  })
  .catch(() => app.exit(1))

app.on('window-all-closed', () => app.quit())
