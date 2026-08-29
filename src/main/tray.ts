import { Menu, Tray, app, nativeImage } from 'electron'
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled
} from './autostart'
import { togglePanel } from './window'

/** 16x16 amber diamond, generated at scaffold time (no binary asset needed). */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQklEQVR4nGNgGNSgK0rgPwiTrfnrMmUwJtkQZM0kG4JNM9GG4NNM0BBiNOM1hGIDKPYCVQIRnyEUpQWKUiPZmukGANye0xUOxnlCAAAAAElFTkSuQmCC'

let tray: Tray | null = null

export async function createTray(): Promise<Tray> {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('AgentName')
  tray.on('click', () => togglePanel())
  await refreshTrayMenu()
  return tray
}

async function refreshTrayMenu(): Promise<void> {
  if (!tray) return
  const autostartOn = await isAutostartEnabled()
  const menu = Menu.buildFromTemplate([
    { label: 'Show/Hide Panel', click: () => togglePanel() },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostartOn,
      click: (item) => {
        void (async () => {
          try {
            if (item.checked) {
              await enableAutostart()
            } else {
              await disableAutostart()
            }
          } catch (error) {
            console.warn('[tray] Failed to update autostart:', error)
          }
          await refreshTrayMenu()
        })()
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}
