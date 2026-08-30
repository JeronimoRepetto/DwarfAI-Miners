import { execFile } from 'node:child_process'

/**
 * Click-to-focus: given the pid of a CLI session (e.g. claude.exe), resolve
 * the terminal window hosting it and bring it to the foreground with user32.
 *
 * Two resolution strategies exist, tried in this order:
 *
 * 1. Console-window resolution (`buildConsoleWindowProbeCommand` +
 *    `parseConsoleWindowHandle`): AttachConsole(pid) + GetConsoleWindow()
 *    directly on the session's own pid. This is pid-exact — it needs no name
 *    matching — and is the only strategy that works for a host like Herdr,
 *    whose console-hosting process has no discoverable "main window" (its
 *    .NET-style MainWindowHandle stays 0) but does own a real console window
 *    shared with its whole process tree.
 * 2. Ancestor-name chain walk (`selectFocusTargetPid`): only reached when the
 *    console probe comes back with a zero handle (a genuinely headless
 *    session, or the attach failed), this walks the parent-pid chain looking
 *    for a process name known to host a focusable window.
 *
 * Command construction, parsing and the decision between the two strategies
 * are pure and unit-tested; actually running PowerShell is integration-only.
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

/**
 * Windows processes that own a focusable terminal window.
 *
 * herdr.exe is included as a defensive backstop even though, in practice, its
 * MainWindowHandle is 0 (so a name match here still cannot be foregrounded
 * through buildFocusCommand's Get-Process resolution) — the console-window
 * probe is what actually resolves it; see the module docstring.
 */
export const WINDOWS_TERMINAL_HOSTS: ReadonlySet<string> = new Set([
  'windowsterminal.exe',
  'conhost.exe',
  'code.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'herdr.exe'
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

/** Where to drive the hardened foreground sequence: an already-known window handle, or a pid to resolve via Get-Process. */
export type FocusTarget = { kind: 'handle'; handle: number } | { kind: 'pid'; pid: number }

/**
 * Decide how to focus the terminal hosting `startPid`.
 *
 * A nonzero console handle wins outright and short-circuits the ancestor
 * chain walk entirely — it is pid-exact, so there is nothing for the name
 * match to add. Only a zero handle (probe failed, or the session is
 * genuinely headless) falls through to `selectFocusTargetPid`. Both missing
 * means there is nothing to focus.
 */
export function resolveFocusTarget(
  consoleHandle: number,
  rows: ProcessRow[],
  startPid: number,
  hosts: ReadonlySet<string> = WINDOWS_TERMINAL_HOSTS
): FocusTarget | null {
  if (consoleHandle !== 0) return { kind: 'handle', handle: consoleHandle }
  const targetPid = selectFocusTargetPid(rows, startPid, hosts)
  return targetPid === null ? null : { kind: 'pid', pid: targetPid }
}

/**
 * PowerShell that resolves the console window handle owned by `targetPid`
 * directly, without any name matching.
 *
 * AttachConsole looks up the console *session* a pid belongs to, not a
 * window that pid itself created — so every process descending from one
 * console-hosting ancestor (as Herdr's claude.exe -> node.exe -> cmd.exe ->
 * powershell.exe -> herdr.exe chain does) resolves to the SAME console
 * window here, regardless of which pid in that chain is passed in. This is
 * why it works even for a host whose .NET-style MainWindowHandle is 0.
 *
 * FreeConsole() runs defensively first: a process can be attached to at most
 * one console at a time, and this Electron process may or may not already
 * have one of its own. Detaching first makes AttachConsole succeed
 * regardless of that starting state. It runs again after a successful
 * attach so this process is left with no console attached, same as it
 * started.
 */
export function buildConsoleWindowProbeCommand(targetPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
'@
[void][Win32.Console]::FreeConsole()
$handle = [IntPtr]::Zero
if ([Win32.Console]::AttachConsole(${targetPid})) {
  $handle = [Win32.Console]::GetConsoleWindow()
  [void][Win32.Console]::FreeConsole()
}
[Console]::Out.Write([int64]$handle)
`.trim()
}

/** Parse the handle `buildConsoleWindowProbeCommand` prints to stdout; malformed, blank, or non-positive output means "no handle". */
export function parseConsoleWindowHandle(stdout: string): number {
  const trimmed = stdout.trim()
  if (trimmed === '') return 0
  const value = Number(trimmed)
  return Number.isInteger(value) && value > 0 ? value : 0
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
/**
 * Shared user32 dance: given a PowerShell statement (or statements) that
 * assigns `$handle`, restore the window if minimized, then force it to the
 * foreground using the AttachThreadInput trick, verifying success by reading
 * GetForegroundWindow() back. Used both when the target is resolved via
 * Get-Process (buildFocusCommand) and when it is already a known
 * console-window handle (buildFocusHandleCommand) — the foreground sequence
 * itself never changes, only how `$handle` gets its value.
 */
function buildForegroundSequence(handleAssignment: string): string {
  return `
$ErrorActionPreference = 'Stop'
${handleAssignment}
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

export function buildFocusCommand(targetPid: number): string {
  return buildForegroundSequence(
    `$proc = Get-Process -Id ${targetPid}\n$handle = $proc.MainWindowHandle`
  )
}

/**
 * Same hardened foreground sequence as buildFocusCommand, but driven
 * directly off an already-resolved window handle (from the console-window
 * probe) instead of resolving one through Get-Process.
 */
export function buildFocusHandleCommand(handle: number): string {
  return buildForegroundSequence(`$handle = [IntPtr]${handle}`)
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
 * Focus the terminal window hosting `pid`. Returns false when neither
 * resolution strategy finds a window or the window cannot be foregrounded —
 * the caller then falls back to showing a live transcript feed instead.
 *
 * The console-window probe runs first and, on a hit, skips the process-list
 * query and ancestor chain walk entirely (see resolveFocusTarget); the
 * process list is only queried when that probe comes back empty.
 */
export async function focusPid(pid: number, run: ShellRunner = runPowerShell): Promise<boolean> {
  try {
    const probe = await run(buildConsoleWindowProbeCommand(pid))
    const consoleHandle = probe.exitCode === 0 ? parseConsoleWindowHandle(probe.stdout) : 0

    let rows: ProcessRow[] = []
    if (consoleHandle === 0) {
      const query = await run(buildProcessQueryCommand())
      if (query.exitCode !== 0) return false
      rows = parseProcessRows(JSON.parse(query.stdout))
    }

    const target = resolveFocusTarget(consoleHandle, rows, pid)
    if (target === null) return false

    const focus = await run(
      target.kind === 'handle'
        ? buildFocusHandleCommand(target.handle)
        : buildFocusCommand(target.pid)
    )
    return focus.exitCode === 0
  } catch {
    return false
  }
}
