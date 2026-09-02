import { describe, expect, it, vi } from 'vitest'
import {
  buildCodexQueueArgs,
  deliverViaCodexQueue,
  isShellShimPath,
  type CodexQueueInvocation,
  type CodexQueueResult
} from './codexQueue'

const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'
const BINARY = 'C:\\Users\\j\\.local\\bin\\codex.exe'

function runner(result: CodexQueueResult) {
  return vi.fn(async (_invocation: CodexQueueInvocation) => result)
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    text: 'run the tests',
    binaryPath: BINARY,
    timeoutMs: 20_000,
    run: runner({ exitCode: 0, timedOut: false }),
    ...overrides
  }
}

describe('buildCodexQueueArgs', () => {
  /**
   * `--thread` takes a "Session UUID or exact session name", and the two forms
   * resolve down different paths: a name needs an ACTIVE session, a UUID is a
   * thread-store lookup keyed on the rollout. The UUID is the one the provider
   * already holds, and the one that does not require the session to be attached
   * to anything.
   */
  it('addresses the thread by uuid and passes the message as one argument', () => {
    expect(buildCodexQueueArgs(THREAD_ID, 'run the tests')).toEqual([
      'queue',
      '--thread',
      THREAD_ID,
      '--message',
      'run the tests'
    ])
  })

  // Shell metacharacters, newlines and quotes travel as argv, never as a
  // command line: nothing here builds a string a shell would re-parse.
  it('carries a payload full of shell metacharacters through untouched', () => {
    const nasty = 'a & b | c > d ^ %PATH% "quoted" \n second line'
    expect(buildCodexQueueArgs(THREAD_ID, nasty)[4]).toBe(nasty)
  })
})

describe('isShellShimPath', () => {
  it('recognizes the npm-global .cmd and .bat shims Windows installs', () => {
    expect(isShellShimPath('C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd')).toBe(true)
    expect(isShellShimPath('C:\\tools\\CODEX.BAT')).toBe(true)
  })

  it('accepts a real executable', () => {
    expect(isShellShimPath(BINARY)).toBe(false)
    expect(isShellShimPath('/home/j/.local/bin/codex')).toBe(false)
  })
})

describe('deliverViaCodexQueue', () => {
  it('queues the message and reports it handed over', async () => {
    const run = runner({ exitCode: 0, timedOut: false })
    await expect(deliverViaCodexQueue(options({ run }))).resolves.toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: BINARY,
      args: buildCodexQueueArgs(THREAD_ID, 'run the tests'),
      timeoutMs: 20_000
    })
  })

  /**
   * The measured failure mode: an unknown or retired thread exits 1 with a
   * thread-store error on stderr and writes nothing. It is the one exit code
   * worth naming, because it is the one a user can act on — the session ended.
   */
  it('names a retired session when the thread store refuses the id', async () => {
    const outcome = await deliverViaCodexQueue(
      options({ run: runner({ exitCode: 1, timedOut: false }) })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('no longer')
  })

  it('reports any other non-zero exit with its code', async () => {
    const outcome = await deliverViaCodexQueue(
      options({ run: runner({ exitCode: 2, timedOut: false }) })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 2')
  })

  it('reports a timeout as a timeout, in seconds', async () => {
    const outcome = await deliverViaCodexQueue(
      options({ run: runner({ exitCode: 1, timedOut: true }), timeoutMs: 20_000 })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('timed out')
    expect(outcome.error).toContain('20s')
  })

  it('reports a spawn failure rather than rejecting', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const outcome = await deliverViaCodexQueue(options({ run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
  })

  it('refuses before spawning when codex was not detected at all', async () => {
    const run = runner({ exitCode: 0, timedOut: false })
    const outcome = await deliverViaCodexQueue(options({ binaryPath: undefined, run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be found')
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * A `.cmd`/`.bat` shim cannot be executed without handing the command line to
   * cmd.exe, which would re-parse the message: `%VAR%` would expand real
   * environment values into the payload and a stray quote could end the
   * argument. The relay's rule is that the worst a hostile payload achieves is
   * reaching the wrong session, never a command running — so the shim is
   * refused with the remedy, rather than run through a shell.
   */
  it('refuses a shell shim and names the override that fixes it', async () => {
    const run = runner({ exitCode: 0, timedOut: false })
    const outcome = await deliverViaCodexQueue(
      options({ binaryPath: 'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd', run })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('CODEX_CLI_PATH')
    expect(run).not.toHaveBeenCalled()
  })

  // The privacy rule the whole tier is built under: an outcome carries a
  // verdict and a reason, and there is no path by which it carries the payload.
  it('never echoes the message back in any outcome', async () => {
    const secret = 'sk-do-not-log-this-anywhere'
    const outcomes = await Promise.all([
      deliverViaCodexQueue(
        options({ text: secret, run: runner({ exitCode: 0, timedOut: false }) })
      ),
      deliverViaCodexQueue(
        options({ text: secret, run: runner({ exitCode: 1, timedOut: false }) })
      ),
      deliverViaCodexQueue(options({ text: secret, run: runner({ exitCode: 1, timedOut: true }) })),
      deliverViaCodexQueue(options({ text: secret, binaryPath: undefined })),
      deliverViaCodexQueue(options({ text: secret, binaryPath: 'C:\\npm\\codex.cmd' }))
    ])
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(secret)
    }
  })
})
