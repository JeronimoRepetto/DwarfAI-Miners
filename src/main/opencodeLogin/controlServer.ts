import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { NodeFs, type FsLike } from '../adapters/fsLike'
import {
  describeProgramFailure,
  describeShimRefusal,
  resolveProgram
} from '../platform/cliDetection'
import { createProcessEnd, type ProcessEndPort } from '../platform/processEnd'

/**
 * A loopback `opencode serve --pure` this app starts and holds for itself
 * (#597 T1), so a later check (`GET /provider`) and a later login
 * (`PUT /auth/{id}`, the OAuth routes) have a server before any session is
 * launched. No OpenCode server is reachable before that: the only URL this
 * app otherwise knows is pushed by a running session's own plugin.
 */

/** `resolveProgram`'s own resolved shape (cliDetection.ts) — command plus the argv ahead of this app's own. */
export interface ControlServerProgram {
  command: string
  args: string[]
}

/** `--port 0` still chose 4096 when this was measured: never assume a port, parse it back off the child's own line. */
const ANNOUNCEMENT_PATTERN = /opencode server listening on (http:\/\/\S+)/

/**
 * The URL an `opencode serve` announcement names, or undefined while the
 * buffer holds no such line yet.
 *
 * Takes the whole accumulated buffer rather than one chunk: a banner can
 * arrive split across several stdout `data` events, and re-matching the
 * growing buffer is what makes that split invisible to the caller.
 */
export function parseControlServerUrl(buffer: string): string | undefined {
  return ANNOUNCEMENT_PATTERN.exec(buffer)?.[1]
}

/**
 * Build the exact, non-shell spawn call for one control-server start.
 *
 * No shell: this argv is the app's own, and a shell hop is exactly what the
 * measured Windows tree (node -> cmd -> a local launch wrapper -> opencode.exe)
 * came from — spawning the resolved program directly keeps this to one hop.
 *
 * Detached, so the child becomes its own process group on POSIX: that is what
 * `ProcessEndPort.endProcessTree`'s group signal (`kill -TERM -<pid>`) needs
 * to reach, the same reason every other launched-and-later-ended process this
 * app holds is detached. On Windows the tree kill (`taskkill /T`) walks the
 * live parent/child rows at kill time regardless, so detaching costs nothing
 * there and buys the POSIX case its group.
 *
 * stdout/stderr are piped, never ignored: the port `--port 0` actually chose
 * is only ever readable off the child's own announcement line. stdin is
 * ignored — `serve` takes no input this app would ever send it.
 *
 * The password travels only through `env`, never through argv, where a
 * process listing on the same machine could read it back.
 */
export function buildControlServerSpawn(
  program: ControlServerProgram,
  options: { password: string; env: NodeJS.ProcessEnv }
): { command: string; args: string[]; options: SpawnOptions } {
  return {
    command: program.command,
    args: [...program.args, 'serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'],
    options: {
      env: { ...options.env, OPENCODE_SERVER_PASSWORD: options.password },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  }
}

/** How long `ensure()` waits for the announcement line before giving up and killing the child (#597 T1). */
export const DEFAULT_READY_TIMEOUT_MS = 10_000

/**
 * How long a started server may sit unused before this app stops it.
 *
 * Generous next to the sub-second start Row-measured (~730 ms): a credential
 * check and a login both come in short bursts, and the cost of guessing wrong
 * is a resident process nobody is using, not a person waiting on it.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000

/** Bound on how much undifferentiated startup output this app holds before a match — a banner, never a log. */
const MAX_ANNOUNCEMENT_CHARS = 4_096

const NOT_INSTALLED =
  'The opencode binary could not be found, so its control server could not be started.'

/** The slice of a spawned child this port touches — mirrors HostedChild/LaunchChild, minus stdin: `serve` takes none. */
export interface ControlServerChild {
  readonly pid?: number
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
}

/** `spawn`'s shape as this port needs it; Node's own `spawn` satisfies it. */
export type SpawnControlServer = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ControlServerChild

export type ControlServerFailureReason =
  'not-installed' | 'spawn-failed' | 'exited-before-ready' | 'timed-out'

export type ControlServerStartResult =
  | { ok: true; url: string; readPassword: () => string }
  | { ok: false; reason: ControlServerFailureReason; detail?: string }

export interface OpenCodeControlServerOptions {
  /** Resolved fresh on every start attempt — installing opencode later must not need a restart. */
  resolveBinaryPath: () => Promise<string | undefined>
  /** Passed in rather than read, like every other engine in this app. */
  env: NodeJS.ProcessEnv
  fs?: FsLike
  spawn?: SpawnControlServer
  processEnd?: ProcessEndPort
  /** Injected so a test never depends on real randomness; defaults to a fresh secret per process start. */
  generatePassword?: () => string
  readyTimeoutMs?: number
  idleTimeoutMs?: number
}

export interface OpenCodeControlServerPort {
  /**
   * Start the server if none is running, share one in-flight start with every
   * concurrent caller, or hand back the one already running. Never rejects:
   * every failure this can hit — not installed, refused to spawn, exited
   * early, timed out — is a typed `ok: false` result instead.
   */
  ensure(): Promise<ControlServerStartResult>
  /** Stop the running (or still-starting) server and kill its whole tree. Safe to call when nothing is running. */
  stop(): Promise<void>
}

interface RunningServer {
  pid: number | undefined
  url: string
  password: string
}

/**
 * The loopback control server this app starts for itself (#597 T1).
 *
 * One instance is meant to be shared for the process's whole lifetime: the
 * composition root builds it once and every later credential check or login
 * operation calls `ensure()` on the same instance, which is what makes
 * "concurrent callers share one start" and "a started server is reused"
 * possible at all.
 */
export function createOpenCodeControlServer(
  options: OpenCodeControlServerOptions
): OpenCodeControlServerPort {
  const fs = options.fs ?? new NodeFs()
  const spawnProcess = options.spawn ?? (nodeSpawn as unknown as SpawnControlServer)
  const processEnd = options.processEnd ?? createProcessEnd()
  const generatePassword = options.generatePassword ?? (() => randomBytes(24).toString('hex'))
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  let running: RunningServer | null = null
  let starting: Promise<ControlServerStartResult> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function clearIdleTimer(): void {
    if (idleTimer === null) return
    clearTimeout(idleTimer)
    idleTimer = null
  }

  /** Every `ensure()` that finds a running server counts as a use and pushes idle shutdown back out. */
  function scheduleIdleShutdown(): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      void stop()
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  async function killRunning(): Promise<void> {
    const pid = running?.pid
    running = null
    if (pid === undefined) return
    try {
      await processEnd.endProcessTree(pid)
    } catch {
      // Best-effort: stop() and the idle shutdown's fire-and-forget void
      // stop() must not reject over a kill that failed to run.
    }
  }

  function startOnce(): Promise<ControlServerStartResult> {
    return new Promise((resolve) => {
      let settled = false
      let child: ControlServerChild
      // Declared before `finish` and initialised, never left in the
      // temporal dead zone a bare `let timer: T` would put it in — `finish`
      // must be safe to call from the outer catch below, which can run
      // before a child (and its timer) ever exists.
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: ControlServerStartResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(result)
      }

      void (async () => {
        try {
          const binaryPath = await options.resolveBinaryPath()
          if (binaryPath === undefined) {
            finish({ ok: false, reason: 'not-installed', detail: NOT_INSTALLED })
            return
          }
          const program = await resolveProgram(binaryPath, fs)
          if ('kind' in program) {
            finish({ ok: false, reason: 'not-installed', detail: describeShimRefusal(program) })
            return
          }

          const password = generatePassword()
          const call = buildControlServerSpawn(
            { command: program.command, args: program.args },
            { password, env: options.env }
          )

          timer = setTimeout(() => {
            // Never announced within the window: kill the whole tree rather
            // than leave a half-started server nobody can reach behind.
            void (async () => {
              const pid = child.pid
              if (pid !== undefined) {
                try {
                  await processEnd.endProcessTree(pid)
                } catch {
                  // Best-effort: the timeout verdict below stands regardless
                  // of whether the kill itself could run.
                }
              }
              finish({ ok: false, reason: 'timed-out' })
            })()
          }, readyTimeoutMs)
          timer.unref?.()

          child = spawnProcess(call.command, call.args, call.options)

          child.once('error', (error) => {
            finish({ ok: false, reason: 'spawn-failed', detail: describeProgramFailure(error) })
          })

          let buffer = ''
          const onData = (chunk: Buffer | string): void => {
            if (settled) return
            buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
            if (buffer.length > MAX_ANNOUNCEMENT_CHARS) {
              buffer = buffer.slice(-MAX_ANNOUNCEMENT_CHARS)
            }
            const url = parseControlServerUrl(buffer)
            if (url === undefined) return
            running = { pid: child.pid, url, password }
            scheduleIdleShutdown()
            finish({ ok: true, url, readPassword: () => password })
          }
          child.stdout?.on('data', onData)
          child.stderr?.on('data', onData)

          child.once('exit', (code, signal) => {
            if (!settled) {
              finish({
                ok: false,
                reason: 'exited-before-ready',
                detail:
                  signal !== null
                    ? `stopped by signal ${signal} before it announced its url`
                    : `exited (${code ?? 'unknown'}) before it announced its url`
              })
              return
            }
            // Ready before this: the server ended on its own after being
            // handed out (crash, an external kill). Clear the held state so
            // the next ensure() starts a fresh one instead of handing back a
            // url nobody is listening on any more.
            if (running !== null && running.pid === child.pid) {
              running = null
              clearIdleTimer()
            }
          })
        } catch (error) {
          // Everything above this catch can throw instead of resolving: a
          // shim `resolveProgram` must read back can stop existing between
          // detection and this start attempt (uninstalled, moved), and
          // `spawn` itself can throw synchronously. Either way this is a
          // FACT about the binary or the attempt, never an unhandled
          // rejection — `ensure()` promises every caller a typed result, the
          // same contract `resolveBinaryPath()` returning undefined already
          // keeps.
          const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
          finish({
            ok: false,
            reason: code === 'ENOENT' ? 'not-installed' : 'spawn-failed',
            detail: describeProgramFailure(error)
          })
        }
      })()
    })
  }

  async function ensure(): Promise<ControlServerStartResult> {
    if (running !== null) {
      scheduleIdleShutdown()
      const { url, password } = running
      return { ok: true, url, readPassword: () => password }
    }
    if (starting !== null) return starting
    const attempt = startOnce().finally(() => {
      starting = null
    })
    starting = attempt
    return attempt
  }

  async function stop(): Promise<void> {
    clearIdleTimer()
    if (starting !== null) await starting
    await killRunning()
  }

  return { ensure, stop }
}
