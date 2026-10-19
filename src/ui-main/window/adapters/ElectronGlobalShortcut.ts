import type { GlobalShortcut } from 'electron'
import type { ShortcutPlatform } from '@dwarfai/contracts'
import type { GlobalShortcutRegistry } from '../ports/globalShortcutRegistry'

/**
 * `GlobalShortcutRegistry` over Electron's `globalShortcut` (16 §4.14; 05 §3.14 ← `shell/shortcuts.ts`). `register`
 * answers what Electron answered: `false` when another registrant holds the combination. Electron also throws when
 * its own parser refuses the string or before the app is ready; that is a refusal too, so the port never throws.
 */
export class ElectronGlobalShortcut implements GlobalShortcutRegistry {
  constructor(private readonly shortcuts: Pick<GlobalShortcut, 'register' | 'unregister'>) {}

  register(accel: string, onFire: () => void): boolean {
    try {
      return this.shortcuts.register(accel, onFire)
    } catch {
      return false
    }
  }

  unregister(accel: string): void {
    this.shortcuts.unregister(accel)
  }
}

/**
 * Whose key names the shortcut's texts use (`ShortcutPlatform`): only the distinctions that change a modifier's printed
 * name, as today's root reads them (legacy `shortcutPlatform`).
 */
export function currentShortcutPlatform(
  platform: NodeJS.Platform = process.platform
): ShortcutPlatform {
  if (platform === 'darwin') return 'darwin'
  if (platform === 'win32') return 'win32'
  return 'other'
}
