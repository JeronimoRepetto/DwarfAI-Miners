'use strict'
// Preloaded into a test-launched app's main process with Electron's `-r` switch when a case asks for it
// (`launchApp({ trayProbe: true })`): an OS tray menu cannot be clicked from a test, so this records, before the app's
// main file runs, every menu the app builds and each tray icon it shows and removes, on the Electron objects the app
// itself uses. A case chooses a tray item by calling its own `click` (`chooseTrayItem`), the same function a person's
// click runs; the icon's showing and removal are also appended to the file `DWARFAI_E2E_TRAY_LOG` names, readable after
// the app exited. Test-only; no production code loads it (R14).
const fs = process.getBuiltinModule('node:fs')
const electron = process.getBuiltinModule('node:module').createRequire(__filename)('electron')

const log = process.env.DWARFAI_E2E_TRAY_LOG
const probe = { menus: [], shown: 0, removed: 0 }
globalThis.__dwarfaiE2eTray = probe

function note(line) {
  try {
    if (log) fs.appendFileSync(log, `${line}\n`)
  } catch {
    // The counters still tell a case that reads them while the app runs.
  }
}

const buildFromTemplate = electron.Menu.buildFromTemplate
electron.Menu.buildFromTemplate = function (template) {
  probe.menus.push(template)
  return buildFromTemplate.call(this, template)
}

const setContextMenu = electron.Tray.prototype.setContextMenu
electron.Tray.prototype.setContextMenu = function (menu) {
  probe.shown += 1
  note('shown')
  return setContextMenu.call(this, menu)
}

const destroy = electron.Tray.prototype.destroy
electron.Tray.prototype.destroy = function () {
  probe.removed += 1
  note('removed')
  return destroy.call(this)
}
