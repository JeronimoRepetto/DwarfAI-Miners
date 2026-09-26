import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  buildCodexResumeArgs,
  buildCodexResumeSpawn,
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

/**
 * #640. The same PWD-following shape #640 measured for OpenCode's `run` is
 * not proven for Codex — Codex reads its real cwd — but the fix is applied
 * here too (harmless for a CLI that ignores it, and one shared rule rather
 * than a fourth provider-specific branch). `runCodexResumeProcess` used to
 * spawn with no `env` at all, which inherits this app's whole environment
 * untouched, PWD included; the pure builder below is the spawn call as a
 * VALUE, the same split launchRunner's buildLaunchSpawn already keeps.
 */
describe('buildCodexResumeSpawn', () => {
  const INVOCATION: CodexResumeInvocation = {
    command: BINARY,
    args: buildCodexResumeArgs(THREAD_ID),
    cwd: CWD,
    text: 'run the tests',
    startWindowMs: CODEX_RESUME_START_WINDOW_MS
  }

  it('spawns exactly the command, args and cwd it was given', () => {
    const call = buildCodexResumeSpawn(INVOCATION, {})
    expect(call.command).toBe(BINARY)
    expect(call.args).toEqual(buildCodexResumeArgs(THREAD_ID))
    expect(call.options.cwd).toBe(CWD)
  })

  it('sets PWD to the same cwd it is about to spawn in', () => {
    const call = buildCodexResumeSpawn(INVOCATION, { PATH: '/usr/bin' })
    expect(call.options.env).toEqual({ PATH: '/usr/bin', PWD: CWD })
  })

  it('overrides an inherited PWD that names a different folder', () => {
    const call = buildCodexResumeSpawn(INVOCATION, {
      PATH: '/usr/bin',
      PWD: '/home/j/some/other/shell/folder'
    })
    expect(call.options.env).toEqual({ PATH: '/usr/bin', PWD: CWD })
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

  // AMENDED for #502: also asserts the path tried and the cause.
  it('reports a spawn failure rather than rejecting, naming the path and cause', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const outcome = await deliverViaCodexResume(options({ run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(outcome.error).toContain(BINARY)
    expect(outcome.error).toContain('ENOENT')
  })

  it('refuses before spawning when codex was not detected at all', async () => {
    const run = runner({ running: true })
    const outcome = await deliverViaCodexResume(options({ binaryPath: undefined, run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be found')
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * Issue #462: a tuned resume carries its model/effort exactly where the
   * launch's own argv does — BEFORE `resume`, never after (the measured clap
   * trap `buildCodexResumeArgs`'s own describe pins above).
   */
  it('carries a tuned model and effort before the resume subcommand', async () => {
    const run = runner({ running: true })
    await deliverViaCodexResume(options({ tuning: { model: 'gpt-5.6-sol', effort: 'high' }, run }))
    const invocation = run.mock.calls[0]![0]
    expect(invocation.args).toEqual([
      'exec',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high',
      'resume',
      THREAD_ID,
      '-'
    ])
    expect(invocation.args.indexOf('resume')).toBeGreaterThan(
      invocation.args.indexOf('model_reasoning_effort=high')
    )
  })

  /**
   * The spec's byte-identical requirement: an empty tuning and an absent one
   * must produce the exact same argv the channel had before this issue.
   */
  it('stays byte-identical to the untuned argv when tuning is empty or absent', async () => {
    const run = runner({ running: true })
    await deliverViaCodexResume(options({ tuning: {}, run }))
    expect(run.mock.calls[0]![0].args).toEqual(['exec', 'resume', THREAD_ID, '-'])

    const runAbsent = runner({ running: true })
    await deliverViaCodexResume(options({ run: runAbsent }))
    expect(runAbsent.mock.calls[0]![0].args).toEqual(['exec', 'resume', THREAD_ID, '-'])
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

  // AMENDED for #502: also asserts the shim's own path is named.
  it('fails closed and never spawns when the shim cannot be read at all', async () => {
    // NPM_SHIM is never registered on this fake, so the read itself rejects.
    const fs = new FakeFs()
    const run = runner({ running: true })

    const outcome = await deliverViaCodexResume(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(outcome.error).toContain(NPM_SHIM)
    expect(run).not.toHaveBeenCalled()
  })
})

/**
 * What a resumed turn still owes the panel after it has answered (#457).
 *
 * The start window says the turn BEGAN; nothing said when it ended, and the
 * process was left running with no handle kept. That was enough until a second
 * measurement (2026-09-18, codex-cli 0.153.4): a resume started while a turn is
 * already running on that thread exits 1 at once, and Codex queues nothing —
 * so the panel has to know when a turn ends before it may start another.
 */
describe('deliverViaCodexResume reporting when the turn itself ends (#457)', () => {
  it('hands up the ending of a turn that is still running', async () => {
    let end = (): void => {}
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    const outcome = await deliverViaCodexResume(options({ run: runner({ running: true, ended }) }))

    expect(outcome.delivered).toBe(true)
    expect(outcome.turnEnded).toBeDefined()
    let settled = false
    void outcome.turnEnded?.then(() => {
      settled = true
    })
    end()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('reports no ending for a turn that had already ended inside the window', async () => {
    // Exit 0 inside the start window is a turn that finished, so there is
    // nothing left to wait for and nothing to say about a thread that is
    // already free.
    const outcome = await deliverViaCodexResume(
      options({ run: runner({ running: false, exitCode: 0 }) })
    )
    expect(outcome.delivered).toBe(true)
    expect(outcome.turnEnded).toBeUndefined()
  })

  it('reports no ending for a runner that cannot see one', async () => {
    // A runner with no `ended` at all states a true thing about itself, and
    // the caller then tracks nothing rather than waiting on a turn it cannot
    // see finish.
    const outcome = await deliverViaCodexResume(options({ run: runner({ running: true }) }))
    expect(outcome.turnEnded).toBeUndefined()
  })
})

/**
 * Which refusal it was, in Codex's own words (#457).
 *
 * "It may no longer know that session" was the one explanation #450 had for
 * exit 1. The 2026-09-18 measurement adds a second — a turn already running on
 * that thread — and stderr was discarded, so this tier could not tell them
 * apart and named the wrong one half the time. It still does not GUESS: it
 * reads a bounded, redacted tail and lets the CLI say which.
 */
describe('deliverViaCodexResume saying why codex refused (#457)', () => {
  it('quotes what codex said rather than naming a cause it cannot know', async () => {
    const outcome = await deliverViaCodexResume(
      options({
        run: runner({
          running: false,
          exitCode: 1,
          stderrTail: 'Error: a turn is already running on this session'
        })
      })
    )

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 1')
    expect(outcome.error).toContain('a turn is already running on this session')
  })

  it('keeps one honest sentence when codex said nothing at all', async () => {
    const outcome = await deliverViaCodexResume(
      options({ run: runner({ running: false, exitCode: 1, stderrTail: '   ' }) })
    )

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 1')
    // Neither cause is asserted over the other, because neither is known.
    expect(outcome.error).toMatch(/a turn may already be running/i)
    expect(outcome.error).toMatch(/may no longer know it/i)
  })

  it('redacts and caps what it quotes, exactly as every other captured text is', async () => {
    const outcome = await deliverViaCodexResume(
      options({
        run: runner({
          running: false,
          exitCode: 1,
          stderrTail: `Error: bad key sk-${'a'.repeat(40)} in ${'x'.repeat(600)}`
        })
      })
    )

    expect(outcome.error).not.toContain('a'.repeat(40))
    expect(outcome.error!.length).toBeLessThan(500)
  })
})
