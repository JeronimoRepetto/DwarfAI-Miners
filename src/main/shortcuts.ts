import { globalShortcut } from 'electron'

/**
 * Global panel toggle. Deliberately NOT Ctrl+Alt+Shift+Z: another app on this
 * PC owns that combination. P should be free, but registration is verified at
 * runtime and a clear warning is logged if it fails.
 */
export const TOGGLE_SHORTCUT = 'Control+Alt+Shift+P'

export function registerShortcuts(togglePanel: () => void): void {
  const registered = globalShortcut.register(TOGGLE_SHORTCUT, togglePanel)
  if (!registered) {
    console.warn(
      `[shortcuts] Failed to register global shortcut ${TOGGLE_SHORTCUT} — ` +
        'another application already owns it. The panel can still be toggled from the tray icon.'
    )
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
