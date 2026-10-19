// layer: L2
import { describe, expect, it } from 'vitest'
import type { TrayMenuModel } from '../ports/trayController'
import { ElectronTray, type ElectronTrayApi } from './ElectronTray'
import { runTrayControllerContract } from '../ports/trayController.contract'

/**
 * The real `ElectronTray` over recording doubles of Electron's `Tray`, `Menu` and `nativeImage` (16 §4.14; 05 §3.14
 * ← `shell/tray.ts`, replaced): the menu shows the model's items in order, each item runs what the model says, the
 * icon's own activation is Open where the platform sends one, and `destroy` removes the icon.
 */
interface RecordedItem {
  label?: string
  type?: string
  click?: () => void
}

class RecordingElectron {
  readonly trays: RecordingTray[] = []
  readonly images: string[] = []
  failConstruct = false

  api(): ElectronTrayApi {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const recorder = this
    return {
      createTray(image) {
        if (recorder.failConstruct) throw new Error('no status area')
        const tray = new RecordingTray(image)
        recorder.trays.push(tray)
        return tray
      },
      buildMenu: (template) => template,
      iconFromPath: (path) => {
        recorder.images.push(path)
        return { path }
      }
    }
  }
}

class RecordingTray {
  menu: RecordedItem[] | null = null
  destroyed = false
  readonly clicks: Array<() => void> = []
  constructor(readonly image: unknown) {}
  setContextMenu(menu: unknown): void {
    this.menu = menu as RecordedItem[]
  }
  on(event: 'click', listener: () => void): void {
    if (event === 'click') this.clicks.push(listener)
  }
  destroy(): void {
    this.destroyed = true
  }
}

function model(chosen: string[]): TrayMenuModel {
  return [
    { kind: 'item', id: 'open', label: 'L-open', choose: () => chosen.push('open') },
    { kind: 'item', id: 'quit', label: 'L-quit', choose: () => chosen.push('quit') },
    { kind: 'separator' },
    { kind: 'item', id: 'stop-everything', label: 'L-stop', choose: () => chosen.push('stop') }
  ]
}

describe('ElectronTray (16 §4.14)', () => {
  it('[ADR-018] create shows the icon with the model items in order and each item runs its own action', () => {
    const electron = new RecordingElectron()
    const chosen: string[] = []
    new ElectronTray(electron.api(), '/app/resources/tray-icon.png', 'win32').create(model(chosen))

    expect(electron.images).toEqual(['/app/resources/tray-icon.png'])
    const items = electron.trays[0]?.menu ?? []
    expect(items.map((item) => item.type ?? item.label)).toEqual([
      'L-open',
      'L-quit',
      'separator',
      'L-stop'
    ])
    for (const item of items) item.click?.()
    expect(chosen).toEqual(['open', 'quit', 'stop'])
  })

  it('[S10.13] the icon activation opens the window on Windows and Linux, never on macOS where the click shows the menu', () => {
    for (const [platform, expected] of [
      ['win32', ['open']],
      ['linux', ['open']],
      ['darwin', []]
    ] as const) {
      const electron = new RecordingElectron()
      const chosen: string[] = []
      new ElectronTray(electron.api(), 'icon.png', platform).create(model(chosen))
      for (const click of electron.trays[0]?.clicks ?? []) click()
      expect(chosen, platform).toEqual(expected)
    }
  })

  it('[ADR-018] destroy removes the icon and a second destroy does nothing', () => {
    const electron = new RecordingElectron()
    const tray = new ElectronTray(electron.api(), 'icon.png', 'win32')
    tray.create(model([]))
    tray.destroy()
    expect(electron.trays[0]?.destroyed).toBe(true)
    tray.destroy()
    expect(electron.trays).toHaveLength(1)
  })

  it('[FM-050] a desktop with no system tray makes create throw', () => {
    const electron = new RecordingElectron()
    electron.failConstruct = true
    expect(() => new ElectronTray(electron.api(), 'icon.png', 'linux').create(model([]))).toThrow()
  })
})

runTrayControllerContract('ElectronTray over Electron Tray and Menu', ({ systemTray }) => {
  const electron = new RecordingElectron()
  electron.failConstruct = !systemTray
  const live = (): RecordingTray[] => electron.trays.filter((tray) => !tray.destroyed)
  return {
    tray: new ElectronTray(electron.api(), 'icon.png', 'win32'),
    icons: () =>
      live().map((tray) =>
        (tray.menu ?? []).map((item) => (item.type === 'separator' ? '—' : (item.label ?? '')))
      ),
    choose: (label) => {
      const [tray] = live()
      const item = (tray?.menu ?? []).find((entry) => entry.label === label)
      if (item?.click === undefined) throw new Error(`no ${label} shown`)
      item.click()
    }
  }
})
