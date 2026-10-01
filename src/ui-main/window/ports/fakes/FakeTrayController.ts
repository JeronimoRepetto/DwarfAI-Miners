import type { TrayController, TrayMenuItemId, TrayMenuModel } from '../trayController'

/**
 * Hand-written double of `TrayController` (16 §4.14, 16 §2.8): the system tray as this process sees it. `create` shows
 * the icon with its menu, `destroy` removes it; a desktop with no system tray (`noSystemTray`) refuses `create` by
 * throwing, as the port says (13 FM-050). `choose(id)` plays the person choosing a menu item.
 */
export class FakeTrayController implements TrayController {
  readonly createCalls: TrayMenuModel[] = []
  destroyCalls = 0
  private shown: TrayMenuModel | null = null

  constructor(private readonly options: { noSystemTray?: boolean } = {}) {}

  create(menu: TrayMenuModel): void {
    this.createCalls.push(menu)
    if (this.options.noSystemTray === true) throw new Error('no system tray on this desktop')
    this.shown = menu
  }

  destroy(): void {
    this.destroyCalls += 1
    this.shown = null
  }

  /** Whether the icon shows. */
  get iconShown(): boolean {
    return this.shown !== null
  }

  /** The labels and separators of the shown menu, in order (`'—'` for a separator). */
  get entries(): string[] {
    return (this.shown ?? []).map((entry) => (entry.kind === 'separator' ? '—' : entry.id))
  }

  /** The person chooses `id` in the shown menu; throws when the icon is gone or holds no such item. */
  choose(id: TrayMenuItemId): void {
    const item = (this.shown ?? []).find((entry) => entry.kind === 'item' && entry.id === id)
    if (item === undefined || item.kind !== 'item') throw new Error(`the tray menu shows no ${id}`)
    item.choose()
  }
}
