import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, writeFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'AgentName'
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
 * Registers AgentName in HKCU\...\CurrentVersion\Run.
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

export async function disable(): Promise<void> {
  try {
    await execFileAsync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
  } catch {
    // Value not present — already disabled.
  }
}

export async function isEnabled(): Promise<boolean> {
  try {
    await execFileAsync('reg', ['query', RUN_KEY, '/v', VALUE_NAME])
    return true
  } catch {
    return false
  }
}
