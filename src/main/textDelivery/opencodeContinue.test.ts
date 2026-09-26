import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  buildOpenCodeContinueArgs,
  buildOpenCodeContinueSpawn,
  deliverViaOpenCodeContinue,
  OPENCODE_CONTINUE_START_WINDOW_MS,
  type OpenCodeContinueInvocation,
  type OpenCodeContinueResult
} from './opencodeContinue'

const SESSION_ID = 'ses_f3b6efd4dffeEeQQKDLkwjGTyL'
const BINARY = 'C:\\Users\\j\\.local\\bin\\opencode.exe'
const CWD = 'C:\\Users\\j\\projects\\sample-project'

function runner(result: OpenCodeContinueResult) {
  return vi.fn(async (_invocation: OpenCodeContinueInvocation) => result)
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
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

describe('buildOpenCodeContinueArgs', () => {
  /**
   * The measured shape (#534, M4, OpenCode 1.18.31): `--session` continues
   * the SAME session, and the message travels on stdin — no positional
   * argument is ever passed, exactly as the opening launch already does
   * (buildOpenCodeLaunchArgs in domain/launch.ts).
   */
  it('names the session after --session and reads the prompt from stdin', () => {
    expect(buildOpenCodeContinueArgs(SESSION_ID)).toEqual([
      'run',
      '--session',
      SESSION_ID,
      '--format',
      'json'
    ])
  })

  /** The id is one argv element, so nothing about it is ever re-parsed. */
  it('carries the session id as its own argument', () => {
    expect(buildOpenCodeContinueArgs(SESSION_ID)[2]).toBe(SESSION_ID)
  })
})

/**
 * #640. OpenCode 1.18.32's own `run` (this continuation's own argv, see
 * buildOpenCodeContinueArgs) reads a NEW session's directory from `PWD`, not
 * from the process's real cwd — measured live against the opening launch's
 * own repro. `runOpenCodeContinueProcess` used to spawn with no `env` at all,
 * which inherits this app's whole environment untouched, PWD included; the
 * pure builder below is the spawn call as a VALUE (the same split
 * launchRunner's buildLaunchSpawn and nodeHostedProcess's buildHostedSpawn
 * already keep), so the fix is a plain assertion instead of a real spawn.
 */
describe('buildOpenCodeContinueSpawn', () => {
  const INVOCATION: OpenCodeContinueInvocation = {
    command: BINARY,
    args: buildOpenCodeContinueArgs(SESSION_ID),
    cwd: CWD,
    text: 'run the tests',
    startWindowMs: OPENCODE_CONTINUE_START_WINDOW_MS
  }

  it('spawns exactly the command, args and cwd it was given', () => {
    const call = buildOpenCodeContinueSpawn(INVOCATION, {})
    expect(call.command).toBe(BINARY)
    expect(call.args).toEqual(buildOpenCodeContinueArgs(SESSION_ID))
    expect(call.options.cwd).toBe(CWD)
  })

  it('sets PWD to the same cwd it is about to spawn in', () => {
    const call = buildOpenCodeContinueSpawn(INVOCATION, { PATH: '/usr/bin' })
    expect(call.options.env).toEqual({ PATH: '/usr/bin', PWD: CWD })
  })

  it('overrides an inherited PWD that names a different folder', () => {
    const call = buildOpenCodeContinueSpawn(INVOCATION, {
      PATH: '/usr/bin',
      PWD: '/home/j/some/other/shell/folder'
    })
    expect(call.options.env).toEqual({ PATH: '/usr/bin', PWD: CWD })
  })
})

describe('deliverViaOpenCodeContinue', () => {
  /**
   * The hand-over this tier can honestly report (#534): the process spawned,
   * took the message on stdin and was still alive when the start window
   * elapsed, so its turn has begun. Never a reaction — see reaction.ts.
   */
  it('reports the hand-over once the process survives the start window', async () => {
    const run = runner({ running: true })
    await expect(deliverViaOpenCodeContinue(options({ run }))).resolves.toEqual({
      delivered: true
    })
    expect(run).toHaveBeenCalledWith({
      command: BINARY,
      args: buildOpenCodeContinueArgs(SESSION_ID),
      cwd: CWD,
      text: 'run the tests',
      startWindowMs: OPENCODE_CONTINUE_START_WINDOW_MS
    })
  })

  /**
   * The message travels on STDIN and nowhere else (M9): argv has a command
   * line limit and stdin has none.
   */
  it('carries the message on stdin, never as an argv element', async () => {
    const secret = 'a & b | c > d ^ %PATH% "quoted" \n second line'
    const run = runner({ running: true })
    await deliverViaOpenCodeContinue(options({ text: secret, run }))
    const invocation = run.mock.calls[0]![0]
    expect(invocation.text).toBe(secret)
    expect(invocation.args).not.toContain(secret)
    expect(invocation.args.join(' ')).not.toContain('quoted')
  })

  /** The window is injectable, so no test ever waits on a real clock. */
  it('takes an injected start window rather than the shipped constant', async () => {
    const run = runner({ running: true })
    await deliverViaOpenCodeContinue(options({ startWindowMs: 5, run }))
    expect(run.mock.calls[0]![0].startWindowMs).toBe(5)
  })

  /**
   * A turn short enough to finish inside the window still delivered its
   * message: exit 0 is OpenCode reporting the continued turn ran (M3, M4).
   */
  it('reports a hand-over when the turn finished inside the window', async () => {
    const outcome = await deliverViaOpenCodeContinue(
      options({ run: runner({ running: false, exitCode: 0 }) })
    )
    expect(outcome).toEqual({ delivered: true })
  })

  it('refuses when the process died inside the window, naming its exit code', async () => {
    const outcome = await deliverViaOpenCodeContinue(
      options({ run: runner({ running: false, exitCode: 2 }) })
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 2')
  })

  it('refuses when the process died inside the window by a signal, with no code to name', async () => {
    const outcome = await deliverViaOpenCodeContinue(options({ run: runner({ running: false }) }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('stopped')
    expect(outcome.error).not.toContain('undefined')
  })

  it('reports a spawn failure rather than rejecting, naming the path and cause', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const outcome = await deliverViaOpenCodeContinue(options({ run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(outcome.error).toContain(BINARY)
    expect(outcome.error).toContain('ENOENT')
  })

  it('refuses before spawning when opencode was not detected at all', async () => {
    const run = runner({ running: true })
    const outcome = await deliverViaOpenCodeContinue(options({ binaryPath: undefined, run }))
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be found')
    expect(run).not.toHaveBeenCalled()
  })

  // The privacy rule every delivery tier is built under: an outcome carries a
  // verdict and a sentence, and there is no field a payload could travel in.
  it('never echoes the message back in any outcome', async () => {
    const secret = 'sk-do-not-log-this-anywhere'
    const outcomes = await Promise.all([
      deliverViaOpenCodeContinue(options({ text: secret, run: runner({ running: true }) })),
      deliverViaOpenCodeContinue(
        options({ text: secret, run: runner({ running: false, exitCode: 2 }) })
      ),
      deliverViaOpenCodeContinue(options({ text: secret, binaryPath: undefined })),
      deliverViaOpenCodeContinue(options({ text: secret, binaryPath: 'C:\\npm\\opencode.cmd' }))
    ])
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(secret)
    }
  })
})

/*
 * The same shim resolution the Codex tiers take (#193, #413): a `.cmd`/`.bat`
 * shim is read for the program it names and THAT is run, with no shell.
 */
describe('deliverViaOpenCodeContinue resolving a shim (#413)', () => {
  const NPM_DIR = 'C:\\Users\\j\\AppData\\Roaming\\npm'
  const NPM_SHIM = `${NPM_DIR}\\opencode.cmd`
  const NPM_ENTRY = `${NPM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
  const NPM_SHIM_TEXT = [
    '@ECHO off',
    'SETLOCAL',
    'SET "_prog=node"',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*'
  ].join('\r\n')

  it("resolves npm's shim to node and its entry, then the continue argv", async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const run = runner({ running: true })

    const outcome = await deliverViaOpenCodeContinue(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: 'node',
      args: [NPM_ENTRY, 'run', '--session', SESSION_ID, '--format', 'json'],
      cwd: CWD,
      text: 'run the tests',
      startWindowMs: OPENCODE_CONTINUE_START_WINDOW_MS
    })
  })

  it('fails closed and never spawns when the shim cannot be read at all', async () => {
    // NPM_SHIM is never registered on this fake, so the read itself rejects.
    const fs = new FakeFs()
    const run = runner({ running: true })

    const outcome = await deliverViaOpenCodeContinue(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(outcome.error).toContain(NPM_SHIM)
    expect(run).not.toHaveBeenCalled()
  })
})

/**
 * What a continued turn still owes the panel after it has answered (#534,
 * mirroring #457): the start window says the turn BEGAN; nothing said when
 * it ended, and the process was left running with no handle kept. A second
 * continuation started while one is already running is not refused —
 * measured to race rather than queue cleanly (M6) — so the panel has to know
 * when a turn ends before it may start another.
 */
describe('deliverViaOpenCodeContinue reporting when the turn itself ends (#534)', () => {
  it('hands up the ending of a turn that is still running', async () => {
    let end = (): void => {}
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    const outcome = await deliverViaOpenCodeContinue(
      options({ run: runner({ running: true, ended }) })
    )

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
    const outcome = await deliverViaOpenCodeContinue(
      options({ run: runner({ running: false, exitCode: 0 }) })
    )
    expect(outcome.delivered).toBe(true)
    expect(outcome.turnEnded).toBeUndefined()
  })

  it('reports no ending for a runner that cannot see one', async () => {
    const outcome = await deliverViaOpenCodeContinue(options({ run: runner({ running: true }) }))
    expect(outcome.turnEnded).toBeUndefined()
  })
})

/**
 * Why a continued turn refused, in OpenCode's own words where it left any
 * (#534).
 *
 * Unlike Codex — where a concurrent resume exits 1 at once — M6 found
 * OpenCode ACCEPTS a concurrent `--session` call and races rather than
 * refusing it. So a non-zero exit here is never explained as "a turn may
 * already be running": that cause was measured out for this CLI. The
 * sentence quotes OpenCode's own stderr when there is any, and names the
 * uncertainty honestly when there is none, rather than asserting a cause
 * from Codex's own shape.
 */
describe('deliverViaOpenCodeContinue saying why opencode refused (#534)', () => {
  it('quotes what opencode said rather than naming a cause it cannot know', async () => {
    const outcome = await deliverViaOpenCodeContinue(
      options({
        run: runner({
          running: false,
          exitCode: 1,
          stderrTail: 'Error: session ses_unknown not found'
        })
      })
    )

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 1')
    expect(outcome.error).toContain('session ses_unknown not found')
  })

  it('keeps one honest sentence when opencode said nothing at all, never guessing a busy turn', async () => {
    const outcome = await deliverViaOpenCodeContinue(
      options({ run: runner({ running: false, exitCode: 1, stderrTail: '   ' }) })
    )

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('exit 1')
    // M6 ruled this cause out for OpenCode: a concurrent continuation races
    // rather than being refused, so nothing here may claim that is why.
    expect(outcome.error).not.toMatch(/already running/i)
  })

  it('redacts and caps what it quotes, exactly as every other captured text is', async () => {
    const outcome = await deliverViaOpenCodeContinue(
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
