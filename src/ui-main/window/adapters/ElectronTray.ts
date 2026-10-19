import type { TrayController, TrayMenuModel } from '../ports/trayController'

/** The part of an Electron `Tray` the adapter uses. */
export interface ElectronTrayIcon {
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): void
  destroy(): void
}

/** The menu template entry the adapter builds (a subset of Electron's `MenuItemConstructorOptions`). */
export interface ElectronTrayMenuEntry {
  label?: string
  type?: 'separator'
  click?: () => void
}

/**
 * Electron's `Tray`, `Menu.buildFromTemplate` and `nativeImage.createFromPath`, as plain calls, so the composition root
 * binds them and a test records them. `createTray` throws where the desktop has no status area to hold the icon.
 */
export interface ElectronTrayApi {
  createTray(image: unknown): ElectronTrayIcon
  buildMenu(template: ElectronTrayMenuEntry[]): unknown
  iconFromPath(path: string): unknown
}

/**
 * `TrayController` over Electron's `Tray` (16 §4.14; 05 §3.14 ← `shell/tray.ts`, replaced: the found tray held a
 * module-level singleton, quit the app from its Quit item and had no Stop everything and quit). One icon, built from
 * the tray icon resource (`nativeImage` picks its `@2x` sibling), with the model's items as its context menu.
 *
 * The icon's own activation runs Open on Windows and Linux, where a click on the icon is the usual way back to the app
 * (on Linux, the StatusNotifierItem activation, Electron `Tray` "click"); on macOS a click on a menu-bar icon shows its
 * menu, so it runs nothing more. A desktop with no system tray makes `create` throw (13 FM-050), as the port says.
 */
export class ElectronTray implements TrayController {
  private icon: ElectronTrayIcon | null = null

  constructor(
    private readonly electron: ElectronTrayApi,
    private readonly iconPath: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  create(menu: TrayMenuModel): void {
    this.destroy()
    const icon = this.electron.createTray(this.electron.iconFromPath(this.iconPath))
    icon.setContextMenu(
      this.electron.buildMenu(
        menu.map((entry) =>
          entry.kind === 'separator'
            ? { type: 'separator' }
            : { label: entry.label, click: () => entry.choose() }
        )
      )
    )
    const open = menu.find((entry) => entry.kind === 'item' && entry.id === 'open')
    if (this.platform !== 'darwin' && open?.kind === 'item') icon.on('click', () => open.choose())
    this.icon = icon
  }

  destroy(): void {
    this.icon?.destroy()
    this.icon = null
  }
}
