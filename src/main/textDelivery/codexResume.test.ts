import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  buildCodexResumeArgs,
  deliverViaCodexResume,
  CODEX_RESUME_START_WINDOW_MS,
  type CodexResumeInvocation,
  type CodexResumeResult
} from './codexResume'

const THREAD_ID = '01a0af41-d1c5-7621-ba46-75eaef3eaeb2'
const BINARY = 'C:\\Users\\j\\.local\\bin\\codex.exe'
const CWD = 'C:\\Users\\j\\projects\\sample-project'

function runner(result: CodexResumeResult) {
  return vi.fn(async (_invocation: CodexResumeInvocation) => result)
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    cwd: CWD,
    text: 'run the tests',
    binaryPath: BINARY,
    run: runner({ running: true }),
    // BINARY above is a plain .exe, so resolveProgram never reads this fake —
    // only the shim test below registers a file on its own copy.
    fs: new FakeFs(),
    ...overrides
  }
}

describe('buildCodexResumeArgs', () => {
  /**
   * The measured shape (#450, Codex CLI 0.153.4): `resume` continues the SAME
   * thread, and `-` is the documented "the prompt is on stdin" positional the
   * opening launch already uses (buildCodexLaunchArgs in sessionLaunch/launch.ts).
   */
  it('names the thread after resume and reads the prompt from stdin', () => {
    expect(buildCodexResumeArgs(THREAD_ID)).toEqual(['exec', 'resume', THREAD_ID, '-'])
  })

  /**
   * The argv trap, measured: `codex exec resume <id> -s read-only -` exits 2
   * with `unexpected argument '-s' found`. Options belong to `codex exec`, and
   * clap stops reading them the moment the subcommand is seen — the sibling of
   * the trap launch.ts already records for a flag written after the prompt.
   */
  it('puts every option before the resume subcommand, never after it', () => {
    const args = buildCodexResumeArgs(THREAD_ID, ['-m', 'gpt-5', '--skip-git-repo-check'])
    expect(args).toEqual(['exec', '-m', 'gpt-5', '--skip-git-repo-check', 'resume', THREAD_ID, '-'])
    expect(args.indexOf('resume')).toBeGreaterThan(args.indexOf('--skip-git-repo-check'))
  })

  /** The id is one argv element, so nothing about it is ever re-parsed. */
  it('carries the thread id as its own argument', () => {
    expect(buildCodexResumeArgs(THREAD_ID)[2]).toBe(THREAD_ID)
  })
})

describe('deliverViaCodexResume', () => {
  /**
   * The hand-over this tier can honestly report (#450): the process spawned,
   * took the message on stdin and was still alive when the start window
   * elapsed, so its turn has begun. Never a reaction — see reaction.ts.
   */
  it('reports the hand-over once the process survives the start window', async () => {
    const run = runner({ running: true })
    await expect(deliverViaCodexResume(options({ run }))).resolves.toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: BINARY,
      args: buildCodexResumeArgs(THREAD_ID),
      cwd: CWD,
      text: 'run the tests',
      startWindowMs: CODEX_RESUME_START_WINDOW_MS
    })
  })

  /**
   * The message travels on STDIN and nowhere else (#437): argv has a command
   * line limit and stdin has none, which is why this channel keeps the ordinary
   * wire ceiling rather than the Codex queue's argv-derived one.
   */
  it('carries the message on stdin, never as an argv element', async () => {
    const secret = 'a & b | c > d ^ %PATH% "quoted" \n second line'
    const run = runner({ running: true })
    await deliverViaCodexResume(options({ text: secret, run }))
    const invocation = run.mock.calls[0]![0]
    expect(invocation.text).toBe(secret)
    expect(invocation.args).not.toContain(secret)
    expect(invocation.args.join(' ')).not.toContain('quoted')
  })

  /** The window is injectable, so no test ever waits on a real clock. */
  it('takes an injected start window rather than the shipped constant', async () => {
    const run = runner({ running: true })
    await deliverViaCodexResume(options({ startWindowMs: 5, run }))
    expect(run.mock.calls[0]![0].startWindowMs).toBe(5)
  })

  /**
   * A turn short enough to finish inside the window still delivered its
   * message: exit 0 is Codex reporting the resumed turn ran.
   */
  it('reports a hand-over when the turn finished inside the window', async () => {
    const outcome = await deliverViaCodexResume(
      options({ run: runner({ running: false, exitCode: 0 }) })
    )
    expect(outcome).toEqual({ delivered: true })
  })

  /**
   * The failures the window exists to catch: an id Codex no longer knows, a
   * build with no `exec resume`, a folder it declines to run in. All of them
   * end the process before the first model call, and none of them delivered
   * anything.
   */
  it('refuses when the process died inside the window, naming its exit code', async () => {
    const outcome = await deliverViaCodexResume(
      options({ run: runner({ running: false, exitCode: 2 }) })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 2')
  })

  it('refuses when the process died inside the window by a signal, with no code to name', async () => {
    const outcome = await deliverViaCodexResume(options({ run: runner({ running: false }) }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('stopped')
    expect(outcome.error).not.toContain('undefined')
  })

  it('reports a spawn failure rather than rejecting', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const outcome = await deliverViaCodexResume(options({ run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
  })

  it('refuses before spawning when codex was not detected at all', async () => {
    const run = runner({ running: true })
    const outcome = await deliverViaCodexResume(options({ binaryPath: undefined, run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be found')
    expect(run).not.toHaveBeenCalled()
  })

  // The privacy rule every delivery tier is built under: an outcome carries a
  // verdict and a sentence, and there is no field a payload could travel in.
  it('never echoes the message back in any outcome', async () => {
    const secret = 'sk-do-not-log-this-anywhere'
    const outcomes = await Promise.all([
      deliverViaCodexResume(options({ text: secret, run: runner({ running: true }) })),
      deliverViaCodexResume(
        options({ text: secret, run: runner({ running: false, exitCode: 2 }) })
      ),
      deliverViaCodexResume(options({ text: secret, binaryPath: undefined })),
      deliverViaCodexResume(options({ text: secret, binaryPath: 'C:\\npm\\codex.cmd' }))
    ])
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(secret)
    }
  })
})

/*
 * The same shim resolution the queue tier takes (#193, #413): a `.cmd`/`.bat`
 * shim is read for the program it names and THAT is run, with no shell. The
 * exhaustive coverage of `resolveProgram` lives in codexQueue.test.ts; what
 * this pins is that this tier goes through it rather than spawning the shim.
 */
describe('deliverViaCodexResume resolving a shim (#413)', () => {
  const NPM_DIR = 'C:\\Users\\j\\AppData\\Roaming\\npm'
  const NPM_SHIM = `${NPM_DIR}\\codex.cmd`
  const NPM_ENTRY = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`
  const NPM_SHIM_TEXT = [
    '@ECHO off',
    'SETLOCAL',
    'SET "_prog=node"',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
  ].join('\r\n')

  it("resolves npm's shim to node and its entry, then the resume argv", async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const run = runner({ running: true })

    const outcome = await deliverViaCodexResume(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: 'node',
      args: [NPM_ENTRY, 'exec', 'resume', THREAD_ID, '-'],
      cwd: CWD,
      text: 'run the tests',
      startWindowMs: CODEX_RESUME_START_WINDOW_MS
    })
  })

  it('fails closed and never spawns when the shim cannot be read at all', async () => {
    // NPM_SHIM is never registered on this fake, so the read itself rejects.
    const fs = new FakeFs()
    const run = runner({ running: true })

    const outcome = await deliverViaCodexResume(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(run).not.toHaveBeenCalled()
  })
})
