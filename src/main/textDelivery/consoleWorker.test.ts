import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConsoleWorkerUnavailableError,
  WORKER_ARGS,
  buildWorkerRequest,
  createConsoleWorker,
  createResilientShellRunner,
  parseWorkerResponse,
  workerSentinel,
  type ConsoleWorkerProcess
} from './consoleWorker'

/**
 * A deterministic stand-in for the long-lived powershell.exe: it records what
 * was written to stdin and lets the test decide when (or whether) a reply comes
 * back. No real process, no real timers.
 */
function fakeShell() {
  const written: string[] = []
  const exitListeners: Array<(...args: unknown[]) => void> = []
  const errorListeners: Array<(...args: unknown[]) => void> = []
  let onData: ((chunk: string) => void) | undefined
  const kill = vi.fn()
  const end = vi.fn()

  const process: ConsoleWorkerProcess = {
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
      },
      end
    },
    stdout: {
      setEncoding: vi.fn(),
      on: (_event, listener) => {
        onData = listener
      }
    },
    on: (event, listener) => {
      if (event === 'exit') exitListeners.push(listener)
      else errorListeners.push(listener)
    },
    kill
  }

  return {
    process,
    written,
    kill,
    end,
    /** Ids are handed out from 1 upward, so a test can answer request N. */
    reply: (id: number, exitCode: number) => onData?.(`${workerSentinel(id, exitCode)}\n`),
    emitRaw: (text: string) => onData?.(text),
    die: (code = 1) => exitListeners.forEach((listener) => listener(code)),
    failToStart: (error = new Error('ENOENT')) =>
      errorListeners.forEach((listener) => listener(error))
  }
}

describe('buildWorkerRequest', () => {
  it('is a single line, so the shell can never be left waiting on an open block', () => {
    const request = buildWorkerRequest("$x = 'a'\nWrite-Output $x", 1)
    expect(request.endsWith('\n')).toBe(true)
    expect(request.trimEnd()).not.toContain('\n')
  })

  it('carries the command verbatim, encoded, so quoting can never mangle it', () => {
    const command = "$ErrorActionPreference = 'Stop'\n[Forms.SendKeys]::SendWait('{ESC}')"
    const request = buildWorkerRequest(command, 7)
    const encoded = /FromBase64String\('([^']+)'\)/.exec(request)?.[1] ?? ''

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(command)
  })

  it('tags the request with its own id so replies can never be crossed', () => {
    expect(buildWorkerRequest('x', 3)).toContain(workerSentinel(3, 0))
    expect(buildWorkerRequest('x', 3)).toContain(workerSentinel(3, 1))
  })
})

describe('parseWorkerResponse', () => {
  it('reads the exit code out of a matching sentinel', () => {
    expect(parseWorkerResponse(workerSentinel(4, 0), 4)).toBe(0)
    expect(parseWorkerResponse(workerSentinel(4, 1), 4)).toBe(1)
  })

  it('ignores a sentinel meant for another request', () => {
    expect(parseWorkerResponse(workerSentinel(5, 0), 4)).toBeNull()
  })

  it('ignores whatever else the shell printed', () => {
    expect(parseWorkerResponse('At line:1 char:1', 4)).toBeNull()
    expect(parseWorkerResponse('', 4)).toBeNull()
  })
})

describe('createConsoleWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Every spawn hands out a fresh shell, so a restart is observable. */
  function worker(overrides: { commandTimeoutMs?: number } = {}) {
    const shells: Array<ReturnType<typeof fakeShell>> = []
    const spawn = vi.fn(() => {
      const shell = fakeShell()
      shells.push(shell)
      return shell.process
    })
    const instance = createConsoleWorker({
      spawn,
      commandTimeoutMs: overrides.commandTimeoutMs ?? 10_000
    })
    return { instance, shells, spawn }
  }

  it('starts nothing until the first command actually needs it', () => {
    const { spawn } = worker()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reuses one process across actions — the cold start is paid once', async () => {
    const { instance, shells, spawn } = worker()

    const first = instance.run('one')
    shells[0]?.reply(1, 0)
    await expect(first).resolves.toEqual({ stdout: '', exitCode: 0 })

    const second = instance.run('two')
    shells[0]?.reply(2, 0)
    await expect(second).resolves.toEqual({ stdout: '', exitCode: 0 })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(shells[0]?.written).toHaveLength(2)
  })

  it('spawns the shell in stdin mode with no profile', () => {
    expect(WORKER_ARGS).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
  })

  it('reports the exit code the command answered with', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')
    shells[0]?.reply(1, 1)
    await expect(run).resolves.toMatchObject({ exitCode: 1 })
  })

  it('runs one command at a time, so two actions cannot interleave in the shell', async () => {
    const { instance, shells } = worker()

    const first = instance.run('one')
    const second = instance.run('two')
    expect(shells[0]?.written).toHaveLength(1)

    shells[0]?.reply(1, 0)
    await first
    expect(shells[0]?.written).toHaveLength(2)

    shells[0]?.reply(2, 0)
    await second
  })

  it('bounds a command that never answers instead of wedging the queue', async () => {
    const { instance, shells } = worker({ commandTimeoutMs: 5_000 })

    const stuck = instance.run('hangs forever')
    const queued = instance.run('next')

    await vi.advanceTimersByTimeAsync(5_000)
    expect((await stuck).exitCode).not.toBe(0)
    // The wedged shell is abandoned so it cannot swallow the next action.
    expect(shells[0]?.kill).toHaveBeenCalled()

    // The queued command got a fresh shell and still runs.
    await vi.advanceTimersByTimeAsync(0)
    expect(shells).toHaveLength(2)
    shells[1]?.reply(2, 0)
    await expect(queued).resolves.toMatchObject({ exitCode: 0 })
  })

  it('never rejects when a command times out — a failure is a verdict, not a crash', async () => {
    const { instance } = worker({ commandTimeoutMs: 1_000 })
    const stuck = instance.run('hangs')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(stuck).resolves.toMatchObject({ stdout: '' })
  })

  it('answers a command whose shell died rather than leaving it pending', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')
    shells[0]?.die(1)
    await expect(run).resolves.toMatchObject({ exitCode: 1 })
  })

  it('re-creates the shell after it died', async () => {
    const { instance, shells, spawn } = worker()

    const first = instance.run('x')
    shells[0]?.die(1)
    await first

    const second = instance.run('y')
    shells[1]?.reply(2, 0)
    await expect(second).resolves.toMatchObject({ exitCode: 0 })

    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reports the shell as unavailable when it could not be started at all', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')
    shells[0]?.failToStart()
    await expect(run).rejects.toBeInstanceOf(ConsoleWorkerUnavailableError)
  })

  it('ignores output that is not one of its sentinels', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')

    shells[0]?.emitRaw('some banner text\nAt line:1 char:1\n')
    shells[0]?.reply(1, 0)

    await expect(run).resolves.toMatchObject({ exitCode: 0 })
  })

  it('reassembles a reply that arrived split across chunks', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')

    const sentinel = workerSentinel(1, 0)
    shells[0]?.emitRaw(sentinel.slice(0, 5))
    shells[0]?.emitRaw(`${sentinel.slice(5)}\n`)

    await expect(run).resolves.toMatchObject({ exitCode: 0 })
  })

  it('shuts the shell down cleanly on dispose', async () => {
    const { instance, shells } = worker()
    const run = instance.run('x')
    shells[0]?.reply(1, 0)
    await run

    instance.dispose()
    expect(shells[0]?.end).toHaveBeenCalled()
    expect(shells[0]?.kill).toHaveBeenCalled()
  })

  it('is safe to dispose twice, and before anything ever ran', () => {
    const { instance } = worker()
    expect(() => {
      instance.dispose()
      instance.dispose()
    }).not.toThrow()
  })
})

describe('createResilientShellRunner', () => {
  it('uses the persistent worker while it is healthy', async () => {
    const workerRun = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const fallback = vi.fn()
    const run = createResilientShellRunner({ run: workerRun, dispose: vi.fn() }, fallback)

    await expect(run('x')).resolves.toEqual({ stdout: '', exitCode: 0 })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to a per-action spawn when the worker cannot be started', async () => {
    const workerRun = vi.fn().mockRejectedValue(new ConsoleWorkerUnavailableError('ENOENT'))
    const fallback = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const run = createResilientShellRunner({ run: workerRun, dispose: vi.fn() }, fallback)

    await expect(run('x')).resolves.toEqual({ stdout: '', exitCode: 0 })
    expect(fallback).toHaveBeenCalledWith('x')
  })

  it('never re-runs a command the worker already executed', async () => {
    // A non-zero exit means the command RAN and failed. Retrying it on a fresh
    // shell would type the same keystrokes into the session a second time.
    const workerRun = vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
    const fallback = vi.fn()
    const run = createResilientShellRunner({ run: workerRun, dispose: vi.fn() }, fallback)

    await expect(run('x')).resolves.toMatchObject({ exitCode: 1 })
    expect(fallback).not.toHaveBeenCalled()
  })
})
