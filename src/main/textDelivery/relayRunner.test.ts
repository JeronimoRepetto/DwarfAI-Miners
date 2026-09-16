import { describe, expect, it, vi } from 'vitest'
import {
  RELAY_MS_PER_CHAR,
  deliverViaRelay,
  relayTimeoutMsFor,
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

/*
 * Issue #439. A courier turn's own duration grows with the instruction, and a
 * fixed timeout eventually kills a turn whose only remaining work was to
 * exit. These four points pin the curve `relayTimeoutMsFor` draws: the two
 * measured turns (200 and 40,000 characters), MAX_CODEX_QUEUE_TEXT_CHARS
 * (15,359, contracts.ts — a familiar number in this codebase, though this
 * route has no such ceiling of its own), and MAX_DWARF_TEXT_CHARS (250,000,
 * the wire's own sanity ceiling — the longest message this function is ever
 * asked to time).
 */
describe('relayTimeoutMsFor', () => {
  const BASE_MS = 60_000 // SENDTEXT_TIMEOUT_S's default, in milliseconds.

  it('names the per-character rate this app actually budgets', () => {
    // Comfortably above the measured (155,000 - 6,400) / (40,000 - 200) ≈
    // 3.73 ms/char, deliberately not pinned to it.
    expect(RELAY_MS_PER_CHAR).toBe(5)
  })

  it('adds the base to a 200-character message (the short measurement)', () => {
    expect(relayTimeoutMsFor(BASE_MS, 200)).toBe(61_000)
  })

  it('scales for 15,359 characters (MAX_CODEX_QUEUE_TEXT_CHARS)', () => {
    expect(relayTimeoutMsFor(BASE_MS, 15_359)).toBe(136_795)
  })

  it('gives the 40,000-character measurement a comfortable margin over the 155s it took', () => {
    const timeoutMs = relayTimeoutMsFor(BASE_MS, 40_000)
    expect(timeoutMs).toBe(260_000)
    expect(timeoutMs).toBeGreaterThan(155_000)
  })

  it('shows the budget the wire sanity ceiling implies, at 250,000 characters', () => {
    // Documented in docs/guide.md: about 21.8 minutes at the default base.
    expect(relayTimeoutMsFor(BASE_MS, 250_000)).toBe(1_310_000)
  })

  it('is the base alone for an empty message', () => {
    expect(relayTimeoutMsFor(BASE_MS, 0)).toBe(BASE_MS)
  })
})

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

  // AMENDED for #439 (was: 'names the timeout rather than claiming nothing was
  // handed over', asserting only `delivered: false` and an error matching
  // /timed out/i). A courier killed by ITS OWN timeout may already have
  // called SendMessage before the kill landed — the delivery happens partway
  // through the turn, before the courier's own reply — so this is no longer
  // reported as an ordinary failure. `unconfirmed` says so, and the panel
  // reads it to draw a ✓ with its own sentence rather than a ✕ with `Send
  // again` (see the renderer's deliveryVerdict.ts and useDwarfMessaging.ts).
  it('calls a killed relay unconfirmed, never a proven failure', async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 1, timedOut: true })
    const outcome = await deliverViaRelay(options(run))
    expect(outcome.delivered).toBe(false)
    expect(outcome.unconfirmed).toBe(true)
    expect(outcome.error).toBe('The relay did not confirm in time; the message may have arrived.')
    expect(outcome.neverStarted).toBeUndefined()
  })

  it("scales the child's own timeout with the message, rather than passing the base through", async () => {
    const run = vi.fn<RelayRunner>().mockResolvedValue({ exitCode: 0, timedOut: false })
    const text = 'x'.repeat(15_359)
    await deliverViaRelay({ ...options(run), text })

    // options(run).timeoutMs is the 60,000ms BASE; relayTimeoutMsFor adds
    // RELAY_MS_PER_CHAR for every one of the 15,359 characters on top of it.
    expect(run.mock.calls[0]?.[0].timeoutMs).toBe(relayTimeoutMsFor(60_000, 15_359))
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
