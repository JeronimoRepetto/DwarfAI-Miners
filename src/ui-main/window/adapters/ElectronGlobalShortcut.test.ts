// layer: L3
import type { GlobalShortcut } from 'electron'
import { runGlobalShortcutRegistryContract } from '../ports/globalShortcutRegistry.contract'
import { ElectronGlobalShortcut } from './ElectronGlobalShortcut'

/**
 * Electron's `globalShortcut` as its documentation and the OS lane (ElectronGlobalShortcut.os.test.ts) show it:
 * `register` answers `false` when another application, or another registrant of this process, holds the combination;
 * it throws for a string its accelerator parser refuses; `unregister` frees the combination. The real Electron leg of
 * the contract's cases is that OS-lane test (17 §1.3: what only a real facility proves runs in L8).
 */
class ModelledGlobalShortcut implements Pick<GlobalShortcut, 'register' | 'unregister'> {
  readonly otherApps = new Set<string>()
  private readonly held = new Map<string, () => void>()

  register(accelerator: string, callback: () => void): boolean {
    if (!/^(?:(?:Control|Alt|Shift|Super)\+)*(?:F\d{1,2}|[A-Z0-9])$/.test(accelerator)) {
      throw new TypeError(`conversion failure from ${accelerator}`)
    }
    if (this.otherApps.has(accelerator) || this.held.has(accelerator)) return false
    this.held.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.held.delete(accelerator)
  }

  press(accelerator: string): boolean {
    const callback = this.held.get(accelerator)
    callback?.()
    return callback !== undefined
  }
}

runGlobalShortcutRegistryContract('ElectronGlobalShortcut over Electron globalShortcut', () => {
  const electron = new ModelledGlobalShortcut()
  return {
    registry: new ElectronGlobalShortcut(electron),
    takenByAnotherApp: (accel) => electron.otherApps.add(accel),
    press: (accel) => electron.press(accel)
  }
})
