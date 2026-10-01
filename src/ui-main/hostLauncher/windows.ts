// Windows detach (ADR-002 D6; 13 FM-012, FM-114; spike-results/SP-02.md): the Host MUST start
// outside every job object the UI may be in and without a console window. Node's own spawn cannot
// (SP-02 finding 1: a `detached` child stays in the UI's job and carries DETACHED_PROCESS), so:
//
// 1. Breakaway, in this process, through the launch helper win-launch/win_launch.c (a Node-API
//    module prebuilt per architecture and shipped with the app; win-launch/nativeWinLaunch.ts
//    loads it). It calls CreateProcessW with CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP |
//    CREATE_NO_WINDOW, suspended, with no inherited handles (clean stdio) and the Host's environment
//    block. SP-02 finding 2: in nested jobs breakaway can succeed yet leave the child in the UI's
//    job, so the child is checked with IsProcessInJob and resumed only when it is outside every
//    job; still in a job (or ERROR_ACCESS_DENIED from the create) counts as refused and the child
//    is ended. The step takes milliseconds and starts no other process. (Until this fix it was a
//    Windows PowerShell process that compiled its C# with Add-Type, which runs csc.exe, on every
//    spawn: a cold or busy machine could not report within the launch timeout, and the Host failed
//    to start with LAUNCHER_TIMEOUT.)
// 2. When breakaway is refused: WMI Win32_Process.Create with a hidden window (ShowWindow = 0),
//    which creates the process outside the job, through one Windows PowerShell 5.1 step by path (as
//    the Host's own probes run it, privilege.ts). WMI hands the new process exactly the environment
//    it is given (measured for ISSUE-030: without EnvironmentVariables it gets the user's registry
//    environment, with them only those, and the WMI service's working folder unless one is set),
//    so the whole environment and the working folder are always passed explicitly. The step only
//    creates the process and prints its pid; it compiles nothing. It must report within
//    LAUNCH_REPORT_TIMEOUT_MS, or the launch fails.
// 3. DETACHED_PROCESS is never used (D6 item 3); the helper refuses the flag.
//
// The helper then watches the Host (a WMI-created one opened by its pid) for up to HOST_WATCH_MS
// and reports its exit code if it exits, so a Host refusal (ALREADY_RUNNING, ELEVATED_REFUSED)
// reaches the launcher; release() ends the watch and closes the handle. The Host itself is no
// child of the UI, so neither touches it.
//
// What the WMI step is told — command line, working folder, environment — goes on its stdin as
// JSON, never in its argv (02 NFR-SEC-05). Its argv holds the fixed script only (-EncodedCommand),
// and its own environment drops PSModulePath (a PowerShell 7 value breaks 5.1's module autoload,
// ISSUE-315). It runs with `shell: false` and `windowsHide: true` (R17). It prints one line:
// `launched wmi <pid>`, `in-job <code>` (WMI failed too) or `failed <code>`. The pid stays inside
// the launcher: it is never logged (19 §9.1).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { HostSpawnRequest, HostSpawner, LaunchedHost } from './ports'
import type {
  BreakawayResult,
  HostProcessHandle,
  LoadedWinLaunch,
  WinLaunchBinding
} from './win-launch/nativeWinLaunch'

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

/** How long the Host's exit is reported: the readiness budget with its migrating extension. */
export const HOST_WATCH_MS = 60_000

/**
 * How long the WMI step (breakaway refused) may take to report a launch. The package names none.
 * The step no longer compiles anything: on this machine it measured about 0.4–0.6 s warm, mostly
 * Windows PowerShell's own start; 10 s leaves room for a cold start without eating the 15 s
 * readiness budget, and a step that does not report in time is a failed launch (fail-closed).
 */
export const LAUNCH_REPORT_TIMEOUT_MS = 10_000

/** The WMI step's script; only constants are put into it, never a request value. */
export function launcherScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }',
    'try {',
    '  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    "} catch { Say 'failed LAUNCHER_SETUP'; exit 2 }",
    'try {',
    '  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$request.env }',
    '  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $request.commandLine; CurrentDirectory = $request.cwd; ProcessStartupInformation = $startup }',
    "} catch { Say 'in-job WMI_ERROR'; exit 3 }",
    "if ($created.ReturnValue -ne 0) { Say ('in-job WMI_' + $created.ReturnValue); exit 3 }",
    "Say ('launched wmi ' + $created.ProcessId)"
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

/** The Unicode environment block CreateProcessW reads: each entry NUL-terminated, then one NUL. */
export function environmentBlock(env: Readonly<Record<string, string>>): string {
  const entries = environmentList(env)
  return entries.length === 0 ? '\0\0' : `${entries.join('\0')}\0\0`
}

export type LauncherLine =
  | { kind: 'launched'; pid: number }
  | { kind: 'in-job'; code: string }
  | { kind: 'failed'; code: string }

const CODE = '([A-Za-z0-9_.:-]{1,64})'
const LINES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => LauncherLine]> = [
  [/^launched wmi (\d{1,10})$/, (m) => ({ kind: 'launched', pid: Number(m[1]) })],
  [new RegExp(`^in-job ${CODE}$`), (m) => ({ kind: 'in-job', code: m[1] as string })],
  [new RegExp(`^failed ${CODE}$`), (m) => ({ kind: 'failed', code: m[1] as string })]
]

/** One line the WMI step printed, or null for anything else. */
export function parseLauncherLine(line: string): LauncherLine | null {
  const trimmed = line.trim()
  for (const [pattern, build] of LINES) {
    const match = pattern.exec(trimmed)
    if (match !== null) return build(match)
  }
  return null
}

export interface WindowsSpawnerOptions {
  /** Loads the launch helper (win-launch/nativeWinLaunch.ts); called once, on the first spawn. */
  loadHelper: () => LoadedWinLaunch
  spawnProcess?: SpawnProcess
  /** The UI's environment: SystemRoot names PowerShell; the WMI step itself runs with it. */
  env?: Readonly<Record<string, string | undefined>>
  /** Schedules the WMI step's report timeout; default `setTimeout`. */
  after?: (ms: number, run: () => void) => () => void
}

type WmiOutcome = { kind: 'launched'; pid: number } | { kind: 'in-job' | 'failed'; errCode: string }

export function createWindowsSpawner(options: WindowsSpawnerOptions): HostSpawner {
  const runWmiStep = createWmiStep(options)
  let helper: LoadedWinLaunch | undefined
  return async (request) => {
    helper ??= options.loadHelper()
    if (!helper.ok) return { kind: 'failed', errCode: helper.errCode }
    const binding = helper.binding
    let result: BreakawayResult
    try {
      result = binding.breakaway(
        request.file,
        windowsCommandLine(request.file, request.args),
        request.cwd,
        environmentBlock(request.env),
        BREAKAWAY_CREATION_FLAGS
      )
    } catch (error) {
      return { kind: 'failed', errCode: errorCode(error, 'BREAKAWAY_ERROR') }
    }
    if (result.status === 'launched') {
      return {
        kind: 'launched',
        host:
          result.process === null
            ? unwatchedHost('breakaway')
            : watchedHost(binding, result.process, 'breakaway')
      }
    }
    if (result.status === 'failed') return { kind: 'failed', errCode: result.code }
    const created = await runWmiStep(request)
    if (created.kind !== 'launched') return created
    let opened: HostProcessHandle | null
    try {
      opened = binding.open(created.pid)
    } catch {
      opened = null
    }
    return {
      kind: 'launched',
      host: opened === null ? unwatchedHost('wmi') : watchedHost(binding, opened, 'wmi')
    }
  }
}

/** A Host the helper holds a handle to: its exit is reported until release(). */
function watchedHost(
  binding: WinLaunchBinding,
  handle: HostProcessHandle,
  how: LaunchedHost['how']
): LaunchedHost {
  let reportExit: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>((done) => {
    reportExit = done
  })
  let ended = false
  const end = (code: number | null): void => {
    if (ended) return
    ended = true
    binding.release(handle)
    reportExit(code)
  }
  try {
    binding.watch(handle, HOST_WATCH_MS, (code) => end(code >= 0 ? code : null))
  } catch {
    end(null)
  }
  return { how, exited, release: () => end(null) }
}

/** A Host the helper holds no handle to (WMI created it and it could not be opened). */
function unwatchedHost(how: LaunchedHost['how']): LaunchedHost {
  return { how, exited: Promise.resolve(null), release: () => {} }
}

/** D6 item 2: the one PowerShell step, run only when breakaway was refused. */
function createWmiStep(
  options: WindowsSpawnerOptions
): (request: HostSpawnRequest) => Promise<WmiOutcome> {
  const spawnProcess = options.spawnProcess ?? spawn
  const env = options.env ?? process.env
  const after = options.after ?? realAfter
  const powershell = windowsPowerShell(env)
  const encoded = Buffer.from(launcherScript(), 'utf16le').toString('base64')
  return (request) =>
    new Promise<WmiOutcome>((resolve) => {
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
        resolve({ kind: 'failed', errCode: errorCode(error, 'SPAWN_ERROR') })
        return
      }
      let settled = false
      const settle = (outcome: WmiOutcome): void => {
        if (settled) return
        settled = true
        cancelTimeout()
        resolve(outcome)
      }
      const cancelTimeout = after(LAUNCH_REPORT_TIMEOUT_MS, () => {
        settle({ kind: 'failed', errCode: 'LAUNCHER_TIMEOUT' })
        child.kill()
      })
      if (child.stdout !== null) {
        createInterface({ input: child.stdout }).on('line', (text) => {
          const line = parseLauncherLine(text)
          if (line === null) return
          if (line.kind === 'launched') settle({ kind: 'launched', pid: line.pid })
          else settle({ kind: line.kind, errCode: line.code })
        })
      }
      child.stderr?.resume()
      child.on('error', (error) =>
        settle({ kind: 'failed', errCode: errorCode(error, 'SPAWN_ERROR') })
      )
      child.on('close', (code) =>
        settle({ kind: 'failed', errCode: `LAUNCHER_EXIT_${String(code)}` })
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(stepRequest(request)))
    })
}

/** What the WMI step reads on stdin. */
function stepRequest(request: HostSpawnRequest): {
  commandLine: string
  cwd: string
  env: string[]
} {
  return {
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

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : fallback
}

function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
