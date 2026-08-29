import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'AgentName'

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
 * GUARD: this is never called automatically — only the explicit "Start with
 * Windows" tray checkbox invokes it, so dev runs cannot silently register.
 * Default is OFF.
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
