import { spawn as spawnChild } from 'node:child_process'
import type { ShellResult, ShellRunner } from '../platform/focus'

/**
 * A long-lived, stdin-driven powershell.exe for console delivery (issue #21).
 *
 * Every keystroke and interrupt action used to pay a fresh `powershell.exe
 * -NoProfile` start — the single largest fixed cost on the terminal path, for a
 * command that then does almost nothing. One process, kept alive and fed
 * commands over stdin, pays that start once.
 *
 * The transport is the ONLY thing that changes: the pure command builders in
 * sendKeys.ts are handed through untouched, so what gets typed into a session
 * is byte-for-byte what it was before.
 *
 * Failure is a verdict, never a crash. A wedged command is abandoned with the
 * shell that swallowed it; a dead shell is replaced on the next action; and a
 * shell that cannot be started at all reports itself unavailable so the caller
 * falls back to the old per-action spawn instead of losing the action.
 */

/** `-Command -` is what makes PowerShell read statements from stdin. */
export const WORKER_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'] as const

/**
 * Marks a shell that never started (ENOENT, a blocked binary). The command was
 * NOT run, so the caller is free to retry it elsewhere — which is exactly what
 * separates this from every other failure, where the command may well have run.
 */
export class ConsoleWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConsoleWorkerUnavailableError'
  }
}

/**
 * The slice of a child process the worker drives. Narrow on purpose: a test
 * fake implements four members and needs no real process anywhere.
 */
export interface ConsoleWorkerProcess {
  stdin: { write(chunk: string): void; end(): void } | null
  stdout: {
    setEncoding(encoding: string): void
    on(event: 'data', listener: (chunk: string) => void): void
  } | null
  on(event: 'error' | 'exit', listener: (...args: unknown[]) => void): void
  kill(): void
}

/** Prefix distinctive enough that no PowerShell banner or error can collide with it. */
const SENTINEL_PREFIX = 'DWARFAI-MINERS-CONSOLE'

/** The line the shell prints to report request `id` finished with `exitCode`. */
export function workerSentinel(id: number, exitCode: number): string {
  return `${SENTINEL_PREFIX}:${id}:${exitCode}`
}

/**
 * One stdin line that runs `command` and then reports its own verdict.
 *
 * It must be a SINGLE line: PowerShell's stdin host reads line by line, so a
 * multi-line block would leave the shell waiting for a closing brace forever —
 * exactly the wedge this worker exists to avoid. The command is therefore
 * carried base64-encoded (the same UTF-16LE encoding `-EncodedCommand` uses),
 * which also means no quoting inside a caller's command can ever break out.
 */
export function buildWorkerRequest(command: string, id: number): string {
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  return (
    `try { ` +
    `& ([ScriptBlock]::Create(` +
    `[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))` +
    `)) | Out-Null; ` +
    `Write-Output '${workerSentinel(id, 0)}' ` +
    `} catch { Write-Output '${workerSentinel(id, 1)}' }\n`
  )
}

/** The exit code `line` reports for request `id`, or null when it is anything else. */
export function parseWorkerResponse(line: string, id: number): number | null {
  const match = new RegExp(`^${SENTINEL_PREFIX}:(\\d+):(\\d+)$`).exec(line.trim())
  if (match === null || Number(match[1]) !== id) return null
  return Number(match[2])
}

export interface ConsoleWorker {
  run: ShellRunner
  /** Ends the shell for good; safe to call twice, or before anything ran. */
  dispose(): void
}

export interface ConsoleWorkerOptions {
  /** Injected for tests; defaults to a real long-lived powershell.exe. */
  spawn?: () => ConsoleWorkerProcess
  /** How long one command may run before its shell is abandoned. */
  commandTimeoutMs: number
}

/** Exit code reported for a command the worker could not get a verdict for. */
const NO_VERDICT_EXIT = 1

function spawnPowerShell(): ConsoleWorkerProcess {
  return spawnChild('powershell.exe', [...WORKER_ARGS], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
}

export function createConsoleWorker(options: ConsoleWorkerOptions): ConsoleWorker {
  const spawn = options.spawn ?? spawnPowerShell

  /** The live shell, or null when one has yet to be started (or has died). */
  let shell: ConsoleWorkerProcess | null = null
  /** Stdout tail that has yet to end in a newline. */
  let buffer = ''
  /** The command currently on the wire; null when the shell is idle. */
  let pending: {
    id: number
    deliver: (result: ShellResult) => void
    fail: (error: Error) => void
  } | null = null
  /** Ids are never reused, so a reply from an abandoned shell can never be misread. */
  let nextId = 1
  /**
   * Commands waiting their turn. One statement is on the wire at a time: two
   * SendKeys runs at once would interleave keystrokes in whatever window
   * happens to hold the foreground.
   */
  const waiting: Array<{
    command: string
    resolve: (result: ShellResult) => void
    reject: (error: Error) => void
  }> = []
  let disposed = false

  function settle(result: ShellResult): void {
    const current = pending
    pending = null
    current?.deliver(result)
    pump()
  }

  /** Drop the current shell. Anything still pending is answered, never left hanging. */
  function discard(reason: ShellResult | Error): void {
    const dying = shell
    shell = null
    buffer = ''
    if (dying !== null) {
      try {
        dying.stdin?.end()
        dying.kill()
      } catch {
        // A shell that is already gone needs no further shutting down.
      }
    }
    const current = pending
    pending = null
    if (current !== null) {
      if (reason instanceof Error) current.fail(reason)
      else current.deliver(reason)
    }
    pump()
  }

  function onData(chunk: string): void {
    buffer += chunk
    const lines = buffer.split('\n')
    // The trailing fragment is an incomplete line: keep it for the next chunk.
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (pending === null) continue
      const exitCode = parseWorkerResponse(line, pending.id)
      if (exitCode !== null) settle({ stdout: '', exitCode })
    }
  }

  function ensureShell(): ConsoleWorkerProcess {
    if (shell !== null) return shell
    const started = spawn()
    shell = started
    started.stdout?.setEncoding('utf8')
    started.stdout?.on('data', onData)
    started.on('error', (...args: unknown[]) => {
      // The binary never started: the command did not run, so the caller may
      // safely fall back to a per-action spawn.
      if (shell !== started) return
      const error = args[0]
      discard(
        new ConsoleWorkerUnavailableError(
          error instanceof Error ? error.message : 'the console worker could not be started'
        )
      )
    })
    started.on('exit', () => {
      if (shell !== started) return
      discard({ stdout: '', exitCode: NO_VERDICT_EXIT })
    })
    return started
  }

  /** Start the next queued command, if the wire is free. */
  function pump(): void {
    if (pending !== null) return
    const next = waiting.shift()
    if (next === undefined) return
    if (disposed) {
      next.resolve({ stdout: '', exitCode: NO_VERDICT_EXIT })
      pump()
      return
    }

    const id = nextId++
    // Armed before the command is written, and cleared by whichever answer
    // arrives first: one bad command must never wedge every later action, so
    // the shell that swallowed it is abandoned and the next starts a fresh one.
    const timer = setTimeout(() => {
      discard({ stdout: '', exitCode: NO_VERDICT_EXIT })
    }, options.commandTimeoutMs)

    pending = {
      id,
      deliver: (result) => {
        clearTimeout(timer)
        next.resolve(result)
      },
      fail: (error) => {
        clearTimeout(timer)
        next.reject(error)
      }
    }

    try {
      ensureShell().stdin?.write(buildWorkerRequest(next.command, id))
    } catch (error) {
      clearTimeout(timer)
      pending = null
      shell = null
      next.reject(
        new ConsoleWorkerUnavailableError(
          error instanceof Error ? error.message : 'the console worker could not be started'
        )
      )
      pump()
    }
  }

  return {
    run(command: string): Promise<ShellResult> {
      return new Promise<ShellResult>((resolve, reject) => {
        waiting.push({ command, resolve, reject })
        pump()
      })
    },
    dispose(): void {
      disposed = true
      discard({ stdout: '', exitCode: NO_VERDICT_EXIT })
    }
  }
}

/**
 * The persistent worker with the old per-action spawn behind it.
 *
 * Only an unavailable SHELL falls back. A command that ran and failed is
 * reported as it is: re-running it on a fresh shell would type the same
 * keystrokes into the session a second time.
 */
export function createResilientShellRunner(
  worker: ConsoleWorker,
  fallback: ShellRunner
): ShellRunner {
  return async (command: string) => {
    try {
      return await worker.run(command)
    } catch (error) {
      if (error instanceof ConsoleWorkerUnavailableError) return fallback(command)
      throw error
    }
  }
}
