import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, writeFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'DwarfAI-Miners'
/** Pre-rename Run value name, kept only to migrate existing installs away from it. */
const LEGACY_VALUE_NAME = 'AgentName'
const DEFAULT_MARKER = 'autostart-default-v1'

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
 * written only after the registry operation succeeds, so transient failures
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
    options.warn?.('[autostart] Failed to enable default Windows startup; will retry:', error)
  }
}

/**
 * Command written to the Run key. Works unpackaged too: in dev it points to
 * the electron executable plus the app path.
 */
function autostartCommand(): string {
  if (app.isPackaged) {
    return `"${process.execPath}"`
  }
  return `"${process.execPath}" "${app.getAppPath()}"`
}

/**
 * Registers DwarfAI-Miners in HKCU\...\CurrentVersion\Run.
 *
 * Packaged builds call this once through ensureDefaultAutostart(); later
 * changes come only from the explicit "Start with Windows" tray checkbox.
 * Development runs may call it manually, but log the exact command first.
 */
export async function enable(): Promise<void> {
  if (!app.isPackaged) {
    console.warn(
      `[autostart] Registering a DEV autostart command (electron.exe + app path): ${autostartCommand()}`
    )
  }
  await execFileAsync('reg', [
    'add',
    RUN_KEY,
    '/v',
    VALUE_NAME,
    '/t',
    'REG_SZ',
    '/d',
    autostartCommand(),
    '/f'
  ])
}

async function queryRegistryValue(valueName: string): Promise<boolean> {
  try {
    await execFileAsync('reg', ['query', RUN_KEY, '/v', valueName])
    return true
  } catch {
    return false
  }
}

async function deleteRegistryValue(valueName: string): Promise<void> {
  try {
    await execFileAsync('reg', ['delete', RUN_KEY, '/v', valueName, '/f'])
  } catch {
    // Value not present — already gone.
  }
}

export async function disable(): Promise<void> {
  await deleteRegistryValue(VALUE_NAME)
}

export async function isEnabled(): Promise<boolean> {
  return queryRegistryValue(VALUE_NAME)
}

export interface AutostartMigrationState {
  /** Whether the legacy 'AgentName' Run value is currently present in the registry. */
  legacyValuePresent: boolean
  /** Whether autostart was enabled, checked before the legacy value is touched. */
  autostartEnabled: boolean
}

export interface AutostartMigrationPlan {
  /** Remove the legacy 'AgentName' Run value. */
  deleteLegacy: boolean
  /** (Re)write the 'DwarfAI-Miners' Run value. */
  writeNew: boolean
}

/**
 * Pure decision table for the one-time 'AgentName' -> 'DwarfAI-Miners' Run
 * value rename.
 *
 * | legacyValuePresent | autostartEnabled | deleteLegacy | writeNew |
 * | ------------------ | ---------------- | ------------ | -------- |
 * | false               | false            | false        | false    |
 * | false               | true             | false        | false    |
 * | true                | false            | true         | false    |
 * | true                | true             | true         | true     |
 *
 * A legacy value, once found, is always removed (rows 3-4). The new value is
 * written only when autostart was actually on (row 4), so a user who had
 * opted out stays opted out under the new name. This is naturally
 * idempotent: once the legacy value is gone, every later startup observes
 * legacyValuePresent = false and does nothing further.
 */
export function planAutostartMigration(state: AutostartMigrationState): AutostartMigrationPlan {
  return {
    deleteLegacy: state.legacyValuePresent,
    writeNew: state.legacyValuePresent && state.autostartEnabled
  }
}

/**
 * Runs the one-time registry migration from the legacy 'AgentName' Run value
 * to 'DwarfAI-Miners'. Only for packaged builds — development runs never
 * touch the registry (see enable()/ensureDefaultAutostart()).
 */
export async function migrateLegacyAutostart(
  isPackaged: boolean,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error)
): Promise<void> {
  if (!isPackaged) return
  try {
    const legacyValuePresent = await queryRegistryValue(LEGACY_VALUE_NAME)
    // The legacy value's presence is the only "was autostart enabled" signal
    // available before it is removed, so both plan inputs share one read.
    const plan = planAutostartMigration({
      legacyValuePresent,
      autostartEnabled: legacyValuePresent
    })
    if (plan.deleteLegacy) await deleteRegistryValue(LEGACY_VALUE_NAME)
    if (plan.writeNew) await enable()
  } catch (error) {
    warn('[autostart] Failed to migrate legacy AgentName autostart entry:', error)
  }
}
