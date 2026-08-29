import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * WQL-side probe for a live Codex CLI process. The probing powershell.exe's
 * own CommandLine contains this very query text (and therefore the string
 * "codex"), so the filter MUST exclude the probe's own process and every
 * PowerShell host — otherwise the probe always matches itself and reports
 * codex as running unconditionally. Exported so tests can pin these guards.
 */
export const CODEX_PROBE_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { ' +
  "$_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh)' " +
  "-and ($_.Name -match 'codex' -or $_.CommandLine -match 'codex') } " +
  '| Select-Object -First 1 -ExpandProperty ProcessId'

/**
 * True when a process whose name or command line mentions "codex" is
 * currently running. Codex CLI sessions have no pid/lock file, so this is
 * the only way to tell an idle-but-open TUI from a closed one. Windows-only
 * (this app ships for Windows); any failure (PowerShell missing, timeout,
 * access denied) is treated as "unknown" and reported as not running rather
 * than blocking or throwing.
 */
export async function isCodexProcessRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', CODEX_PROBE_SCRIPT],
      { timeout: 5_000, windowsHide: true }
    )
    return stdout.trim() !== ''
  } catch {
    return false
  }
}
