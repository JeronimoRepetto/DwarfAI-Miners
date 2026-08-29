import { app } from 'electron'
import { access, writeFile } from 'node:fs/promises'
import type { LaunchCommand } from './platform/autostartEntries'
import type { AutostartPort } from './platform/autostartPorts'
import { createAutostartPort } from './platform/platformAdapters'

export { planAutostartMigration } from './platform/autostartPorts'
export type { AutostartMigrationPlan, AutostartMigrationState } from './platform/autostartPorts'

/**
 * "Start at login", from the app's point of view.
 *
 * How it is actually registered is per-OS and lives behind AutostartPort (the
 * Run key on Windows, a LaunchAgent plist on macOS, an XDG autostart entry on
 * Linux). What stays here is everything Electron-shaped: whether this build is
 * packaged, what command should be launched, and the once-only first-run
 * default — none of which the platform adapters are allowed to know about, so
 * that they stay unit-testable without Electron.
 */

const DEFAULT_MARKER = 'autostart-default-v1'

/** Created on first use: `app` is not readable at module-import time under test. */
let port: AutostartPort | null = null

function autostartPort(): AutostartPort {
  port ??= createAutostartPort()
  return port
}

export interface DefaultAutostartOptions {
  isPackaged: boolean
  markerPath: string
  enable: () => Promise<void>
  fileExists?: (path: string) => Promise<boolean>
  writeMarker?: (path: string) => Promise<void>
  warn?: (message: string, error: unknown) => void
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const defaultWriteMarker = async (path: string): Promise<void> => {
  await writeFile(path, `${DEFAULT_MARKER}\n`, { encoding: 'utf8', flag: 'wx' })
}

/**
 * Enables the packaged app's default autostart exactly once. The marker is
 * written only after the platform operation succeeds, so transient failures
 * can retry on the next launch. Development runs never touch either store.
 */
export async function ensureDefaultAutostart(options: DefaultAutostartOptions): Promise<void> {
  if (!options.isPackaged) return
  const fileExists = options.fileExists ?? defaultFileExists
  const writeMarker = options.writeMarker ?? defaultWriteMarker
  if (await fileExists(options.markerPath)) return
  try {
    await options.enable()
    await writeMarker(options.markerPath)
  } catch (error) {
    options.warn?.('[autostart] Failed to enable default startup; will retry:', error)
  }
}

/**
 * What the operating system should launch at login. Works unpackaged too: in
 * dev it points at the Electron executable plus the app path.
 */
function launchCommand(): LaunchCommand {
  return {
    executable: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()]
  }
}

/**
 * Registers DwarfAI-Miners with this platform's login mechanism.
 *
 * Packaged builds call this once through ensureDefaultAutostart(); later
 * changes come only from the explicit "Start at login" tray checkbox.
 * Development runs may call it manually, but log the exact command first.
 */
export async function enable(): Promise<void> {
  const command = launchCommand()
  if (!app.isPackaged) {
    console.warn(
      '[autostart] Registering a DEV autostart command (electron executable + app path): ' +
        [command.executable, ...command.args].join(' ')
    )
  }
  await autostartPort().enable(command)
}

export async function disable(): Promise<void> {
  await autostartPort().disable()
}

export async function isEnabled(): Promise<boolean> {
  return autostartPort().isEnabled()
}

/**
 * Runs the one-time migration from a previous release's autostart entry (the
 * legacy 'AgentName' Run value, which only Windows ever had). Only for
 * packaged builds — development runs never touch the registry.
 */
export async function migrateLegacyAutostart(
  isPackaged: boolean,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error)
): Promise<void> {
  if (!isPackaged) return
  await autostartPort().migrateLegacy(warn, launchCommand())
}
