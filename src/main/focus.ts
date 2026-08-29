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

/** Windows processes that own a focusable terminal window. */
export const WINDOWS_TERMINAL_HOSTS: ReadonlySet<string> = new Set([
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
 * terminal-host process, or null when the chain has none. The chain walk is
 * the same everywhere; only the set of names that count as a terminal differs
 * per platform (see platform/unixFocus.ts), so it is a parameter.
 */
export function selectFocusTargetPid(
  rows: ProcessRow[],
  startPid: number,
  hosts: ReadonlySet<string> = WINDOWS_TERMINAL_HOSTS
): number | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const visited = new Set<number>()
  let current = byPid.get(startPid)
  for (let depth = 0; current !== undefined && depth < MAX_CHAIN_DEPTH; depth++) {
    if (visited.has(current.pid)) return null
    visited.add(current.pid)
    if (hosts.has(current.name.toLowerCase())) return current.pid
    current = byPid.get(current.parentPid)
  }
  return null
}

/**
 * PowerShell that restores + foregrounds the main window of `targetPid`, then
 * verifies the switch actually happened.
 *
 * A plain `SetForegroundWindow` call from a background process (this app has
 * no window of its own) is silently denied by Windows most of the time — the
 * call can return true while the foreground window never changes. The
 * standard workaround is `AttachThreadInput`: temporarily sharing input state
 * with the thread that owns the current foreground window lifts the
 * restriction for the duration of the call. Because even that is not
 * guaranteed (e.g. the foreground-lock timeout), success is verified by
 * reading `GetForegroundWindow()` back and comparing it to the target handle
 * — the exit code reflects that comparison, not merely the API call result.
 */
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
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
if ([Win32.Native]::IsIconic($handle)) { [void][Win32.Native]::ShowWindow($handle, 9) }

$currentThreadId = [Win32.Native]::GetCurrentThreadId()
$foregroundWindow = [Win32.Native]::GetForegroundWindow()
$foregroundThreadId = [uint32]0
if ($foregroundWindow -ne [IntPtr]::Zero) {
  [void][Win32.Native]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundThreadId)
}
$attached = $false
if ($foregroundThreadId -ne 0 -and $foregroundThreadId -ne $currentThreadId) {
  $attached = [Win32.Native]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
}
try {
  [void][Win32.Native]::SetForegroundWindow($handle)
} finally {
  if ($attached) { [void][Win32.Native]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false) }
}

if ([Win32.Native]::GetForegroundWindow() -eq $handle) { exit 0 } else { exit 1 }
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
