// Windows detach (ADR-002 D6; 13 FM-012, FM-114; spike-results/SP-02.md): the Host MUST start
// outside every job object the UI may be in and without a console window. Node's own spawn cannot
// (SP-02 finding 1: a `detached` child stays in the UI's job and carries DETACHED_PROCESS), so the
// Host is created by one launcher step, Windows PowerShell 5.1 by path (as the Host's own probes
// run it, privilege.ts), whose script does what SP-02 recorded:
//
// 1. CreateProcessW with CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
//    suspended, with no inherited handles (clean stdio) and the Host's environment block. SP-02
//    finding 2: in nested jobs breakaway can succeed yet leave the child in the UI's job, so the
//    child is checked with IsProcessInJob and resumed only when it is outside every job; still in a
//    job (or ERROR_ACCESS_DENIED from the create) counts as refused and the child is ended.
// 2. When breakaway is refused: WMI Win32_Process.Create with a hidden window (ShowWindow = 0),
//    which creates the process outside the job. WMI hands the new process exactly the environment
//    it is given (measured for ISSUE-030: without EnvironmentVariables it gets the user's registry
//    environment, with them only those, and the WMI service's working folder unless one is set),
//    so the whole environment and the working folder are always passed explicitly.
// 3. DETACHED_PROCESS is never used (D6 item 3).
//
// The step then watches the Host it started for up to HOST_WATCH_MS and prints its exit code if it
// exits, so a Host refusal (ALREADY_RUNNING, ELEVATED_REFUSED) reaches the launcher; release() ends
// the watch. The Host itself is no child of the UI, so ending the step never touches it.
//
// What the step is told — command line, working folder, environment — goes on its stdin as JSON,
// never in its argv (02 NFR-SEC-05). Its argv holds the fixed script only (-EncodedCommand), and
// its own environment drops PSModulePath (a PowerShell 7 value breaks 5.1's module autoload,
// ISSUE-315). It runs with `shell: false` and `windowsHide: true` (R17).
//
// It prints one line per fact: `launched breakaway|wmi <pid>`, `refused <code>` (breakaway refused,
// WMI follows), `in-job <code>` (breakaway refused and WMI failed), `failed <code>` and
// `exit <code>`. The pid stays inside the launcher: it is never logged (19 §9.1).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { HostSpawnRequest, HostSpawner, LaunchOutcome, LaunchedHost } from './ports'

/** Node's `spawn`, injectable so the spawners' own tests see every option. */
export type SpawnProcess = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

/** Process creation flags (Win32 `CreateProcessW` dwCreationFlags). */
export const CREATE_SUSPENDED = 0x0000_0004
export const CREATE_NEW_PROCESS_GROUP = 0x0000_0200
export const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400
export const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000
export const CREATE_NO_WINDOW = 0x0800_0000

/** The breakaway step's flags: ADR-002 D6 item 1, created suspended for the SP-02 job check. */
export const BREAKAWAY_CREATION_FLAGS =
  CREATE_SUSPENDED |
  CREATE_UNICODE_ENVIRONMENT |
  CREATE_BREAKAWAY_FROM_JOB |
  CREATE_NEW_PROCESS_GROUP |
  CREATE_NO_WINDOW

/** How long the step reports the Host's exit: the readiness budget with its migrating extension. */
export const HOST_WATCH_MS = 60_000

/**
 * How long the step may take to report a launch. The package names none; SP-02 measured the whole
 * launcher (process start included) at 73–134 ms, and PowerShell's Add-Type adds about 500 ms
 * warm here; 10 s leaves room for a cold start without eating the 15 s readiness budget.
 */
export const LAUNCH_REPORT_TIMEOUT_MS = 10_000

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace DwarfAI {
  public static class HostLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
      uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    static IntPtr watched = IntPtr.Zero;
    public static int Pid = 0;

    // ADR-002 D6 item 1 with the SP-02 job check. Returns "launched", "refused <code>" or "failed <code>".
    public static string Breakaway(string file, string commandLine, string dir, string environment, uint flags) {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      PROCESS_INFORMATION pi;
      IntPtr block = Marshal.StringToHGlobalUni(environment);
      try {
        if (!CreateProcessW(file, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, block, dir,
            ref si, out pi)) {
          int error = Marshal.GetLastWin32Error();
          return (error == 5 ? "refused CREATE_" : "failed CREATE_") + error;
        }
      } finally {
        Marshal.FreeHGlobal(block);
      }
      bool inJob;
      if (!IsProcessInJob(pi.hProcess, IntPtr.Zero, out inJob) || inJob) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return "refused STILL_IN_JOB";
      }
      ResumeThread(pi.hThread);
      CloseHandle(pi.hThread);
      watched = pi.hProcess;
      Pid = pi.dwProcessId;
      return "launched";
    }

    // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION: enough to wait for a WMI-created Host and read its exit code.
    public static void Watch(int pid) {
      watched = OpenProcess(0x00101000, false, pid);
    }

    // The exit code, or -1 when the Host still runs after ms, -2 when it cannot be watched.
    public static long WaitForExit(uint ms) {
      if (watched == IntPtr.Zero) return -2;
      try {
        if (WaitForSingleObject(watched, ms) != 0) return -1;
        uint code;
        return GetExitCodeProcess(watched, out code) ? (long)code : -2;
      } finally {
        CloseHandle(watched);
        watched = IntPtr.Zero;
      }
    }
  }
}
`

/** The launcher step's script; only constants are put into it, never a request value. */
export function launcherScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }',
    'try {',
    '  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    "  Add-Type -TypeDefinition @'",
    CSHARP.trim(),
    "'@",
    "} catch { Say 'failed LAUNCHER_SETUP'; exit 2 }",
    `$creationFlags = 0x${BREAKAWAY_CREATION_FLAGS.toString(16).toUpperCase().padStart(8, '0')}`,
    `$watchMs = ${HOST_WATCH_MS}`,
    '$nul = [string][char]0',
    '$environment = ([string[]]$request.env -join $nul) + $nul + $nul',
    'try {',
    '  $result = [DwarfAI.HostLauncher]::Breakaway($request.file, $request.commandLine, $request.cwd, $environment, $creationFlags)',
    "} catch { Say 'failed BREAKAWAY_ERROR'; exit 2 }",
    "if ($result -eq 'launched') {",
    "  Say ('launched breakaway ' + [DwarfAI.HostLauncher]::Pid)",
    "} elseif ($result.StartsWith('refused ')) {",
    '  Say $result',
    '  try {',
    '    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$request.env }',
    '    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $request.commandLine; CurrentDirectory = $request.cwd; ProcessStartupInformation = $startup }',
    "  } catch { Say 'in-job WMI_ERROR'; exit 3 }",
    "  if ($created.ReturnValue -ne 0) { Say ('in-job WMI_' + $created.ReturnValue); exit 3 }",
    '  [DwarfAI.HostLauncher]::Watch([int]$created.ProcessId)',
    "  Say ('launched wmi ' + $created.ProcessId)",
    '} else {',
    '  Say $result',
    '  exit 2',
    '}',
    '$code = [DwarfAI.HostLauncher]::WaitForExit($watchMs)',
    "if ($code -ge 0) { Say ('exit ' + $code) }"
  ].join('\n')
}

/**
 * One argument quoted for a Windows command line, read back by CommandLineToArgvW and the C
 * runtime: always quoted, backslashes doubled only where they precede a quote, quotes escaped.
 */
export function quoteWindowsArg(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    out += char === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + char
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

export function windowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteWindowsArg).join(' ')
}

/**
 * The environment as `NAME=value` strings, sorted by name ignoring case (the order an environment
 * block is expected in). Names that are empty or hold `=` (the per-drive `=C:` entries) and values
 * holding NUL cannot be written to a block and are left out.
 */
export function environmentList(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => name !== '' && !name.includes('=') && !value.includes('\0'))
    .sort(([a], [b]) => {
      const left = a.toUpperCase()
      const right = b.toUpperCase()
      return left < right ? -1 : left > right ? 1 : 0
    })
    .map(([name, value]) => `${name}=${value}`)
}

export type LauncherLine =
  | { kind: 'launched'; how: 'breakaway' | 'wmi' }
  | { kind: 'refused'; code: string }
  | { kind: 'in-job'; code: string }
  | { kind: 'failed'; code: string }
  | { kind: 'exit'; code: number }

const CODE = '([A-Za-z0-9_.:-]{1,64})'
const LINES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => LauncherLine]> = [
  [
    /^launched (breakaway|wmi) \d+$/,
    (m) => ({ kind: 'launched', how: m[1] as 'breakaway' | 'wmi' })
  ],
  [new RegExp(`^refused ${CODE}$`), (m) => ({ kind: 'refused', code: m[1] as string })],
  [new RegExp(`^in-job ${CODE}$`), (m) => ({ kind: 'in-job', code: m[1] as string })],
  [new RegExp(`^failed ${CODE}$`), (m) => ({ kind: 'failed', code: m[1] as string })],
  [/^exit (\d{1,10})$/, (m) => ({ kind: 'exit', code: Number(m[1]) })]
]

/** One line the step printed, or null for anything else. */
export function parseLauncherLine(line: string): LauncherLine | null {
  const trimmed = line.trim()
  for (const [pattern, build] of LINES) {
    const match = pattern.exec(trimmed)
    if (match !== null) return build(match)
  }
  return null
}

export interface WindowsSpawnerOptions {
  spawnProcess?: SpawnProcess
  /** The UI's environment: SystemRoot names PowerShell; the step itself runs with it. */
  env?: Readonly<Record<string, string | undefined>>
  /** Schedules the launch-report timeout; default `setTimeout`. */
  after?: (ms: number, run: () => void) => () => void
}

export function createWindowsSpawner(options: WindowsSpawnerOptions = {}): HostSpawner {
  const spawnProcess = options.spawnProcess ?? spawn
  const env = options.env ?? process.env
  const after = options.after ?? realAfter
  const powershell = windowsPowerShell(env)
  const encoded = Buffer.from(launcherScript(), 'utf16le').toString('base64')
  return (request) =>
    new Promise<LaunchOutcome>((resolve) => {
      let settled = false
      let reportExit: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((done) => {
        reportExit = done
      })
      let child: ChildProcess
      try {
        child = spawnProcess(
          powershell,
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: launcherEnvironment(env)
          }
        )
      } catch (error) {
        resolve({ kind: 'failed', errCode: errorCode(error) })
        return
      }
      const settle = (outcome: LaunchOutcome): void => {
        if (settled) return
        settled = true
        cancelTimeout()
        resolve(outcome)
      }
      const cancelTimeout = after(LAUNCH_REPORT_TIMEOUT_MS, () => {
        settle({ kind: 'failed', errCode: 'LAUNCHER_TIMEOUT' })
        child.kill()
      })
      const host = (how: LaunchedHost['how']): LaunchedHost => ({
        how,
        exited,
        release: () => {
          if (child.exitCode === null) child.kill()
          reportExit(null)
        }
      })
      if (child.stdout !== null) {
        createInterface({ input: child.stdout }).on('line', (text) => {
          const line = parseLauncherLine(text)
          if (line === null || line.kind === 'refused') return
          if (line.kind === 'launched') settle({ kind: 'launched', host: host(line.how) })
          else if (line.kind === 'exit') reportExit(line.code)
          else settle({ kind: line.kind, errCode: line.code })
        })
      }
      child.stderr?.resume()
      child.on('error', (error) => {
        settle({ kind: 'failed', errCode: errorCode(error) })
        reportExit(null)
      })
      child.on('close', (code) => {
        settle({ kind: 'failed', errCode: `LAUNCHER_EXIT_${String(code)}` })
        reportExit(null)
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(stepRequest(request)))
    })
}

/** What the step reads on stdin. */
function stepRequest(request: HostSpawnRequest): {
  file: string
  commandLine: string
  cwd: string
  env: string[]
} {
  return {
    file: request.file,
    commandLine: windowsCommandLine(request.file, request.args),
    cwd: request.cwd,
    env: environmentList(request.env)
  }
}

/** Windows PowerShell 5.1 by its full path under SystemRoot, never looked up on PATH. */
export function windowsPowerShell(env: Readonly<Record<string, string | undefined>>): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** The UI's environment without PSModulePath, whatever its spelling. */
function launcherEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.toUpperCase() !== 'PSMODULEPATH') out[name] = value
  }
  return out
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'SPAWN_ERROR'
}

function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
