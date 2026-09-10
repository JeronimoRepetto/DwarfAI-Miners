import { execFile } from 'node:child_process'

/**
 * Click-to-focus: given the pid of a CLI session (e.g. claude.exe), resolve
 * the terminal window hosting it and bring it to the foreground with user32.
 *
 * Resolution is one probe, then one walk:
 *
 * 1. Console-window resolution (`buildConsoleWindowProbeCommand` +
 *    `parseConsoleWindowProbe`): AttachConsole(pid) + GetConsoleWindow()
 *    directly on the session's own pid. This is pid-exact — it needs no name
 *    matching — and is the only strategy that works for a host like Herdr,
 *    whose console-hosting process has no discoverable "main window" (its
 *    .NET-style MainWindowHandle stays 0) but does own a real console window
 *    shared with its whole process tree. A visible hit ends resolution — but
 *    not necessarily as the session's OWN window: where another window owns
 *    that console it is a tab, and resolution then counts the host's tabs
 *    before calling it anything (issue #371).
 * 2. The ancestor walk (`planFocusCandidates`): only reached when that window
 *    is hidden or absent, this climbs the parent-pid chain once, nearest
 *    first, and each rung is one of two things. A process name known to host
 *    a focusable window of its own (Windows Terminal, VS Code) is the target
 *    and ends the walk; any other ancestor has its own console window probed,
 *    because a classic cmd.exe console is visible on the shell and its
 *    children while the session's own pid reports a hidden one (issue #190).
 *
 * Command construction, parsing and the plan for the walk are pure and
 * unit-tested; actually running PowerShell is integration-only.
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
 *
 * conhost.exe is listed for the same reason and is just as academic: a classic
 * console's conhost is a *child* of the process that owns the console, never
 * an ancestor of the session, so the walk cannot meet it. The window a cmd.exe
 * session is seen in is reached by probing the shell's console instead
 * (issue #190).
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

/**
 * How many ancestors may have their console window probed before the walk
 * stops paying for probes. Each one is a fresh PowerShell process — roughly
 * 200 ms — spent on a focus step the person is waiting on before a single
 * keystroke lands, and the shape that needs a probe is short: in a classic
 * cmd.exe console the visible window belongs to the very next rung
 * (claude.exe <- node.exe <- cmd.exe, issue #190), so two rungs cover one
 * wrapper between the two and the third is spare. Past that the chain is into
 * explorer.exe and service hosts, which own no console a probe could find;
 * the walk goes on matching hosts by name there, which costs nothing.
 */
const MAX_ANCESTOR_CONSOLE_PROBES = 3

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
 * The process chain from `startPid` up through its parents — `startPid` first,
 * ending at a pid the table does not list, a parent-pid cycle, or the depth
 * bound. Every ancestor walk in this module and in platform/unixFocus.ts is a
 * pass over this one chain, so the cycle and depth rules live here alone.
 */
export function processChain(rows: ProcessRow[], startPid: number): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const visited = new Set<number>()
  const chain: ProcessRow[] = []
  let current = byPid.get(startPid)
  while (current !== undefined && chain.length < MAX_CHAIN_DEPTH && !visited.has(current.pid)) {
    visited.add(current.pid)
    chain.push(current)
    current = byPid.get(current.parentPid)
  }
  return chain
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
  for (const process of processChain(rows, startPid)) {
    if (hosts.has(process.name.toLowerCase())) return process.pid
  }
  return null
}

/**
 * Where to drive the hardened foreground sequence: an already-known window
 * handle, or a pid to resolve via Get-Process.
 *
 * The two kinds are not interchangeable for a KEYSTROKE, which is what #329
 * cost. A `handle` is a console window the session is on, alone or with the
 * shell that launched it. A `pid` is a terminal HOST, and a host draws several
 * sessions in tabs of one window: foregrounding it raises whichever tab the
 * person last used, so a keystroke sent afterwards lands in whatever session
 * that happens to be. `FocusReach` below is that distinction travelling out to
 * the caller.
 *
 * A `pid` is no longer only ever a host matched BY NAME up the ancestor chain
 * (issue #371). It is also the process owning the window that owns a phantom
 * console — the same refusal, reached through the same `buildFocusCommand`,
 * for a host the name walk never meets because the phantom short-circuits it.
 */
export type FocusTarget = { kind: 'handle'; handle: number } | { kind: 'pid'; pid: number }

/**
 * Which window a focus attempt actually brought forward (#329).
 *
 * `own-console` is a console window this session is on — its own, or the one it
 * shares with the shell that launched it (#190). Nothing else is drawn there,
 * so a keystroke afterwards reaches this session.
 *
 * `terminal-host` is a window that draws many sessions in tabs of its own:
 * Windows Terminal, VS Code. It exposes no way to select a tab by pid, so the
 * panel cannot tell which one is in front. Enough for click-to-focus, never
 * enough for a keystroke.
 *
 * The line between them is NOT "found by probe" versus "found by the ancestor
 * walk", and reading it that way is what #371 cost. A probed handle can be a
 * phantom console OWNED by a Windows Terminal window, and then it is a tab like
 * any other; it earns `own-console` only where that owner is proven to draw
 * this one console and no other. See `resolveFocusTarget`.
 */
export type FocusReach = 'own-console' | 'terminal-host'

export interface FocusOutcome {
  /** Whether any window came forward at all. */
  focused: boolean
  /** Which one did; null when none did, so there is nothing to be sure about. */
  reach: FocusReach | null
}

/**
 * One rung of the walk `focusPid` climbs once the session's own console window
 * has turned out hidden or absent. `console` asks for that ancestor's console
 * window to be probed, a visible one being the target; `host` names a process
 * known to draw the session in a window of its own, foregrounded through its
 * main window handle without any probe.
 */
export type FocusCandidate = { kind: 'console'; pid: number } | { kind: 'host'; pid: number }

/**
 * Plan the walk up from `startPid`, nearest ancestor first, for when its own
 * console window is out of the running.
 *
 * One pass, and each rung is one of two things. A named terminal host is the
 * target and ends the walk: it draws the session inside a window of its own —
 * Windows Terminal's tab, VS Code's panel — so the classic console every
 * process beneath it shares is hidden by design, and nothing above it can own
 * the window the person sees (issue #182). Any other ancestor gets its console
 * window probed, because in a classic cmd.exe console the shell and its
 * children sit on a visible console while the session's own pid reports a
 * hidden one (issue #190). Probes stop at MAX_ANCESTOR_CONSOLE_PROBES rungs;
 * the name match carries on past that for free.
 *
 * `startPid` itself is only ever matched by name here — its console was probed
 * before this plan was asked for, and once is enough.
 *
 * Pure on purpose: the probes it asks for run in `focusPid`, so the order and
 * the bound are tested without PowerShell.
 */
export function planFocusCandidates(
  rows: ProcessRow[],
  startPid: number,
  hosts: ReadonlySet<string> = WINDOWS_TERMINAL_HOSTS
): FocusCandidate[] {
  const candidates: FocusCandidate[] = []
  let probes = 0
  for (const process of processChain(rows, startPid)) {
    if (hosts.has(process.name.toLowerCase())) {
      candidates.push({ kind: 'host', pid: process.pid })
      break
    }
    if (process.pid === startPid || probes >= MAX_ANCESTOR_CONSOLE_PROBES) continue
    candidates.push({ kind: 'console', pid: process.pid })
    probes++
  }
  return candidates
}

/**
 * PowerShell that resolves the console window handle owned by `targetPid`
 * directly, without any name matching.
 *
 * AttachConsole looks up the console *session* a pid belongs to, not a
 * window that pid itself created — so processes sharing one console-hosting
 * ancestor (as Herdr's claude.exe -> node.exe -> cmd.exe -> powershell.exe ->
 * herdr.exe chain does) resolve to the SAME console window here, whichever
 * of them is passed in. This is why it works even for a host whose .NET-style
 * MainWindowHandle is 0. It is not a guarantee for the whole chain, though:
 * measured live in a classic cmd.exe console, claude.exe reported a hidden
 * console of its own while node.exe and cmd.exe above it shared the visible
 * one (issue #190) — which is why `focusPid` probes the ancestors too.
 *
 * FreeConsole() runs defensively first: a process can be attached to at most
 * one console at a time, and this Electron process may or may not already
 * have one of its own. Detaching first makes AttachConsole succeed
 * regardless of that starting state. It runs again after a successful
 * attach so this process is left with no console attached, same as it
 * started.
 *
 * IsWindowVisible runs on the resolved handle before FreeConsole detaches,
 * because AttachConsole finds the console *session*, not a window this pid
 * necessarily owns visibly: Windows Terminal keeps its classic console
 * window hidden and draws the session in its own tab, so this probe still
 * returns a real, nonzero handle for it (issue #182). The script reports
 * that visibility alongside the handle rather than deciding on it itself, so
 * the decision stays in `parseConsoleWindowProbe` — pure and unit-tested
 * without PowerShell, like everything else this probe hands back.
 *
 * `GetAncestor(GA_ROOTOWNER)` and the owner's pid are reported for issue #371.
 * A visible console window is NOT proof the session is alone on it: under the
 * Windows 11 default-terminal handoff the window this resolves is a ConPTY
 * `PseudoConsoleWindow` phantom OWNED by the Windows Terminal window, so an
 * owner different from the handle means "this console is a tab in somebody
 * else's window". The owner's pid comes back too because the refusal path
 * foregrounds that host through `buildFocusCommand`, which resolves a pid.
 * Both are printed rather than decided on here, same as visibility.
 */
export function buildConsoleWindowProbeCommand(targetPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
'@
[void][Win32.Console]::FreeConsole()
$handle = [IntPtr]::Zero
$visible = $false
$owner = [IntPtr]::Zero
$ownerPid = [uint32]0
if ([Win32.Console]::AttachConsole(${targetPid})) {
  $handle = [Win32.Console]::GetConsoleWindow()
  if ($handle -ne [IntPtr]::Zero) {
    $visible = [Win32.Console]::IsWindowVisible($handle)
    $owner = [Win32.Console]::GetAncestor($handle, 3)
    if ($owner -ne [IntPtr]::Zero) {
      [void][Win32.Console]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
    }
  }
  [void][Win32.Console]::FreeConsole()
}
[Console]::Out.Write("$([int64]$handle) $(if ($visible) { 1 } else { 0 }) $([int64]$owner) $([int64]$ownerPid)")
`.trim()
}

/**
 * What the console-window probe found: a window to foreground, and whether
 * another window owns it.
 *
 * `handle` is 0 for "nothing here to act on", which is every kind of miss at
 * once — no console, an invisible one, or output this parser could not read.
 * `owner` is non-null only for a console some OTHER window owns, and then it
 * names that window both ways, because the two facts are only useful together:
 * the handle decides what a tab count is asked about, the pid is what the host
 * is foregrounded through.
 */
export interface ConsoleWindowProbe {
  handle: number
  owner: { handle: number; pid: number } | null
}

const NO_CONSOLE_WINDOW: ConsoleWindowProbe = { handle: 0, owner: null }

/**
 * Parse what `buildConsoleWindowProbeCommand` prints to stdout
 * ("<handle> <0|1> <rootOwner> <rootOwnerPid>"); malformed, blank,
 * non-positive, or invisible output all mean "no handle".
 *
 * A nonzero handle that IsWindowVisible rejects is the Windows Terminal case
 * (issue #182): a real console window that can never be foregrounded, so it
 * has to be indistinguishable here from a probe that found nothing at all —
 * that is what sends `focusPid` on to the ancestor walk instead of driving
 * the foreground sequence at a window that will only fail its verification.
 *
 * `GA_ROOTOWNER` answers the handle itself when nothing owns the window, which
 * is how an ordinary console reads as unowned with no extra flag. Everything
 * about the owner fails CLOSED (issue #371), and in the same direction each
 * time: fewer fields than the script prints, an unreadable owner, or an owner
 * whose process cannot be named all answer "no handle" rather than "unowned".
 * The reason is asymmetric cost — reading an owned phantom as unowned is what
 * lets a keystroke into a stranger's tab, while a spurious miss only costs a
 * fall-through to the ancestor walk.
 */
export function parseConsoleWindowProbe(stdout: string): ConsoleWindowProbe {
  const trimmed = stdout.trim()
  if (trimmed === '') return NO_CONSOLE_WINDOW
  const parts = trimmed.split(/\s+/)
  if (parts.length < 4) return NO_CONSOLE_WINDOW
  const [handlePart, visiblePart, ownerPart, ownerPidPart] = parts
  const handle = Number(handlePart)
  if (!Number.isInteger(handle) || handle <= 0) return NO_CONSOLE_WINDOW
  if (visiblePart !== '1') return NO_CONSOLE_WINDOW
  const owner = Number(ownerPart)
  if (!Number.isInteger(owner) || owner <= 0) return NO_CONSOLE_WINDOW
  if (owner === handle) return { handle, owner: null }
  const ownerPid = Number(ownerPidPart)
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return NO_CONSOLE_WINDOW
  return { handle, owner: { handle: owner, pid: ownerPid } }
}

/**
 * The window class of a ConPTY console phantom, measured live rather than
 * documented anywhere: 2026-09-10, three of them under one Windows Terminal
 * window (see `docs/console-hosting.md` §6). One phantom is one console, so
 * counting them under a host counts its tabs.
 */
export const CONSOLE_PHANTOM_WINDOW_CLASS = 'PseudoConsoleWindow'

/**
 * PowerShell that counts the console phantoms `ownerHandle` owns — how many
 * consoles that one host window is drawing (issue #371).
 *
 * The probe above says a console is a tab; it cannot say whether the host has
 * any OTHER tab, and that is the whole question a keystroke turns on. user32
 * exposes no way to map a tab to a pid — which is why #329 refuses a host at
 * all — but every ConPTY console under a host has a top-level phantom window
 * of its own, so the tabs are COUNTABLE even though they are not addressable.
 * `EnumWindows` + `GetClassName` + `GetAncestor(GA_ROOTOWNER)` is the count.
 *
 * Read-only user32 throughout, deliberately: this runs on the path to a
 * keystroke, so it may raise no window and press no key. Hidden phantoms are
 * counted along with visible ones — a console the host is not currently showing
 * is still a console the host could put in front, and counting fewer is the
 * direction that lets a keystroke through.
 */
export function buildConsoleSiblingProbeCommand(ownerHandle: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win32 -Name Siblings -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, System.IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint gaFlags);
'@
$owner = [int64]${ownerHandle}
$found = New-Object System.Collections.ArrayList
$callback = [Win32.Siblings+EnumProc] {
  param($hWnd, $lParam)
  $name = New-Object System.Text.StringBuilder 64
  [void][Win32.Siblings]::GetClassName($hWnd, $name, 64)
  if ($name.ToString() -eq '${CONSOLE_PHANTOM_WINDOW_CLASS}' -and [int64][Win32.Siblings]::GetAncestor($hWnd, 3) -eq $owner) {
    [void]$found.Add([int64]$hWnd)
  }
  return $true
}
if (-not [Win32.Siblings]::EnumWindows($callback, [System.IntPtr]::Zero)) { exit 1 }
[Console]::Out.Write("$($found.Count) $(if ($found.Count -eq 0) { '-' } else { $found -join ',' })")
`.trim()
}

/**
 * Parse the count `buildConsoleSiblingProbeCommand` prints ("<count>
 * <handle>,<handle>"); the handles are for the record and are not read.
 *
 * `null` is "cannot answer", and it is a different answer from 0 on purpose:
 * the caller refuses on it rather than reasoning from a number it never got.
 */
export function parseConsoleSiblingCount(stdout: string): number | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  const count = Number(trimmed.split(/\s+/)[0])
  if (!Number.isInteger(count) || count < 0) return null
  return count
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
 * reading `GetForegroundWindow()` back — the exit code reflects what actually
 * holds the foreground afterwards, not merely the API call result.
 */
/**
 * Shared user32 dance: given a PowerShell statement (or statements) that
 * assigns `$handle`, restore the window if minimized, then force it to the
 * foreground using the AttachThreadInput trick, verifying success by reading
 * GetForegroundWindow() back. Used both when the target is resolved via
 * Get-Process (buildFocusCommand) and when it is already a known
 * console-window handle (buildFocusHandleCommand) — the foreground sequence
 * itself never changes, only how `$handle` gets its value.
 *
 * Two details here are the whole of issue #190's second round, and both were
 * measured live rather than reasoned about:
 *
 * 1. **The thread id is `GetWindowThreadProcessId`'s return value**, not its
 *    out parameter — the out parameter is the *process* id. The sequence read
 *    them the wrong way round, so `AttachThreadInput` was handed a process id
 *    and returned false: the mitigation described above had never run. Live,
 *    against a foreground explorer window, the out parameter gave 39872
 *    (explorer's pid) where the return value gave 31976 (its foreground
 *    thread), and attaching succeeded only with the second. The attach is also
 *    what makes the read-back below meaningful: without it, the switch is still
 *    in flight and `GetForegroundWindow()` answered `0` immediately after
 *    `SetForegroundWindow` in every attempt measured.
 * 2. **Success is the foreground reaching the target _or the window that owns
 *    it_.** Under the Windows 11 default-terminal handoff a session's console
 *    window is a ConPTY `PseudoConsoleWindow` phantom, and foregrounding it
 *    raises the terminal that owns it instead — live, target 133320 against a
 *    foreground of 133266, the real `CASCADIA_HOSTING_WINDOW_CLASS` window of
 *    WindowsTerminal.exe. Exact handle equality read that as a failure and the
 *    message fell back to the relay. `GetAncestor(GA_ROOTOWNER)` returns the
 *    handle itself when nothing owns it, so a window with no owner still
 *    verifies exactly as it did before.
 *
 * The visibility check on top of that is not decoration. Text delivery types
 * into whatever holds the foreground (`buildSendKeysCommand` in
 * textDelivery/sendKeys.ts), so accepting an invisible window would send
 * keystrokes somewhere nobody can see. Widening the comparison to the owner
 * must not widen it to a hidden window.
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
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
if ([Win32.Native]::IsIconic($handle)) { [void][Win32.Native]::ShowWindow($handle, 9) }

$currentThreadId = [Win32.Native]::GetCurrentThreadId()
$foregroundWindow = [Win32.Native]::GetForegroundWindow()
$foregroundThreadId = [uint32]0
$foregroundProcessId = [uint32]0
if ($foregroundWindow -ne [IntPtr]::Zero) {
  $foregroundThreadId = [Win32.Native]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
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

$foregroundAfter = [Win32.Native]::GetForegroundWindow()
$targetRootOwner = [Win32.Native]::GetAncestor($handle, 3)
$reachedTarget = $foregroundAfter -eq $handle -or $foregroundAfter -eq $targetRootOwner
if ($reachedTarget -and [Win32.Native]::IsWindowVisible($foregroundAfter)) { exit 0 } else { exit 1 }
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
 * Resolve the window to foreground for the session `pid`: its own console
 * window when that is visible, else the first rung of `planFocusCandidates`
 * that yields one — a visible ancestor console, or a named host. Null when
 * the walk runs out, which means there is nothing to focus.
 *
 * The process list is only queried once the session's own probe has missed,
 * so the common pid-exact hit costs one PowerShell process and no walk. A
 * console nothing owns still costs exactly that: the tab count of #371 is
 * asked only where there is an owner to ask about.
 *
 * Exported for #329: which of the two kinds it lands on decides whether a
 * keystroke may follow the focus, so that answer is worth a pure test of its
 * own rather than only being observable through a foreground command.
 */
export async function resolveFocusTarget(
  pid: number,
  run: ShellRunner
): Promise<FocusTarget | null> {
  const probeConsole = async (targetPid: number): Promise<ConsoleWindowProbe> => {
    const probe = await run(buildConsoleWindowProbeCommand(targetPid))
    return probe.exitCode === 0 ? parseConsoleWindowProbe(probe.stdout) : NO_CONSOLE_WINDOW
  }

  /**
   * Turn one probe result into a target, which is where a console handle earns
   * the name "own" or loses it (issue #371).
   *
   * A console nothing owns is the session's, as it always was. An owned one is
   * a tab in somebody's window, and only the tab COUNT can say whether that
   * somebody is drawing anything else: exactly one means the host has this
   * console and no other, so it is ours in every sense a keystroke cares
   * about, and it is foregrounded on the phantom exactly as before — Windows
   * raises the owner (#190) and the widened verification passes.
   *
   * Anything else answers the owner's pid, which is `terminal-host` at the
   * caller and lands every keystroke on #329's shared-window refusal. That
   * includes a count this probe could not get: an unanswered count is the one
   * case this module must never resolve optimistically, because a keystroke
   * into an unknown tab is delivered into a stranger's session and cannot be
   * taken back, while refusing costs only the relay.
   */
  const classify = async (probe: ConsoleWindowProbe): Promise<FocusTarget | null> => {
    if (probe.handle === 0) return null
    if (probe.owner === null) return { kind: 'handle', handle: probe.handle }
    const count = await run(buildConsoleSiblingProbeCommand(probe.owner.handle))
    const siblings = count.exitCode === 0 ? parseConsoleSiblingCount(count.stdout) : null
    if (siblings === 1) return { kind: 'handle', handle: probe.handle }
    return { kind: 'pid', pid: probe.owner.pid }
  }

  const own = await classify(await probeConsole(pid))
  if (own !== null) return own

  const query = await run(buildProcessQueryCommand())
  if (query.exitCode !== 0) return null
  const rows = parseProcessRows(JSON.parse(query.stdout))

  for (const candidate of planFocusCandidates(rows, pid)) {
    if (candidate.kind === 'host') return { kind: 'pid', pid: candidate.pid }
    const ancestor = await classify(await probeConsole(candidate.pid))
    if (ancestor !== null) return ancestor
  }
  return null
}

/**
 * Focus the window hosting `pid` and say WHICH window that was (#329).
 *
 * `focused: false` means resolution found no window or the window would not
 * come forward — the caller then falls back to showing a live transcript feed
 * instead. `reach` is what a caller about to send a keystroke has to read: see
 * `FocusReach`, and `windowsTextDelivery.ts` for the refusal it drives.
 */
export async function focusSessionConsole(
  pid: number,
  run: ShellRunner = runPowerShell
): Promise<FocusOutcome> {
  try {
    const target = await resolveFocusTarget(pid, run)
    if (target === null) return { focused: false, reach: null }

    // A pid target is a terminal host — named up the ancestor chain, or owning
    // the window that owns a phantom console with more than one tab under it
    // (#371) — which is why it is the shared-window case and a handle is not.
    // `resolveFocusTarget` holds the whole of that decision; see FocusTarget.
    const reach: FocusReach = target.kind === 'handle' ? 'own-console' : 'terminal-host'
    const focus = await run(
      target.kind === 'handle'
        ? buildFocusHandleCommand(target.handle)
        : buildFocusCommand(target.pid)
    )
    return focus.exitCode === 0 ? { focused: true, reach } : { focused: false, reach: null }
  } catch {
    return { focused: false, reach: null }
  }
}

/**
 * Focus the terminal window hosting `pid`. Returns false when resolution finds
 * no window or the window cannot be foregrounded — the caller then falls back
 * to showing a live transcript feed instead.
 *
 * Still a boolean, deliberately: this is click-to-focus, and somebody who
 * clicked to see the terminal is served by either window (#329). Only a caller
 * about to type needs `focusSessionConsole` above.
 */
export async function focusPid(pid: number, run: ShellRunner = runPowerShell): Promise<boolean> {
  return (await focusSessionConsole(pid, run)).focused
}
