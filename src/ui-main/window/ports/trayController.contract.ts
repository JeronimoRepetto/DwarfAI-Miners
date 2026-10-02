import { describe, expect, it } from 'vitest'
import type { TrayController, TrayMenuModel } from './trayController'

/** What the desktop shows of one tray subject. */
export interface TrayControllerSubject {
  tray: TrayController
  /** The icons the desktop shows now: each one's menu, an item by its label and a separator as `'—'`. */
  icons(): string[][]
  /** The person chooses the item labelled `label` in the menu of the one icon shown. */
  choose(label: string): void
}

/**
 * The `TrayController` contract (16 §4.14, 16 §2.8; 05 §3.14), run by the double and by the real adapter alike: the
 * tray icon shows the model's menu in order, separator included, and choosing an item runs what the model says
 * (OQ-47); `destroy` removes the icon; a second `create` replaces the icon rather than adding one; where the desktop
 * has no system tray, `create` throws (13 FM-050). `make` answers a subject on a desktop with or without a system
 * tray.
 */
export function runTrayControllerContract(
  name: string,
  make: (desktop: { systemTray: boolean }) => TrayControllerSubject
): void {
  const model = (chosen: string[]): TrayMenuModel => [
    { kind: 'item', id: 'open', label: 'L-open', choose: () => chosen.push('open') },
    { kind: 'item', id: 'quit', label: 'L-quit', choose: () => chosen.push('quit') },
    { kind: 'separator' },
    { kind: 'item', id: 'stop-everything', label: 'L-stop', choose: () => chosen.push('stop') }
  ]

  describe(`${name} meets the TrayController contract (16 §4.14)`, () => {
    it('[ADR-018, OQ-47] create shows one icon whose menu holds the model items in order, and each item runs its own action', () => {
      const subject = make({ systemTray: true })
      const chosen: string[] = []

      subject.tray.create(model(chosen))

      expect(subject.icons()).toEqual([['L-open', 'L-quit', '—', 'L-stop']])
      subject.choose('L-stop')
      subject.choose('L-open')
      subject.choose('L-quit')
      expect(chosen).toEqual(['stop', 'open', 'quit'])
    })

    it('[ADR-018] destroy removes the icon, a second destroy changes nothing, and create again shows a single icon', () => {
      const subject = make({ systemTray: true })
      subject.tray.create(model([]))

      subject.tray.destroy()
      expect(subject.icons()).toEqual([])
      subject.tray.destroy()
      expect(subject.icons()).toEqual([])

      subject.tray.create(model([]))
      subject.tray.create(model([]))
      expect(subject.icons()).toHaveLength(1)
    })

    it('[FM-050] where the desktop has no system tray, create throws and no icon shows', () => {
      const subject = make({ systemTray: false })

      expect(() => subject.tray.create(model([]))).toThrow()

      expect(subject.icons()).toEqual([])
    })
  })
}
