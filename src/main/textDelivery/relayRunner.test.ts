import { describe, expect, it, vi } from 'vitest'
import {
  deliverViaRelay,
  runRelayProcess,
  type RelayExecFile,
  type RelayRunner
} from './relayRunner'

/*
 * Issue #437. The relay used to hand its whole courier instruction — the
 * person's message inside it — to `claude -p` as an argv element, which made
 * Windows' 32,767-character command line the bound on a MESSAGE. `-p` takes no
 * positional prompt now and the instruction is written to the child's stdin,
 * which has no such bound; measured live on 2026-09-16, a 40,000-character
 * message arrived at the target session as one whole SendMessage
 * (docs/console-hosting.md §6).
 *
 * These pin the spawn SHAPE, because that is the whole of the change: nothing
 * of the instruction in argv, the instruction on stdin as UTF-8, and stdin
 * closed after the write so the turn can start.
 */

/** A recording `execFile` that never starts a process. */
function fakeExecFile(
  settle: (
    callback: (error: (Error & { killed?: boolean; code?: number }) | null) => void
  ) => void = (callback) => callback(null)
) {
  const stdinEnd = vi.fn()
  const stdinOnError = vi.fn()
  const calls: {
    command: string
    args: readonly string[]
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
  }[] = []
  const execFile: RelayExecFile = (command, args, options, callback) => {
    calls.push({ command, args, options })
    queueMicrotask(() => settle(callback))
    return { stdin: { on: stdinOnError, end: stdinEnd } }
  }
  return { execFile, calls, stdinEnd, stdinOnError }
}

const invocation = {
  command: 'C:\\claude.exe',
  args: ['-p', '--model', 'haiku', '--tools', 'ListAgents,SendMessage', '--safe-mode'],
  instruction: 'FORWARD THIS PLEASE',
  env: { PATH: 'C:\\bin' },
  cwd: 'C:\\Users\\j',
  timeoutMs: 60_000
}

describe('runRelayProcess', () => {
  it('puts nothing of the instruction in argv', async () => {
    const fake = fakeExecFile()
    await runRelayProcess({ ...invocation }, fake.execFile)

    const call = fake.calls[0]
    expect(call?.args).toEqual([
      '-p',
      '--model',
      'haiku',
      '--tools',
      'ListAgents,SendMessage',
      '--safe-mode'
    ])
    expect(call?.args.join(' ')).not.toContain('FORWARD THIS PLEASE')
  })

  it('writes the instruction to the child stdin as UTF-8 and closes it', async () => {
    const fake = fakeExecFile()
    await runRelayProcess({ ...invocation }, fake.execFile)

    // `end` and not `write`: the relay reads one prompt and a stream still open
    // is a turn that never starts.
    expect(fake.stdinEnd).toHaveBeenCalledTimes(1)
    expect(fake.stdinEnd).toHaveBeenCalledWith('FORWARD THIS PLEASE', 'utf8')
  })

  it('swallows a broken pipe rather than taking the main process down', async () => {
    const fake = fakeExecFile()
    await runRelayProcess({ ...invocation }, fake.execFile)
    expect(fake.stdinOnError).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('keeps the flags, the folder, the environment and the timeout', async () => {
    const fake = fakeExecFile()
    await runRelayProcess({ ...invocation }, fake.execFile)

    const call = fake.calls[0]
    expect(call?.command).toBe('C:\\claude.exe')
    expect(call?.options.cwd).toBe('C:\\Users\\j')
    expect(call?.options.env.PATH).toBe('C:\\bin')
    expect(call?.options.timeout).toBe(60_000)
  })

  it('reports a clean turn', async () => {
    const fake = fakeExecFile()
    await expect(runRelayProcess({ ...invocation }, fake.execFile)).resolves.toEqual({
      exitCode: 0,
      timedOut: false
    })
  })

  it('reads a timeout kill off `killed`, which carries no exit code', async () => {
    const fake = fakeExecFile((callback) => {
      const error = new Error('killed') as Error & { killed?: boolean }
      error.killed = true
      callback(error)
    })
    await expect(runRelayProcess({ ...invocation }, fake.execFile)).resolves.toEqual({
      exitCode: 1,
      timedOut: true
    })
  })

  it('passes a non-zero exit through as itself', async () => {
    const fake = fakeExecFile((callback) => {
      const error = new Error('exited') as Error & { code?: number }
      error.code = 2
      callback(error)
    })
    await expect(runRelayProcess({ ...invocation }, fake.execFile)).resolves.toEqual({
      exitCode: 2,
      timedOut: false
    })
  })

  it('rejects when the binary could not be started at all', async () => {
    const fake = fakeExecFile((callback) => callback(new Error('ENOENT')))
    await expect(runRelayProcess({ ...invocation }, fake.execFile)).rejects.toThrow('ENOENT')
  })
})

describe('deliverViaRelay', () => {
  function options(run: RelayRunner) {
    return {
      sessionName: 'sample-project-70',
      text: 'run the tests',
      home: 'C:\\Users\\j',
      env: { PATH: 'C:\\Windows' },
      platform: 'win32' as const,
      model: 'haiku',
      timeoutMs: 60_000,
      run
    }
  }

  it('hands the courier instruction over as stdin, never as an argument', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 0, timedOut: false })
    await expect(deliverViaRelay(options(run))).resolves.toEqual({ delivered: true })

    const call = run.mock.calls[0]?.[0]
    expect(call?.instruction).toContain('sample-project-70')
    expect(call?.instruction).toContain('run the tests')
    expect(call?.args.join(' ')).not.toContain('run the tests')
    expect(call?.args.join(' ')).not.toContain('sample-project-70')
  })

  it('still runs one non-interactive turn on the configured model, with two tools', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 0, timedOut: false })
    await deliverViaRelay(options(run))

    const args = run.mock.calls[0]?.[0].args ?? []
    expect(args).toContain('-p')
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    expect(args[args.indexOf('--tools') + 1]).toBe('ListAgents,SendMessage')
    expect(args).toContain('--safe-mode')
  })

  it('carries a 40,000-character message, which no argv could have', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 0, timedOut: false })
    const text = 'x'.repeat(40_000)
    await expect(deliverViaRelay({ ...options(run), text })).resolves.toEqual({ delivered: true })

    const call = run.mock.calls[0]?.[0]
    expect(call?.instruction).toContain(text)
    expect(call?.args.join(' ').length).toBeLessThan(200)
  })

  it('names the timeout rather than claiming nothing was handed over', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 1, timedOut: true })
    const outcome = await deliverViaRelay(options(run))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/timed out/i)
    expect(outcome.neverStarted).toBeUndefined()
  })

  it('leaves a non-zero exit unmarked, because the tool call may already have landed', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 2, timedOut: false })
    const outcome = await deliverViaRelay(options(run))
    expect(outcome.delivered).toBe(false)
    expect(outcome.neverStarted).toBeUndefined()
  })

  it('marks the one failure that proves nothing was handed over', async () => {
    // A binary that never ran cannot have made a SendMessage call, and that is
    // what licenses the console tier behind this to retry the same text (#308).
    const run = vi.fn<RelayRunner>().mockRejectedValue(new Error('ENOENT'))
    await expect(deliverViaRelay(options(run))).resolves.toMatchObject({
      delivered: false,
      neverStarted: true
    })
  })

  it('never echoes the message back in a failure', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 2, timedOut: false })
    const outcome = await deliverViaRelay({ ...options(run), text: 'my-secret-payload' })
    expect(outcome.error).not.toContain('my-secret-payload')
  })
})
