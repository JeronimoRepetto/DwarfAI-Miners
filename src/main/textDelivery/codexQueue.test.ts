import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  buildCodexQueueArgs,
  deliverViaCodexQueue,
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
    // BINARY above is a plain .exe, so resolveProgram never reads this fake —
    // only the shim-resolution tests below register files on their own copy.
    fs: new FakeFs(),
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

/*
 * Issue #413. Until this issue a detected `.cmd`/`.bat` shim was refused
 * outright here (the deleted `isShellShimPath` / `SHIM_REFUSED`, and its own
 * two tests above went with them), naming CODEX_CLI_PATH as the only exit — one
 * a packaged user has no Settings UI to take. #193 had already solved the exact
 * same problem for the launcher: read the shim for the program it names, run
 * THAT with no shell. `resolveProgram` (platform/cliDetection.ts) is that
 * resolution, lifted out so this tier can share it rather than staying refused
 * for the one platform Codex is documented to be installed on with npm or pnpm.
 */
describe('deliverViaCodexQueue resolving a shim (#413)', () => {
  const NPM_DIR = 'C:\\Users\\j\\AppData\\Roaming\\npm'
  const NPM_SHIM = `${NPM_DIR}\\codex.cmd`
  const NPM_ENTRY = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`
  const NPM_SHIM_TEXT = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
  ].join('\r\n')

  // pnpm's global bin, verified against this machine's real shim (issue #413).
  const PNPM_DIR = 'C:\\Users\\j\\AppData\\Local\\pnpm\\bin'
  const PNPM_SHIM = `${PNPM_DIR}\\codex.CMD`
  const PNPM_ENTRY =
    'C:\\Users\\j\\AppData\\Local\\pnpm\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js'
  const PNPM_SHIM_TEXT = [
    '@SETLOCAL',
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\..\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node  "%~dp0\\..\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ')'
  ].join('\r\n')

  /**
   * The exact shell metacharacters the old refusal existed to protect against:
   * `%USERPROFILE%` (a cmd.exe expansion a re-parsed command line would have
   * performed) and an embedded `"` (which could end an argument early). Both
   * must survive as ordinary bytes in one argv element.
   */
  const HOSTILE_TEXT = 'go to %USERPROFILE% and say "hi"'

  it("resolves npm's shim to node, its entry, then the queue argv — the message untouched", async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(
      options({ binaryPath: NPM_SHIM, text: HOSTILE_TEXT, fs, run })
    )

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: 'node',
      args: [NPM_ENTRY, 'queue', '--thread', THREAD_ID, '--message', HOSTILE_TEXT],
      timeoutMs: 20_000
    })
    // Never handed to a shell to re-parse: the hostile text is exactly one
    // argv element, byte for byte, never a substring of a bigger one.
    expect(run.mock.calls[0]![0].args.at(-1)).toBe(HOSTILE_TEXT)
  })

  it("resolves pnpm's shim, preferring the bundled node.exe when one sits beside it", async () => {
    const fs = new FakeFs()
    fs.addFile(PNPM_SHIM, PNPM_SHIM_TEXT)
    fs.addFile(`${PNPM_DIR}\\node.exe`, 'MZ')
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(
      options({ binaryPath: PNPM_SHIM, text: HOSTILE_TEXT, fs, run })
    )

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: `${PNPM_DIR}\\node.exe`,
      args: [PNPM_ENTRY, 'queue', '--thread', THREAD_ID, '--message', HOSTILE_TEXT],
      timeoutMs: 20_000
    })
  })

  it("falls back to node from PATH when no node.exe sits beside pnpm's shim", async () => {
    const fs = new FakeFs()
    fs.addFile(PNPM_SHIM, PNPM_SHIM_TEXT)
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(options({ binaryPath: PNPM_SHIM, fs, run }))

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: 'node',
      args: [PNPM_ENTRY, 'queue', '--thread', THREAD_ID, '--message', 'run the tests'],
      timeoutMs: 20_000
    })
  })

  it('fails closed and never spawns when the shim can be read but names no JS entry', async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, '@echo off\r\nrem nothing to run here\r\n')
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(run).not.toHaveBeenCalled()
  })

  it('fails closed and never spawns when the shim cannot be read at all', async () => {
    // NPM_SHIM is never registered on this fake, so the read itself rejects.
    const fs = new FakeFs()
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(options({ binaryPath: NPM_SHIM, fs, run }))

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves a plain .exe path unchanged, reading no shim at all', async () => {
    // The base options() binary is already a real .exe; this pins that the
    // shim-resolution path added by #413 changes nothing about it.
    const run = runner({ exitCode: 0, timedOut: false })

    const outcome = await deliverViaCodexQueue(options({ run }))

    expect(outcome).toEqual({ delivered: true })
    expect(run).toHaveBeenCalledWith({
      command: BINARY,
      args: buildCodexQueueArgs(THREAD_ID, 'run the tests'),
      timeoutMs: 20_000
    })
  })
})
