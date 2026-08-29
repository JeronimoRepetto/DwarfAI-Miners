import { execFile } from 'node:child_process'

/**
 * Click-to-focus: given the pid of a CLI session (e.g. claude.exe), walk the
 * process ancestor chain to the hosting terminal window and bring it to the
 * foreground with user32. Command construction and chain selection are pure
 * and unit-tested; actually running PowerShell is integration-only.
 */

export interface ProcessRow {
  pid: number
  parentPid: number
  name: string
}

/** Result of running one PowerShell command. */
export interface ShellResult {
  stdout: string
  exitCode: number
}

export type ShellRunner = (command: string) => Promise<ShellResult>

/** Processes that own a focusable terminal window. */
const TERMINAL_HOSTS = new Set([
  'windowsterminal.exe',
  'conhost.exe',
  'code.exe',
  'wezterm-gui.exe',
  'alacritty.exe'
])

/** Safety bound for ancestor walking (also breaks parent-pid cycles). */
const MAX_CHAIN_DEPTH = 32

export function buildProcessQueryCommand(): string {
  return (
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
  )
}

/** Parse `ConvertTo-Json` output rows; single objects are wrapped, garbage -> []. */
export function parseProcessRows(json: unknown): ProcessRow[] {
  const items = Array.isArray(json) ? json : [json]
  const rows: ProcessRow[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (
      typeof record.ProcessId === 'number' &&
      typeof record.ParentProcessId === 'number' &&
      typeof record.Name === 'string'
    ) {
      rows.push({ pid: record.ProcessId, parentPid: record.ParentProcessId, name: record.Name })
    }
  }
  return rows
}

/**
 * Walk from `startPid` up the parent chain and return the pid of the first
 * terminal-host process, or null when the chain has none.
 */
export function selectFocusTargetPid(rows: ProcessRow[], startPid: number): number | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const visited = new Set<number>()
  let current = byPid.get(startPid)
  for (let depth = 0; current !== undefined && depth < MAX_CHAIN_DEPTH; depth++) {
    if (visited.has(current.pid)) return null
    visited.add(current.pid)
    if (TERMINAL_HOSTS.has(current.name.toLowerCase())) return current.pid
    current = byPid.get(current.parentPid)
  }
  return null
}

/** PowerShell that restores + foregrounds the main window of `targetPid`. */
export function buildFocusCommand(targetPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
$proc = Get-Process -Id ${targetPid}
$handle = $proc.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { exit 1 }
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
if ([Win32.Native]::IsIconic($handle)) { [void][Win32.Native]::ShowWindow($handle, 9) }
if ([Win32.Native]::SetForegroundWindow($handle)) { exit 0 } else { exit 1 }
`.trim()
}

function runPowerShell(command: string): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error) // spawn failure, not a non-zero exit
          return
        }
        resolve({ stdout, exitCode: error === null ? 0 : (error.code as number) })
      }
    )
  })
}

/**
 * Focus the terminal window hosting `pid`. Returns false when the chain has
 * no known terminal or the window cannot be foregrounded — the caller then
 * falls back to showing a live transcript feed instead.
 */
export async function focusPid(pid: number, run: ShellRunner = runPowerShell): Promise<boolean> {
  try {
    const query = await run(buildProcessQueryCommand())
    if (query.exitCode !== 0) return false
    const rows = parseProcessRows(JSON.parse(query.stdout))
    const targetPid = selectFocusTargetPid(rows, pid)
    if (targetPid === null) return false
    const focus = await run(buildFocusCommand(targetPid))
    return focus.exitCode === 0
  } catch {
    return false
  }
}
