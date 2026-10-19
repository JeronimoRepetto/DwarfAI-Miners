import { runTrayControllerContract } from '../trayController.contract'
import type { TrayMenuModel } from '../trayController'
import { FakeTrayController } from './FakeTrayController'

/** A menu as the desktop shows it: an item by its label, a separator as `'—'`. */
const labelsOf = (menu: TrayMenuModel): string[] =>
  menu.map((entry) => (entry.kind === 'separator' ? '—' : entry.label))

runTrayControllerContract('FakeTrayController', ({ systemTray }) => {
  const tray = new FakeTrayController({ noSystemTray: !systemTray })
  const shownMenu = (): TrayMenuModel | null =>
    tray.iconShown ? (tray.createCalls[tray.createCalls.length - 1] ?? null) : null
  return {
    tray,
    icons: () => {
      const menu = shownMenu()
      return menu === null ? [] : [labelsOf(menu)]
    },
    choose: (label) => {
      const item = (shownMenu() ?? []).find(
        (entry) => entry.kind === 'item' && entry.label === label
      )
      if (item === undefined || item.kind !== 'item') throw new Error(`no ${label} shown`)
      tray.choose(item.id)
    }
  }
})
