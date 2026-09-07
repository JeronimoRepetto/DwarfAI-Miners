import { spawn, type SpawnOptions } from 'node:child_process'
import type {
  HostedProcessHandle,
  HostedProcessPort,
  HostedProcessStartRequest
} from './hostedProcesses'

/**
 * The real child process behind a hosted command (#194) — the seam
 * `HostedProcessRegistry` is written against, so no unit test ever spawns one.
 *
 * The same division `launchRunner` and `sdkHeldSession` keep: the exact spawn
 * call is a pure VALUE a test asserts on every platform, and only the spawn
 * itself is integration territory.
 *
 * ## Why there is no console-hosting intermediary here (#208, #212)
 *
 * The detached launcher spawns a `node -e` intermediary that re-spawns the real
 * program, and it costs a resident node process per launched session. That
 * whole apparatus exists for one reason, stated in `buildLaunchSpawn`: libuv
 * turns `detached` into DETACHED_PROCESS, Win32 documents CREATE_NO_WINDOW as
 * IGNORED alongside it, so a detached child gets NO console — and Windows then
 * hands a console-subsystem grandchild whose parent has no console a fresh
 * VISIBLE one.
 *
 * A hosted process is **not detached**, so none of that applies: with
 * DETACHED_PROCESS gone, `windowsHide` is honoured, the child gets an INVISIBLE
 * console of its own, and anything it starts inherits that. Which is precisely
 * the second hop the intermediary was invented to perform — read the same
 * measurement the other way and the intermediary is what it was there to
 * arrange. So a hosted process needs no host: it already IS the non-detached,
 * window-hidden hop.
 *
 * Not detaching is also not a concession. It is the bargain: libuv gives every
 * non-detached child a KILL_ON_JOB_CLOSE job, so a hosted process dies with the
 * panel — which is exactly the lifetime `HostedProcessRegistry` documents,
 * because the panel is this process's stdio and nobody else could read it.
 */

/**
 * The exact spawn call, as a value.
 *
 * `shell` is absent, which means false, and that is the security posture rather
 * than a default: the argv comes from a text box, and `parseHostedCommand`
 * refuses shell metacharacters precisely because nothing downstream will
 * interpret them.
 *
 * All three streams are piped, unlike the detached launcher's `['pipe',
 * 'ignore', <file fd>]` (#263 gave stderr a file there, never a pipe — see
 * `buildLaunchSpawn`). That is the feature here: stdout and stderr ARE the
 * conversation this panel shows, and stdin stays open so the composer is a real
 * inbox. An unread pipe fills and stalls its writer, which is why the detached
 * launcher ignores stdout and never pipes stderr either — here both are read
 * on every chunk instead, because a hosted process is never detached and dies
 * with the panel, so there is no parent-exits-first hazard to avoid.
 */
export function buildHostedSpawn(request: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}): { command: string; args: string[]; options: SpawnOptions } {
  return {
    command: request.program,
    args: [...request.args],
    options: {
      cwd: request.cwd,
      env: request.env,
      // Held, not handed over: see the module comment on why this is the whole
      // bargain rather than an omission.
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  }
}

/**
 * One line as it reaches the child's stdin.
 *
 * A trailing newline, because a program reading a line from stdin is waiting
 * for the Enter a person would have pressed, and one that never arrives is a
 * process that hangs having been sent nothing it can act on. Exactly one: a
 * text already ending in a newline is not given a second, which would read as
 * a blank line typed after the message.
 *
 * The detached launcher needs no equivalent because it ends the stream instead
 * — EOF is what tells a `claude -p` its prompt is complete. A hosted process
 * keeps its stdin, so there is no EOF to lean on and the newline is the only
 * boundary there is.
 */
export function hostedStdinLine(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** The slice of a spawned child this port touches, so its wiring stays typed. */
export interface HostedChild {
  readonly pid?: number
  once(event: 'spawn' | 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  stdin: {
    on(event: 'error', listener: () => void): unknown
    write(chunk: string): unknown
  } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
}

/** `spawn`'s shape as this port needs it; Node's own `spawn` satisfies it. */
export type SpawnHosted = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => HostedChild

/**
 * Start one hosted process and hand back the handle on it.
 *
 * Resolves once the process is running; rejects when it could not be started at
 * all, which the registry turns into a stated reason rather than a silent
 * no-op.
 *
 * stdout and stderr are folded into ONE stream of output, deliberately. The
 * panel shows what the process said; which file descriptor it chose to say it
 * on is the program's own business, and splitting them would mean the panel
 * deciding that a warning is a different kind of speech from a result.
 */
export function createNodeHostedProcess(spawnProcess: SpawnHosted = spawn): HostedProcessPort {
  return (request: HostedProcessStartRequest): Promise<HostedProcessHandle> =>
    new Promise((resolve, reject) => {
      let settled = false
      let child: HostedChild
      const call = buildHostedSpawn(request)
      try {
        child = spawnProcess(call.command, call.args, call.options)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }

      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })

      child.once('spawn', () => {
        if (settled) return
        settled = true
        // A child that exits before reading breaks the pipe. That is its own
        // business by then — the process did start — but an unhandled EPIPE on
        // this stream would take the whole main process down with it.
        child.stdin?.on('error', () => {})
        const receive = (chunk: Buffer | string): void => {
          request.onOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        }
        child.stdout?.on('data', receive)
        child.stderr?.on('data', receive)
        child.once('exit', (code) => request.onEnd(code === null ? 'signalled' : `exit ${code}`))
        child.stdin?.write(hostedStdinLine(request.prompt))
        resolve({
          ...(child.pid === undefined ? {} : { pid: child.pid }),
          send: (text: string) => {
            if (child.stdin === null) return false
            try {
              child.stdin.write(hostedStdinLine(text))
              return true
            } catch {
              // A closed or broken pipe reads as "it did not happen", never as
              // a delivered message — the exit-0-shaped lie this app refuses.
              return false
            }
          }
        })
      })
    })
}
