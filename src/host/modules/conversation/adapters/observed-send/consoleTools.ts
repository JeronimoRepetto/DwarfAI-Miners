// The one runner of the observed-session relays' tools (ADR-012 item 3, 15 §3.3; R17): the key
// relay (ConsoleKeystrokeDelivery.ts), the text relay (ConsoleTextDelivery.ts) and the Codex queue
// (CodexThreadQueue.ts) each run a short-lived tool — PowerShell, ps, tmux, osascript, codex —
// through the kernel `ProcessControl.spawn` (`shell: false` and `windowsHide: true` fixed by the
// adapter) with an argv array, a named allowlist of the Host's environment, and a bound; a tool
// that overruns is ended by its own identity, never the session's process and never a group.
// Nothing here logs a tool's input or output.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import { matchesRecorded } from '../../../../kernel/domain/processIdentity'
import type { ProcessControl, SpawnedProcess } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'

/** An executable and the arguments placed before the tool's own (a test points it at a stub). */
export interface ConsoleCommand {
  executable: string
  prefix: readonly string[]
}

export type ConsoleTool = 'powershell' | 'ps' | 'tmux' | 'osascript'

export const DEFAULT_COMMANDS: Readonly<Record<ConsoleTool, ConsoleCommand>> = {
  powershell: { executable: 'powershell.exe', prefix: [] },
  ps: { executable: 'ps', prefix: [] },
  tmux: { executable: 'tmux', prefix: [] },
  osascript: { executable: 'osascript', prefix: [] }
}

/**
 * The variables a tool may need to start and find its server: the executable search path, the
 * Windows basics PowerShell's `Add-Type` compiles with, and the home, user and tmux socket folder
 * tmux finds its server by. Nothing else of the Host's environment reaches a tool.
 */
export const TOOL_ENV_NAMES: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMUX_TMPDIR',
  'LANG'
]

/** The named variables of `env` that are set. */
export function toolEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[] = TOOL_ENV_NAMES
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of names) {
    const value = env[name]
    if (value !== undefined) picked[name] = value
  }
  return picked
}

/** How much of a tool's stdout is read; the tools here print one line or a pane list. */
const STDOUT_CAP_BYTES = 64 * 1024

/** How one tool run ended: its exit, a spawn that never started, or an overrun of its bound. */
export type ToolRun =
  | { kind: 'exited'; code: number | null; stdout: string }
  | { kind: 'not-started' }
  | { kind: 'overran' }

export interface ToolRunnerDeps {
  /** The kernel process port: the identity probe and every tool run (R17). */
  processes: Pick<ProcessControl, 'probe' | 'spawn' | 'killTree'>
  scheduler: Scheduler
  /** The working folder each tool runs in. */
  cwd: string
}

/** Runs one tool to its exit with `stdin` written and closed, bounded by `timeoutMs`. */
export async function runTool(
  deps: ToolRunnerDeps,
  command: ConsoleCommand,
  args: readonly string[],
  spec: { env: Record<string, string>; stdin?: string; timeoutMs: number }
): Promise<ToolRun> {
  let child: SpawnedProcess
  try {
    child = deps.processes.spawn({
      executable: command.executable,
      args: [...command.prefix, ...args],
      cwd: deps.cwd,
      env: spec.env,
      processGroup: 'inherit',
      stdio: 'pipe'
    })
  } catch {
    return { kind: 'not-started' }
  }
  let stdout = ''
  const drained = new Promise<void>((resolve) => {
    if (child.stdout === null) return resolve()
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (stdout.length < STDOUT_CAP_BYTES) stdout += chunk.toString()
    })
    child.stdout.once('end', () => resolve())
    child.stdout.once('close', () => resolve())
    child.stdout.once('error', () => resolve())
  })
  child.stderr?.resume()
  child.stdin?.on('error', () => {})
  child.stdin?.end(spec.stdin ?? '')

  let overran!: () => void
  const deadline = new Promise<'overran'>((resolve) => (overran = () => resolve('overran')))
  const timer = deps.scheduler.after(spec.timeoutMs, () => {
    // Its own child, ended by its identity; never the session's process and never a group.
    void child.identity
      .then((identity) => deps.processes.killTree(identity, { graceMs: 0, group: 'foreign' }))
      .catch(() => {})
    overran()
  })
  try {
    const outcome = await Promise.race([
      Promise.all([child.exited, drained]).then(([exit]) => exit),
      deadline
    ])
    if (outcome === 'overran') return { kind: 'overran' }
    return { kind: 'exited', code: outcome.code, stdout }
  } catch {
    // `exited` rejects only for a spawn that never started (16 §3).
    return { kind: 'not-started' }
  } finally {
    timer.cancel()
  }
}

/**
 * What the target's identity reads as now (ADR-014 item 1): the same process, a process that is
 * gone (absent, or another one on its pid: recycled, an earlier boot), or no reading at all.
 */
export async function targetNow(
  processes: Pick<ProcessControl, 'probe'>,
  target: ProcessIdentity
): Promise<'same' | 'gone' | 'unreadable'> {
  const probed = await processes.probe(target.pid)
  if (matchesRecorded(probed, target)) return 'same'
  return probed === 'unknown' ? 'unreadable' : 'gone'
}
