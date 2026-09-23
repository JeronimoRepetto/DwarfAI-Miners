import type { SpawnOptions } from 'node:child_process'
import { existsSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import type { LaunchTuning } from '../domain/launchTuning'
import { MAX_DWARF_TEXT_CHARS, type DwarfProvider } from '../domain/types'
import type { CliDetection, CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import type { LaunchedProcess, LaunchFailure } from './launchedSessions'
import {
  CONSOLE_HOSTING_PROGRAM,
  EARLY_FAILURE_WINDOW_MS,
  STDERR_TAIL_BYTES,
  STDOUT_TAIL_BYTES,
  createNodeDelegationConfigFile,
  createNodeStderrFile,
  createNodeStdoutFile,
  launchClaudeSession,
  runLaunchProcess,
  type DelegationConfigFile,
  type LaunchChild,
  type LaunchInvocation,
  type LaunchRunner,
  type SpawnLaunch,
  type StderrFile,
  type StdoutFile
} from './launchRunner'
import {
  codexDelegationConfigArgs,
  type DelegationInjectionContext
} from '../mcp/delegationInjection'

const CLAUDE_PATH = '/home/j/.local/bin/claude'
const CODEX_PATH = '/home/j/.local/bin/codex'
const OPENCODE_PATH = '/home/j/.local/bin/opencode'
const MINE_PATH = '/home/j/work/project'

/**
 * A fixed stand-in for Codex's own `-o` path (#510), injected through the
 * `launch()` helper below so every existing exact-argv assertion in this
 * file stays deterministic rather than matching a fresh `randomUUID()` path
 * on every run.
 */
const CODEX_OUTPUT_PATH = '/tmp/dwarfai-launch-codex-output-test.log'

/** npm's cmd-shim for opencode, the same shape the Codex fixture above is. */
const OPENCODE_SHIM_DIR = 'C:\\Users\\x\\AppData\\Roaming\\npm'
const OPENCODE_SHIM = `${OPENCODE_SHIM_DIR}\\opencode.cmd`
const OPENCODE_SHIM_ENTRY = `${OPENCODE_SHIM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
const OPENCODE_SHIM_TEXT = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*'
].join('\r\n')

/** npm's cmd-shim for codex, as `npm i -g @openai/codex` writes it on Windows. */
const NPM_DIR = 'C:\\Users\\x\\AppData\\Roaming\\npm'
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
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
].join('\r\n')

function shimDetector(path: string): CliDetector {
  return detector({ cli: 'codex', installed: true, path, source: 'convention' })
}

function detector(verdict: CliDetection): CliDetector {
  return { detect: vi.fn().mockResolvedValue(verdict), peek: vi.fn().mockReturnValue(verdict) }
}

function installed(): CliDetector {
  return detector({ cli: 'claude', installed: true, path: CLAUDE_PATH, source: 'convention' })
}

function installedCodex(): CliDetector {
  return detector({ cli: 'codex', installed: true, path: CODEX_PATH, source: 'convention' })
}

function installedOpenCode(): CliDetector {
  return detector({ cli: 'opencode', installed: true, path: OPENCODE_PATH, source: 'convention' })
}

function shimDetectorFor(cli: 'codex' | 'opencode', path: string): CliDetector {
  return detector({ cli, installed: true, path, source: 'convention' })
}

function launch(options: {
  provider?: DwarfProvider
  prompt?: string
  cli?: CliDetector
  // Typed as the port itself since #217: the runner reports what it started,
  // so that the panel can end it later. Was `(invocation) => Promise<void>`.
  run?: LaunchRunner
  env?: NodeJS.ProcessEnv
  platform?: Platform
  fs?: FsLike
  /**
   * The model and effort this launch asked for (#239). Spread rather than
   * always passed, so every test written before that issue exercises the
   * untuned path exactly as it did.
   */
  tuning?: LaunchTuning
  /**
   * Codex's own `-o` path generator (#510). Defaults to the fixed
   * `CODEX_OUTPUT_PATH` above so every test gets a deterministic value; a
   * test proving the generator itself overrides it.
   */
  codexOutputPath?: () => string
  /** #511 T4: the gate's own approved injection, or absent for an ordinary launch. */
  delegation?: DelegationInjectionContext
  /** #511 T4: the `--mcp-config` temp-file port; defaults to a deterministic in-memory fake. */
  delegationConfigFile?: DelegationConfigFile
}) {
  const run = options.run ?? vi.fn().mockResolvedValue(undefined)
  return {
    run,
    result: launchClaudeSession({
      provider: options.provider ?? 'claude',
      minePath: MINE_PATH,
      prompt: options.prompt ?? 'set up the build',
      detector: options.cli ?? installed(),
      env: options.env ?? { PATH: '/usr/bin' },
      platform: options.platform ?? 'linux',
      fs: options.fs ?? new FakeFs(),
      run,
      codexOutputPath: options.codexOutputPath ?? (() => CODEX_OUTPUT_PATH),
      ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
      ...(options.delegationConfigFile === undefined
        ? {}
        : { delegationConfigFile: options.delegationConfigFile }),
      ...(options.tuning === undefined ? {} : options.tuning)
    })
  }
}

/**
 * A deterministic in-memory `DelegationConfigFile` (#511 T4), on the same
 * terms `fakeStderrFile`/`fakeStdoutFile` below are: a real launch writes a
 * real temp JSON file for Claude's own `--mcp-config <file>`, and this suite
 * never touches disk for it.
 */
function fakeDelegationConfigFile(): DelegationConfigFile & {
  writtenAt: (path: string) => string | undefined
  removedPaths: () => string[]
} {
  const contents = new Map<string, string>()
  const removed: string[] = []
  let next = 0
  return {
    path: () => `fake-mcp-config-${next++}.json`,
    write: (path, text) => contents.set(path, text),
    remove: (path) => {
      contents.delete(path)
      removed.push(path)
    },
    writtenAt: (path) => contents.get(path),
    removedPaths: () => removed
  }
}

/** The argv the runner handed the spawn seam, for a recording `run` fake. */
function argvOf(run: LaunchRunner): string[] {
  const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
  return invocation.args
}

describe('launchClaudeSession', () => {
  it('starts the detected binary in the mine folder, with the prompt on stdin', async () => {
    const { run, result } = launch({ prompt: 'set up the build' })

    await expect(result).resolves.toEqual({ launched: true, provider: 'claude' })
    expect(run).toHaveBeenCalledTimes(1)
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    // cwd is the whole trick: aggregation groups sessions by cwd, so this is
    // what puts the new dwarf in the mine the user launched it from.
    expect(invocation.cwd).toBe(MINE_PATH)
    expect(invocation.command).toBe(CLAUDE_PATH)
    expect(invocation.stdin).toBe('set up the build')
  })

  it('never puts the prompt in argv, where any process on this machine could read it', async () => {
    const secret = 'rotate the deploy key'
    const { run, result } = launch({ prompt: secret })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args.join(' ')).not.toContain(secret)
    expect(invocation.args).not.toContain(secret)
  })

  it("leads the child's PATH with the binary's own directory", async () => {
    // Same reason the relay does it: a re-exec of `claude` inside the child
    // must find the real binary rather than a shim earlier on PATH.
    const { run, result } = launch({ env: { PATH: '/usr/bin' } })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.env.PATH).toBe('/home/j/.local/bin:/usr/bin')
  })

  // AMENDED for #431 (was: 'trims and caps the prompt before it reaches the
  // child', asserting the child's stdin came out at exactly
  // MAX_DWARF_TEXT_CHARS). The cap went with the bound it was borrowed from —
  // a launch prompt travels on stdin, never in argv, so no command line ever
  // bounded it. The TRIM is what this was really about, and is what it still
  // asserts.
  it('trims the prompt before it reaches the child, and cuts nothing off it', async () => {
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 100)
    const { run, result } = launch({ prompt: `  ${long}  ` })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.stdin).toBe(long)
  })

  it('refuses an empty prompt without probing the disk or spawning anything', async () => {
    const cli = installed()
    const { run, result } = launch({ prompt: '   ', cli })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'none',
      error: 'Type a prompt first.'
    })
    expect(run).not.toHaveBeenCalled()
    expect(cli.detect).not.toHaveBeenCalled()
  })

  /*
   * AMENDED for #534 (was: 'refuses OpenCode before ever probing the disk
   * for it', asserting the LAUNCHABLE_PROVIDERS gate refused OpenCode by
   * name before detect() ran — the state this test now proves the opposite
   * of). `run` on stdin landed (buildOpenCodeLaunchArgs, launch.ts), so a
   * detected OpenCode now starts exactly like Claude, Codex and Antigravity
   * above. That leaves the LAUNCHABLE_PROVIDERS gate itself with no real
   * provider left to prove it against — every DWARF_PROVIDERS member is
   * launchable now — the same conclusion launchProviders.test.ts's own
   * #237 comment already reached for NOT_LAUNCHABLE.
   */
  it('starts a detected OpenCode binary in the mine folder, with the prompt on stdin', async () => {
    const cli = installedOpenCode()
    const { run, result } = launch({ provider: 'opencode', cli, prompt: 'dig' })

    await expect(result).resolves.toEqual({ launched: true, provider: 'opencode' })
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(OPENCODE_PATH)
    // cwd is the whole trick here too (#534): the OpenCode observer reads
    // opencode.db's own `session.directory`, so this is what files the new
    // session under the right mine.
    expect(invocation.cwd).toBe(MINE_PATH)
    expect(invocation.args).toEqual(['run', '--format', 'json'])
    expect(invocation.stdin).toBe('dig')
  })

  it('gives "not installed" its own reason, carrying what detection said', async () => {
    const { run, result } = launch({
      cli: detector({ cli: 'claude', installed: false, reason: 'claude not found on PATH' })
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: 'Claude Code is not installed on this machine. claude not found on PATH'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('still refuses when detection claims installed but names no path', async () => {
    const { run, result } = launch({ cli: detector({ cli: 'claude', installed: true }) })

    await expect(result).resolves.toMatchObject({ launched: false, provider: 'claude' })
    expect(run).not.toHaveBeenCalled()
  })

  // AMENDED for #502 (was: 'maps a spawn failure to a stated reason rather
  // than a silent no-op', asserting the fixed sentence
  // 'Claude Code could not be started.' with no path or cause). Explicit
  // platform: a spawn failure is not a Windows-only shape.
  it('names the path tried and the spawn error on Linux, rather than a fixed sentence', async () => {
    const { result } = launch({
      platform: 'linux',
      run: vi.fn().mockRejectedValue(new Error('ENOENT'))
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: `Claude Code could not be started: ${CLAUDE_PATH} — ENOENT.`
    })
  })

  // NEW for #502: the same refusal shape on macOS, with the OS's own errno
  // code as the cause — a real spawn error carries `code`, unlike the plain
  // `Error('ENOENT')` the Linux test above uses to pin the message text.
  it('names the path tried and the spawn error on macOS', async () => {
    const spawnError = Object.assign(new Error('spawn /home/j/.local/bin/claude EACCES'), {
      code: 'EACCES'
    })
    const { result } = launch({
      platform: 'darwin',
      run: vi.fn().mockRejectedValue(spawnError)
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: `Claude Code could not be started: ${CLAUDE_PATH} — EACCES.`
    })
  })

  it('claims only that the process started, never that a dwarf exists', async () => {
    // The exact shape is the assertion: a launch result carries no dwarf id and
    // no mine, because the poll — not this call — is what discovers the session.
    await expect(launch({}).result).resolves.toEqual({ launched: true, provider: 'claude' })
  })

  /*
   * #168. This function used to take no provider and detect the literal
   * 'claude', so every chip in the Add Panel reached the same binary. It now
   * asks for the provider it was given, and refuses one it has no invocation
   * for BY NAME rather than falling back — a fallback here would start Claude
   * for a user who pressed something else, in a real folder.
   */
  it('detects the provider it was asked for rather than a hardcoded one', async () => {
    const cli = installed()
    await launch({ cli }).result

    expect(cli.detect).toHaveBeenCalledWith('claude')
  })

  it('detects Codex, not Claude, when Codex is the provider asked for', async () => {
    const cli = installedCodex()
    await launch({ provider: 'codex', cli }).result

    expect(cli.detect).toHaveBeenCalledWith('codex')
  })
})

/*
 * Codex's launch, and what it can honestly be (#168).
 *
 * NOT a held session. docs/command-surface-evaluation.md states that "Codex has
 * no held-session engine in this app (no equivalent of `sdkHeldSession.ts`
 * exists for it)", and docs/question-capture-evaluation.md's matrix marks the
 * `codex exec` row's live capture and answering both No. So this is the
 * detached shape and only that: a process started in the mine's folder, let go
 * of, and discovered afterwards by the ordinary poll reading Codex's own
 * rollout storage — where `threads.cwd` is what puts it in the right mine, the
 * same trick the Claude launch relies on.
 */
describe('launching Codex', () => {
  it('starts the detected codex binary in the mine folder, with the prompt on stdin', async () => {
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), prompt: 'dig' })

    await expect(result).resolves.toEqual({ launched: true, provider: 'codex' })
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(CODEX_PATH)
    // cwd is the whole trick here too: the Codex provider reads a thread's own
    // `cwd` column, so this is what files the new session under the right mine.
    expect(invocation.cwd).toBe(MINE_PATH)
    // AMENDED for #510 (was: `['exec', '-']`) — Codex's own `-o` flag now
    // rides along so the runner can read the clean final message back; see
    // 'wires the -o output path into both argv and the invocation' below.
    expect(invocation.args).toEqual(['exec', '-o', CODEX_OUTPUT_PATH, '-'])
    expect(invocation.stdin).toBe('dig')
  })

  it('wires the -o output path into both argv and the invocation, for Codex only (#510)', async () => {
    const { run: codexRun, result: codexResult } = launch({
      provider: 'codex',
      cli: installedCodex()
    })
    await codexResult
    const codexInvocation = (codexRun as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as LaunchInvocation
    expect(codexInvocation.outputFile).toBe(CODEX_OUTPUT_PATH)

    const { run: claudeRun, result: claudeResult } = launch({ provider: 'claude' })
    await claudeResult
    const claudeInvocation = (claudeRun as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as LaunchInvocation
    // Every other provider ignores it — no -o flag exists for them.
    expect(claudeInvocation.outputFile).toBeUndefined()
    expect(claudeInvocation.args).not.toContain('-o')
  })

  it('never puts the prompt in argv for Codex either', async () => {
    const secret = 'rotate the deploy key'
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), prompt: secret })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args.join(' ')).not.toContain(secret)
  })

  it('says Codex is missing in Codex’s own words, carrying what detection said', async () => {
    // "Claude Code is not installed" for a Codex chip would be this app naming
    // the wrong program at the one moment the user can act on the answer.
    const { run, result } = launch({
      provider: 'codex',
      cli: detector({ cli: 'codex', installed: false, reason: 'codex not found on PATH' })
    })

    const verdict = await result
    expect(verdict.provider).toBe('codex')
    expect(verdict.error).toContain('Codex')
    expect(verdict.error).not.toContain('Claude')
    expect(verdict.error).toContain('codex not found on PATH')
    expect(run).not.toHaveBeenCalled()
  })

  /*
   * The npm-global install, which is the common one for Codex on Windows, and
   * pnpm's `codex.CMD` beside it. Until #193 this was REFUSED, with a message
   * naming CODEX_CLI_PATH: a batch shim needs cmd.exe, and the launcher had
   * borrowed the queue's reason for never handing a payload to a shell. That
   * reason was the queue's alone — there the message is an argv element — and
   * the named exit was one a packaged user could not take (no Settings UI for
   * CLI paths). The shell was still not the answer: a detached cmd.exe has no
   * console and starts no external program at all, while a non-detached one
   * dies with the panel. So the launcher does what the shim would have done —
   * reads it, and runs the node entry it names directly, detached. The two
   * refusal tests that stood here ("refuses a shell shim rather than failing
   * opaquely, and says what to set", "never publishes the shim path it
   * refused") went with the refusal.
   */
  it('starts an npm .cmd shim by running the node entry it names, instead of refusing it (#193)', async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      env: { Path: 'C:\\Windows\\System32' },
      prompt: 'dig',
      cli: shimDetector(NPM_SHIM),
      fs
    })

    await expect(result).resolves.toEqual({ launched: true, provider: 'codex' })
    expect(run).toHaveBeenCalledTimes(1)
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    // No node.exe beside this shim, so `node` from PATH — the shim's own ELSE arm.
    expect(invocation.command).toBe('node')
    // AMENDED for #510 (was: `[NPM_ENTRY, 'exec', '-']`) — see the dedicated
    // -o wiring test above.
    expect(invocation.args).toEqual([NPM_ENTRY, 'exec', '-o', CODEX_OUTPUT_PATH, '-'])
    expect(invocation.stdin).toBe('dig')
    expect(invocation.cwd).toBe(MINE_PATH)
    // PATH is still led by the shim's directory: a re-exec of `codex` inside
    // the child must find the same install detection did.
    expect(invocation.env.Path).toBe(`${NPM_DIR};C:\\Windows\\System32`)
  })

  it('prefers the node.exe the shim itself would prefer, when one sits beside it', async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    fs.addFile(`${NPM_DIR}\\node.exe`, 'MZ')
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      cli: shimDetector(NPM_SHIM),
      fs
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(`${NPM_DIR}\\node.exe`)
    expect(invocation.args[0]).toBe(NPM_ENTRY)
  })

  it('never hands a shim to a shell, in either direction', async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      cli: shimDetector(NPM_SHIM),
      fs
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation).not.toHaveProperty('shell')
    expect(invocation.command.toLowerCase().endsWith('.cmd')).toBe(false)
  })

  it('keeps the prompt off argv for a shim launch too', async () => {
    const secret = 'rotate the deploy key'
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      prompt: secret,
      cli: shimDetector(NPM_SHIM),
      fs
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).not.toContain(secret)
    expect(invocation.args.join(' ')).not.toContain(secret)
    expect(invocation.stdin).toBe(secret)
  })

  // AMENDED for #502 (was: 'says Codex could not be started when the shim
  // names nothing it can run', asserting the fixed sentence
  // 'Codex CLI could not be started.' and a comment claiming "never a path on
  // the wire" — that claim is exactly what #502 asked to stop being true).
  it('names the shim path and that its dialect was not understood', async () => {
    // A third shim dialect, or a hand-written wrapper: an honest failure that
    // names the path it tried and why, never a guess at an entry.
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, '@echo off\r\nrem nothing to run here\r\n')
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      cli: shimDetector(NPM_SHIM),
      fs
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'codex',
      error: `Codex CLI could not be started: ${NPM_SHIM} — the shim was found but its dialect was not understood.`
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('starts a real codex executable as itself, reading no shim', async () => {
    const fs = new FakeFs()
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), fs })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(CODEX_PATH)
    // AMENDED for #510 (was: `['exec', '-']`) — see the dedicated -o wiring
    // test above.
    expect(invocation.args).toEqual(['exec', '-o', CODEX_OUTPUT_PATH, '-'])
  })

  it('claims only that the process started, and never a dwarf', async () => {
    // Codex's dwarf is discovered by the poll off its rollout storage, up to a
    // poll interval later, exactly as a session a human started is.
    await expect(launch({ provider: 'codex', cli: installedCodex() }).result).resolves.toEqual({
      launched: true,
      provider: 'codex'
    })
  })
})

/*
 * OpenCode's launch (#534), on the same DETACHED, one-shot terms as
 * Antigravity's and Codex's above: no held-session engine, discovered
 * afterwards by the ordinary poll reading `opencode.db` — where
 * `session.directory` is what puts it in the right mine, the same trick
 * every other provider's launch relies on.
 */
describe('launching OpenCode (#534)', () => {
  it('never puts the prompt in argv for OpenCode either', async () => {
    const secret = 'rotate the deploy key'
    const { run, result } = launch({
      provider: 'opencode',
      cli: installedOpenCode(),
      prompt: secret
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args.join(' ')).not.toContain(secret)
    expect(invocation.stdin).toBe(secret)
  })

  it('says OpenCode is missing in its own words, carrying what detection said', async () => {
    const { run, result } = launch({
      provider: 'opencode',
      cli: detector({ cli: 'opencode', installed: false, reason: 'opencode not found on PATH' })
    })

    const verdict = await result
    expect(verdict.provider).toBe('opencode')
    expect(verdict.error).toContain('OpenCode')
    expect(verdict.error).not.toContain('Claude')
    expect(verdict.error).toContain('opencode not found on PATH')
    expect(run).not.toHaveBeenCalled()
  })

  /*
   * The npm-global install, the common one for OpenCode (`npx opencode-ai` /
   * `npm i -g opencode-ai`), on the same terms #193 already proved for
   * Codex's own npm shim: `resolveProgram` reads it and runs the node entry
   * it names directly, detached — never through cmd.exe, which is exactly
   * the shell hop the measurement report's own trap reproduced (M3
   * addendum: a session recorded under the PARENT directory, 2/2).
   */
  it('starts an npm .cmd shim by running the node entry it names, instead of a shell hop', async () => {
    const fs = new FakeFs()
    fs.addFile(OPENCODE_SHIM, OPENCODE_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'opencode',
      platform: 'win32',
      prompt: 'dig',
      cli: shimDetectorFor('opencode', OPENCODE_SHIM),
      fs
    })

    await expect(result).resolves.toEqual({ launched: true, provider: 'opencode' })
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe('node')
    expect(invocation.args).toEqual([OPENCODE_SHIM_ENTRY, 'run', '--format', 'json'])
    expect(invocation.stdin).toBe('dig')
    expect(invocation.cwd).toBe(MINE_PATH)
    expect(invocation.viaNodeEntry).toBe(true)
  })

  it('never hands an OpenCode shim to a shell, in either direction', async () => {
    const fs = new FakeFs()
    fs.addFile(OPENCODE_SHIM, OPENCODE_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'opencode',
      platform: 'win32',
      cli: shimDetectorFor('opencode', OPENCODE_SHIM),
      fs
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation).not.toHaveProperty('shell')
    expect(invocation.command.toLowerCase().endsWith('.cmd')).toBe(false)
  })

  it('asks the detected OpenCode binary directly on POSIX, no shim to read', async () => {
    const fs = new FakeFs()
    const { run, result } = launch({ provider: 'opencode', cli: installedOpenCode(), fs })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(OPENCODE_PATH)
    expect(invocation.args).toEqual(['run', '--format', 'json'])
    expect(invocation.viaNodeEntry).toBe(false)
  })

  it('detects OpenCode, not another provider, when OpenCode is the provider asked for', async () => {
    const cli = installedOpenCode()
    await launch({ provider: 'opencode', cli }).result

    expect(cli.detect).toHaveBeenCalledWith('opencode')
  })

  it('claims only that the process started, and never a dwarf', async () => {
    // OpenCode's dwarf is discovered by the poll off opencode.db, up to a
    // poll interval later, exactly as a session a human started is.
    await expect(
      launch({ provider: 'opencode', cli: installedOpenCode() }).result
    ).resolves.toEqual({
      launched: true,
      provider: 'opencode'
    })
  })

  /*
   * #510 correction. `oneShotTurnOutcome` needs to know, per launch, whether
   * ITS provider's stdout is turn text at all — see `ONE_SHOT_STDOUT_IS_TURN_TEXT`
   * (launch.ts). This is the one place that table is actually consulted: a
   * table nobody reads is not a fix, only documentation of one.
   */
  it("carries OpenCode's own stdoutIsTurnText verdict (false) onto the invocation", async () => {
    const { run, result } = launch({ provider: 'opencode', cli: installedOpenCode() })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.stdoutIsTurnText).toBe(false)
  })

  it("carries Codex's own stdoutIsTurnText verdict (true) onto the invocation", async () => {
    const { run, result } = launch({ provider: 'codex', cli: installedCodex() })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.stdoutIsTurnText).toBe(true)
  })
})

/*
 * MCP subtask delegation, detached injection (#511 T4). The gate check and
 * the token's own lifecycle live in `runtime.ts` — this only has to prove
 * that a `delegation` context, once handed to `launchClaudeSession`, reaches
 * the right provider's own per-invocation mechanism, and that an ORDINARY
 * launch (no `delegation` at all) stays byte for byte what it always was.
 */
describe('detached delegation injection (#511 T4)', () => {
  function context(
    overrides: Partial<DelegationInjectionContext> = {}
  ): DelegationInjectionContext {
    return {
      serverCommand: '/opt/DwarfAI-Miners/DwarfAI-Miners',
      serverArgs: ['/opt/DwarfAI-Miners/resources/app.asar.unpacked/out/main/jevMcpServer.js'],
      endpoint: 'http://127.0.0.1:54321',
      token: 'tok-abc123',
      ...overrides
    }
  }

  it('writes the mcp-config file and appends --mcp-config/--allowedTools for a detached Claude launch', async () => {
    const configFile = fakeDelegationConfigFile()
    const { run, result } = launch({
      provider: 'claude',
      delegation: context(),
      delegationConfigFile: configFile
    })
    await result

    const invocation = argvOf(run)
    const configIndex = invocation.indexOf('--mcp-config')
    expect(configIndex).toBeGreaterThanOrEqual(0)
    const configPath = invocation[configIndex + 1]!
    expect(invocation.slice(configIndex + 2)).toEqual([
      '--allowedTools',
      'mcp__jev__delegate_subtask',
      'mcp__jev__subtask_result'
    ])
    expect(JSON.parse(configFile.writtenAt(configPath)!)).toEqual({
      mcpServers: {
        jev: {
          type: 'stdio',
          command: context().serverCommand,
          args: context().serverArgs,
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_DELEGATION_ENDPOINT: context().endpoint,
            DWARFAI_DELEGATION_TOKEN: context().token
          }
        }
      }
    })
  })

  it('never passes --strict-mcp-config, so the user’s own MCP servers are never dropped', async () => {
    const { run, result } = launch({
      provider: 'claude',
      delegation: context(),
      delegationConfigFile: fakeDelegationConfigFile()
    })
    await result

    expect(argvOf(run)).not.toContain('--strict-mcp-config')
  })

  it('leaves a Claude launch with no delegation byte for byte what it always was', async () => {
    const { run, result } = launch({ provider: 'claude' })
    await result

    expect(argvOf(run)).toEqual(['-p', '--input-format', 'text'])
  })

  it('carries LaunchInvocation.delegationConfigFile so the runner can remove it on exit', async () => {
    const configFile = fakeDelegationConfigFile()
    const { run, result } = launch({
      provider: 'claude',
      delegation: context(),
      delegationConfigFile: configFile
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.delegationConfigFile).toBeDefined()
    expect(configFile.writtenAt(invocation.delegationConfigFile!)).not.toBeUndefined()
  })

  it('merges the delegation server into OPENCODE_CONFIG_CONTENT and touches no argv', async () => {
    const { run, result } = launch({
      provider: 'opencode',
      cli: installedOpenCode(),
      delegation: context(),
      env: { PATH: '/usr/bin' }
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.args).toEqual(['run', '--format', 'json'])
    const configContent: unknown = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT!)
    expect(configContent).toEqual({
      mcp: {
        jev: {
          type: 'local',
          command: [context().serverCommand, ...context().serverArgs],
          environment: {
            ELECTRON_RUN_AS_NODE: '1',
            DWARFAI_DELEGATION_ENDPOINT: context().endpoint,
            DWARFAI_DELEGATION_TOKEN: context().token
          },
          enabled: true
        }
      }
    })
  })

  it("merges into the launch's own existing OPENCODE_CONFIG_CONTENT rather than clobbering it", async () => {
    const existing = JSON.stringify({
      mcp: { other: { type: 'local', command: ['x'], enabled: true } }
    })
    const { run, result } = launch({
      provider: 'opencode',
      cli: installedOpenCode(),
      delegation: context(),
      env: { PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: existing }
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    const configContent: unknown = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT!)
    expect(configContent).toMatchObject({
      mcp: { other: { type: 'local', command: ['x'], enabled: true }, jev: { enabled: true } }
    })
  })

  it('leaves an OpenCode launch with no delegation byte for byte what it always was', async () => {
    const { run, result } = launch({
      provider: 'opencode',
      cli: installedOpenCode(),
      env: { PATH: '/usr/bin' }
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect('OPENCODE_CONFIG_CONTENT' in invocation.env).toBe(false)
  })

  /*
   * #511 L4. Before this fix, an OpenCode launch whose OWN
   * OPENCODE_CONFIG_CONTENT this app could not parse as a JSON object had it
   * REPLACED outright with just `{mcp:{jev:...}}` — discarding whatever was
   * there for a reason this app cannot see. Skipping injection (the launch
   * proceeds exactly as an ungated one would, and the existing env value
   * passes through untouched) is the safe default.
   */
  it("skips delegation injection when the launch's own existing OPENCODE_CONFIG_CONTENT cannot be parsed as a JSON object, rather than replacing it (#511 L4)", async () => {
    const malformed = '{not json'
    const { run, result } = launch({
      provider: 'opencode',
      cli: installedOpenCode(),
      delegation: context(),
      env: { PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: malformed }
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.env.OPENCODE_CONFIG_CONTENT).toBe(malformed)
    expect(invocation.args).toEqual(['run', '--format', 'json'])
  })

  /*
   * AMENDED for #511 (Codex smoke measurement, 2026-09-23): was "never
   * touches Codex argv or env, even when a delegation context is somehow
   * present", asserting argv stayed exactly `['exec', '-o', CODEX_OUTPUT_PATH,
   * '-']` — true only while Codex sat outside `DELEGATION_CAPABLE_PROVIDERS`.
   * A real `codex exec` launch has since been measured registering the
   * `-c`-configured `jev` server AND exposing its tools to the model, so
   * Codex joined the capable list (`delegationGate.ts`) and this function now
   * has to wire its own per-invocation mechanism, the same way it already
   * does for `claude` and `opencode`. Codex carries no env change (its own
   * delegation env rides inside the `-c mcp_servers.jev.env=…` TOML value,
   * applied by Codex to the SPAWNED SERVER only, never to Codex's own
   * process) and writes no config file — only extra argv, inserted before
   * the trailing "-" by `buildCodexLaunchArgs` (see launch.test.ts's own
   * #511 T4 coverage for that placement rule).
   */
  it('inserts codexDelegationConfigArgs before the trailing "-" for a delegating Codex launch', async () => {
    const { run, result } = launch({
      provider: 'codex',
      cli: installedCodex(),
      delegation: context()
    })
    await result

    expect(argvOf(run)).toEqual([
      'exec',
      '-o',
      CODEX_OUTPUT_PATH,
      ...codexDelegationConfigArgs(context()),
      '-'
    ])
    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect('OPENCODE_CONFIG_CONTENT' in invocation.env).toBe(false)
    expect(invocation.delegationConfigFile).toBeUndefined()
  })

  it('leaves a Codex launch with no delegation byte for byte what it always was', async () => {
    const { run, result } = launch({ provider: 'codex', cli: installedCodex() })
    await result

    expect(argvOf(run)).toEqual(['exec', '-o', CODEX_OUTPUT_PATH, '-'])
  })
})

/*
 * The thin runner, through an injected spawn: what actually reaches
 * child_process (#193). Nothing runs here — the fake records the call and
 * reports the child as started, so the suite stays platform-independent.
 */
/*
 * What the panel keeps of a launch (#217). The verdict crossing the wire is
 * unchanged — a process started, and nothing more is claimed — so the retained
 * handle leaves through its own seam rather than through the result.
 */
describe('launchClaudeSession retention', () => {
  it('reports the process it started, so the caller can decide to keep it', async () => {
    const started: LaunchedProcess = { pid: 4242, onExit: () => {} }
    const { result } = launch({ run: vi.fn().mockResolvedValue(started) })

    await expect(result).resolves.toEqual({
      launched: true,
      provider: 'claude',
      retained: started
    })
  })

  it('reports no process when the launch never started one', async () => {
    const { result } = launch({
      cli: detector({ cli: 'codex', installed: false, source: 'convention' }),
      provider: 'codex'
    })

    const verdict = await result
    expect(verdict.launched).toBe(false)
    expect(verdict.retained).toBeUndefined()
  })

  it('reports no process when the runner had none to hand back', async () => {
    const { result } = launch({ run: vi.fn().mockResolvedValue(undefined) })

    await expect(result).resolves.toEqual({ launched: true, provider: 'claude' })
  })
})

/*
 * Since #217 the fake also carries a pid and an 'exit' subscription, because
 * that is what the runner now hands back for the panel to hold onto.
 *
 * AMENDED for #263 (was: `exit` took no arguments, and this lived only
 * inside `describe('runLaunchProcess')`). `exit(code, signal)` now matches
 * what Node's real 'exit' event actually carries, so a test can tell a
 * failure from an ordinary end. It is hoisted to module scope so the
 * early-failure describe block below can share it rather than duplicating
 * it. Every existing call site that calls `exit()` with no arguments is
 * unchanged: the default below is a clean 0, which is what "the process just
 * ended" already meant to every test that predates this issue.
 *
 * AMENDED again for #263 (was: a `stderr` stream the fake exposed and a
 * `writeStderr` that fed it). The runner no longer reads a live stream at
 * all — a pipe's parent end would disappear the moment this process exits,
 * which is exactly the hazard a DETACHED, unref'd child must never have
 * (#231) — so stderr is captured to a FILE instead; see `fakeStderrFile`
 * below for its own fake and `createNodeStderrFile` in `launchRunner.ts` for
 * the real one.
 */
function fakeSpawn(outcome: 'spawn' | 'error' = 'spawn', pid: number | null = 4242) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const written: string[] = []
  let unrefCalls = 0
  const exited: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const spawnProcess: SpawnLaunch = (command, args, options) => {
    calls.push({ command, args, options })
    const spawned: Array<() => void> = []
    const failed: Array<(error: Error) => void> = []
    const child: LaunchChild = {
      ...(pid === null ? {} : { pid }),
      once(event, listener) {
        if (event === 'spawn') spawned.push(listener as () => void)
        else if (event === 'exit')
          exited.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
        else failed.push(listener as (error: Error) => void)
        return child
      },
      stdin: {
        on() {
          return undefined
        },
        end(chunk: string) {
          written.push(chunk)
        }
      },
      unref() {
        unrefCalls += 1
      }
    }
    queueMicrotask(() => {
      if (outcome === 'spawn') for (const listener of spawned) listener()
      else for (const listener of failed) listener(new Error('EINVAL'))
    })
    return child
  }
  return {
    spawnProcess,
    calls,
    written,
    unrefCalls: () => unrefCalls,
    exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      for (const listener of exited) listener(code, signal)
    }
  }
}

/**
 * An in-memory `StderrFile` (#263), so the great majority of this suite
 * never touches real disk — the one test that has to, proving
 * `createNodeStderrFile` itself does what it claims, says so explicitly and
 * lives in its own describe block below.
 *
 * `openForWrite` hands back a small, deterministic fd (`FAKE_STDERR_FD` for
 * the first file any one fake opens) so a test can still assert the exact
 * spawn `options` object rather than merely that stdio[2] is "a number" —
 * see `createNodeStderrFile`'s own module comment for what a real fd would
 * be here instead. `writeStderr` stands in for the child's own writes to
 * that fd, addressed to whichever path this fake most recently opened,
 * since a test drives the fake spawn and never sees the generated path
 * itself.
 */
const FAKE_STDERR_FD = 900

function fakeStderrFile(): StderrFile & {
  writeStderr: (chunk: string) => void
  removedPaths: () => string[]
} {
  const contents = new Map<string, string>()
  const removed: string[] = []
  let currentPath: string | null = null
  let nextFd = FAKE_STDERR_FD
  return {
    path: () => `fake-launch-stderr-${nextFd}.log`,
    openForWrite: (path) => {
      currentPath = path
      contents.set(path, '')
      return nextFd++
    },
    close: () => {},
    readTail: (path, maxBytes) => {
      const text = contents.get(path) ?? ''
      return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
    },
    remove: (path) => {
      contents.delete(path)
      removed.push(path)
    },
    writeStderr: (chunk) => {
      if (currentPath === null) return
      contents.set(currentPath, (contents.get(currentPath) ?? '') + chunk)
    },
    removedPaths: () => removed
  }
}

/**
 * `StdoutFile`'s own twin (#510), same shape and same reason: the great
 * majority of this suite stays off real disk, and `writeStdout` stands in
 * for the child's own writes to the fd `buildLaunchSpawn` handed it. A
 * SEPARATE fake, not a shared instance with `fakeStderrFile`, because a real
 * launch opens two distinct files and a test proving the runner reads the
 * RIGHT one from the right descriptor would not catch a swap if both fakes
 * shared one map of paths to contents.
 */
const FAKE_STDOUT_FD = 901

/**
 * One shared `contents` map serves two roles a real launch keeps separate
 * files for: the piped stdout capture this fake OPENS itself
 * (`openForWrite`/`writeStdout`, exactly like `fakeStderrFile`), and Codex's
 * own `-o` file, which Codex writes directly and this app only ever reads
 * and removes — `write(path, text)` stands in for Codex's own write, at
 * whatever path `invocation.outputFile` names, never through `openForWrite`.
 * One fake rather than two, because both roles read and remove by PATH, and
 * a real `runLaunchProcess` is handed exactly one `StdoutFile` port for both.
 */
function fakeStdoutFile(): StdoutFile & {
  writeStdout: (chunk: string) => void
  write: (path: string, text: string) => void
  removedPaths: () => string[]
} {
  const contents = new Map<string, string>()
  const removed: string[] = []
  let currentPath: string | null = null
  let nextFd = FAKE_STDOUT_FD
  return {
    path: () => `fake-launch-stdout-${nextFd}.log`,
    openForWrite: (path) => {
      currentPath = path
      contents.set(path, '')
      return nextFd++
    },
    close: () => {},
    readTail: (path, maxBytes) => {
      const text = contents.get(path) ?? ''
      return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
    },
    remove: (path) => {
      contents.delete(path)
      removed.push(path)
    },
    writeStdout: (chunk) => {
      if (currentPath === null) return
      contents.set(currentPath, (contents.get(currentPath) ?? '') + chunk)
    },
    write: (path, text) => {
      contents.set(path, text)
    },
    removedPaths: () => removed
  }
}

/*
 * #511 M1b. An independent verifier found this file written with no `mode`
 * at all — 0644 on Linux/macOS, world-readable in a shared `/tmp`, and it
 * carries this launch's own delegation endpoint AND token. Proven by
 * pinning the CALL this app makes (`{ mode: 0o600, flag: 'wx' }`), never the
 * OS's own enforcement of it — see `WriteFileSyncLike`'s own comment in
 * launchRunner.ts for why: Windows has no real per-class permission bits
 * for a round-tripped `fs.statSync` to disagree with a Linux/macOS
 * assertion about.
 */
describe('createNodeDelegationConfigFile (#511 M1b)', () => {
  it('writes with mode 0o600 and an exclusive create flag, so the file is neither world-readable nor silently overwritten', () => {
    const calls: Array<{ path: string; contents: string; options: unknown }> = []
    const file = createNodeDelegationConfigFile((path, contents, options) => {
      calls.push({ path, contents, options })
    })

    file.write('/tmp/mcp-config.json', '{"mcpServers":{}}')

    expect(calls).toEqual([
      {
        path: '/tmp/mcp-config.json',
        contents: '{"mcpServers":{}}',
        options: { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      }
    ])
  })

  it('still produces a fresh path per call and removes it the same way as before', () => {
    const file = createNodeDelegationConfigFile(() => {})
    const first = file.path()
    const second = file.path()

    expect(first).not.toBe(second)
    expect(() => file.remove('/tmp/does-not-exist.json')).not.toThrow()
  })
})

describe('runLaunchProcess', () => {
  function invocation(overrides: Partial<LaunchInvocation> = {}): LaunchInvocation {
    return {
      command: CODEX_PATH,
      args: ['exec', '-'],
      env: { PATH: '/usr/bin' },
      cwd: MINE_PATH,
      stdin: 'dig',
      viaNodeEntry: false,
      // AMENDED for #510 correction: `LaunchInvocation` now carries
      // `stdoutIsTurnText`. This fixture is Codex's own shape (CODEX_PATH),
      // and Codex is `true` in `ONE_SHOT_STDOUT_IS_TURN_TEXT` (launch.ts), so
      // this default keeps every test built on this fixture exactly what it
      // asserted before.
      stdoutIsTurnText: true,
      ...overrides
    }
  }

  /*
   * `detached` is load-bearing and `shell` is deliberately absent, both
   * verified against this machine (Windows 11, Node v24.11.1) while #193 was
   * being fixed: a detached cmd.exe has no console and silently starts no
   * external program (exit 0, nothing run), and a non-detached child sits in
   * libuv's kill-on-close job object and dies with the panel. Direct spawn of a
   * real program, detached, is the one shape that both runs and outlives us.
   */
  it('spawns the command as given — detached, hidden, no shell — and writes the prompt to stdin', async () => {
    const spawn = fakeSpawn()
    const files = fakeStderrFile()

    // Was `resolves.toBeUndefined()` before #217; the runner now answers with
    // the retained handle, and the spawn assertions below are unchanged.
    await expect(
      runLaunchProcess(
        invocation({ command: 'node', args: [NPM_ENTRY, 'exec', '-'] }),
        spawn.spawnProcess,
        files,
        fakeStdoutFile()
      )
    ).resolves.toMatchObject({ pid: 4242 })

    expect(spawn.calls).toHaveLength(1)
    const call = spawn.calls[0]!
    expect(call.command).toBe('node')
    expect(call.args).toEqual([NPM_ENTRY, 'exec', '-'])
    // AMENDED for #263 (was: stdio: ['pipe', 'ignore', 'ignore'], then later
    // ['pipe', 'ignore', 'pipe']). A pipe's parent end belongs to THIS
    // process and disappears the moment it exits — exactly what a detached,
    // unref'd launch must survive (#231) — so stderr is now a real file
    // descriptor, never 'pipe' and never 'ignore'. See the dedicated test
    // below and the early-failure window describe block for the rest.
    // AMENDED again for #510 (was: stdio: ['pipe', 'ignore', FAKE_STDERR_FD])
    // — stdout is now captured through a real fd too, for the same reason
    // and the same way stderr already was.
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', FAKE_STDOUT_FD, FAKE_STDERR_FD],
      windowsHide: true
    })
    expect(spawn.written).toEqual(['dig'])
    expect(spawn.unrefCalls()).toBe(1)
  })

  /*
   * The design fix this test pins: a pipe here would be an EPIPE hazard the
   * old `'ignore'` never had, because a detached launch's whole purpose is
   * to outlive the panel process (#231, #263).
   */
  it('captures stderr through a real file descriptor, never a pipe', async () => {
    const spawn = fakeSpawn()

    await runLaunchProcess(invocation(), spawn.spawnProcess, fakeStderrFile(), fakeStdoutFile())

    const stderrEntry = spawn.calls[0]!.options.stdio?.[2]
    expect(typeof stderrEntry).toBe('number')
    expect(stderrEntry).not.toBe('pipe')
    expect(stderrEntry).not.toBe('ignore')
  })

  /*
   * #510's own half of the same fix: stdout was `'ignore'` before this
   * issue, which is exactly why nothing could ever say what a one-shot
   * launch concluded. Now a real fd, on the same terms stderr already is.
   */
  it('captures stdout through a real file descriptor too, never ignored', async () => {
    const spawn = fakeSpawn()

    await runLaunchProcess(invocation(), spawn.spawnProcess, fakeStderrFile(), fakeStdoutFile())

    const stdoutEntry = spawn.calls[0]!.options.stdio?.[1]
    expect(typeof stdoutEntry).toBe('number')
    expect(stdoutEntry).not.toBe('pipe')
    expect(stdoutEntry).not.toBe('ignore')
  })

  it('rejects when the child reports it could not start, writing nothing', async () => {
    const spawn = fakeSpawn('error')
    const files = fakeStderrFile()
    const outFiles = fakeStdoutFile()

    await expect(
      runLaunchProcess(invocation(), spawn.spawnProcess, files, outFiles)
    ).rejects.toThrow('EINVAL')
    expect(spawn.written).toEqual([])
    // Nothing will ever be spawned to write into either of them now.
    expect(files.removedPaths()).toHaveLength(1)
    expect(outFiles.removedPaths()).toHaveLength(1)
  })

  /*
   * #208. The black console window. `detached` turns into DETACHED_PROCESS,
   * which Win32 documents as making CREATE_NO_WINDOW — libuv's spelling of
   * `windowsHide` — ignored, so the child starts with NO console. A JS entry is
   * then an interpreter that spawns the real CLI itself, and a console-subsystem
   * program whose parent has no console is handed a fresh VISIBLE one. Measured
   * live on Windows 11 / Node v24.11.1: a detached, windowsHide'd node spawning
   * a console program produced consoleVisible=true, owned by the child itself.
   */
  it('runs a node entry through a hidden-console intermediary rather than spawning it console-less (#208)', async () => {
    const spawn = fakeSpawn()

    await runLaunchProcess(
      invocation({ command: 'node', args: [NPM_ENTRY, 'exec', '-'], viaNodeEntry: true }),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )

    const call = spawn.calls[0]!
    // The same node, twice: once to run the intermediary, once as the program
    // the intermediary starts. Nothing else is introduced into the chain.
    expect(call.command).toBe('node')
    expect(call.args).toEqual(['-e', CONSOLE_HOSTING_PROGRAM, 'node', NPM_ENTRY, 'exec', '-'])
    // The outer spawn is unchanged: detached is still what makes the session
    // outlive the panel, and no shell is involved in either hop.
    // AMENDED for #263, for the same reason the test above was.
    // AMENDED again for #510 (was: stdio: ['pipe', 'ignore', FAKE_STDERR_FD]).
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', FAKE_STDOUT_FD, FAKE_STDERR_FD],
      windowsHide: true
    })
    expect(spawn.written).toEqual(['dig'])
  })

  it('spawns a program that is its own console program as itself, with no intermediary', async () => {
    const spawn = fakeSpawn()

    await runLaunchProcess(
      invocation({ command: CODEX_PATH, args: ['exec', '-'], viaNodeEntry: false }),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )

    const call = spawn.calls[0]!
    expect(call.command).toBe(CODEX_PATH)
    expect(call.args).toEqual(['exec', '-'])
    expect(call.args).not.toContain('-e')
  })

  /*
   * #217. The launch is still detached and still let go of, but the panel now
   * keeps the one thing it needs to be able to end it: the pid of the process
   * it spawned. For a shim launch that is the console-hosting intermediary,
   * whose child is the real CLI — so ending the session means ending that
   * tree, and the pid retained is the one this spawn returned rather than a
   * guess about the program underneath it.
   */
  it('hands back the pid of the process it started, so the panel can end it', async () => {
    const spawn = fakeSpawn()

    const retained = await runLaunchProcess(
      invocation({ command: 'node', args: [NPM_ENTRY, 'exec', '-'], viaNodeEntry: true }),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )

    expect(retained?.pid).toBe(4242)
    // Still detached and still unref'd: the session outlives the panel, and
    // quitting the app does not end it. Only an explicit kick does.
    expect(spawn.calls[0]!.options.detached).toBe(true)
    expect(spawn.unrefCalls()).toBe(1)
  })

  /*
   * The pid-reuse guard's own half of the bargain: the handle reports that
   * process going, so nothing ever signals a number that has since been handed
   * to something else on this machine.
   */
  it('reports the process ending, through the handle it handed back', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )

    let gone = false
    retained?.onExit(() => {
      gone = true
    })
    expect(gone).toBe(false)
    spawn.exit()
    expect(gone).toBe(true)
  })

  /*
   * #263. On EVERY exit — whatever the reason — nothing will ever be
   * written into this launch's stderr file again, so it is removed rather
   * than left for a longer-lived launch's file to keep it company forever.
   */
  it('removes the stderr file once the child has exited, whatever the reason', async () => {
    const spawn = fakeSpawn()
    const files = fakeStderrFile()
    await runLaunchProcess(invocation(), spawn.spawnProcess, files, fakeStdoutFile())

    expect(files.removedPaths()).toHaveLength(0)
    spawn.exit(0)
    expect(files.removedPaths()).toHaveLength(1)
  })

  // #510's own twin of the test above: the stdout capture file is now a
  // second temp file with the same lifetime, and the same reason to remove
  // it unconditionally on exit.
  it('removes the stdout file once the child has exited, whatever the reason', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    await runLaunchProcess(invocation(), spawn.spawnProcess, fakeStderrFile(), outFiles)

    expect(outFiles.removedPaths()).toHaveLength(0)
    spawn.exit(0)
    expect(outFiles.removedPaths()).toHaveLength(1)
  })

  it('retains nothing when the child reports no pid at all', async () => {
    const spawn = fakeSpawn('spawn', null)
    const files = fakeStderrFile()
    const outFiles = fakeStdoutFile()

    await expect(
      runLaunchProcess(invocation(), spawn.spawnProcess, files, outFiles)
    ).resolves.toBeUndefined()
    // Nothing to hold means nothing to watch either — there is no exit this
    // process will ever see to clean it up on, so both files are removed
    // right away.
    expect(files.removedPaths()).toHaveLength(1)
    expect(outFiles.removedPaths()).toHaveLength(1)
  })

  /*
   * #511 L1. Before this fix the delegation config file — this launch's own
   * secret — was left on disk in exactly this branch, on the reasoning that
   * a launch with no pid to retain is vanishingly rare. An independent
   * verifier asked for it to be cleaned up anyway: rare is still a stray
   * secret. It goes through the SAME `StdoutFile` port `outputFile`'s own
   * cleanup already uses.
   */
  it('also removes the delegation config file when the child reports no pid at all (#511 L1)', async () => {
    const spawn = fakeSpawn('spawn', null)
    const files = fakeStderrFile()
    const outFiles = fakeStdoutFile()

    await runLaunchProcess(
      invocation({ delegationConfigFile: 'mcp-config.json' }),
      spawn.spawnProcess,
      files,
      outFiles
    )

    expect(outFiles.removedPaths()).toContain('mcp-config.json')
  })

  /*
   * #511 L1's other half: a spawn that throws SYNCHRONOUSLY (before the
   * child ever exists to raise its own 'error' event) reached `reject`
   * directly, cleaning up the stdout/stderr files but never the delegation
   * config file — nothing else in this process was ever going to.
   */
  it('removes the delegation config file when spawn itself throws synchronously (#511 L1)', async () => {
    const throwingSpawn: SpawnLaunch = () => {
      throw new Error('EMFILE')
    }
    const outFiles = fakeStdoutFile()

    await expect(
      runLaunchProcess(
        invocation({ delegationConfigFile: 'mcp-config.json' }),
        throwingSpawn,
        fakeStderrFile(),
        outFiles
      )
    ).rejects.toThrow('EMFILE')

    expect(outFiles.removedPaths()).toContain('mcp-config.json')
  })

  /*
   * #511 L1's third path: the child raises its own async 'error' event
   * before ever reaching `retainedProcess` (a real spawn that starts but
   * cannot actually run the program). Same fix, same reasoning.
   */
  it('removes the delegation config file when the child reports it could not start (#511 L1)', async () => {
    const spawn = fakeSpawn('error')
    const outFiles = fakeStdoutFile()

    await expect(
      runLaunchProcess(
        invocation({ delegationConfigFile: 'mcp-config.json' }),
        spawn.spawnProcess,
        fakeStderrFile(),
        outFiles
      )
    ).rejects.toThrow('EINVAL')

    expect(outFiles.removedPaths()).toContain('mcp-config.json')
  })

  it('keeps the prompt off argv with the intermediary in the chain too', async () => {
    const secret = 'rotate the deploy key'
    const spawn = fakeSpawn()

    await runLaunchProcess(
      invocation({
        command: 'node',
        args: [NPM_ENTRY, 'exec', '-'],
        stdin: secret,
        viaNodeEntry: true
      }),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )

    const call = spawn.calls[0]!
    expect(call.args[0]).toBe('-e')
    expect(call.args.join(' ')).not.toContain(secret)
    expect(call.command).not.toContain(secret)
    expect(spawn.written).toEqual([secret])
  })
})

/*
 * Issue #263. After `spawn` resolves this promise, the runner used to have no
 * way to say the child then died at once — stderr was discarded and the exit
 * code was never read. A `codex exec` that starts and exits immediately (a
 * concurrent instance already holding its lock, a flag it does not
 * recognise) was reported `launched: true` and nothing ever corrected it.
 *
 * `onEarlyFailure` is the fix: told at most once, only for a child that exits
 * inside `EARLY_FAILURE_WINDOW_MS` of spawning with something other than a
 * clean 0. A later exit is an ordinary end of session and must never reach
 * it — a real agent's own turn finishing has nothing to do with the launch.
 */
describe('the early-failure window (#263)', () => {
  function invocation(overrides: Partial<LaunchInvocation> = {}): LaunchInvocation {
    return {
      command: CODEX_PATH,
      args: ['exec', '-'],
      env: { PATH: '/usr/bin' },
      cwd: MINE_PATH,
      stdin: 'dig',
      viaNodeEntry: false,
      // AMENDED for #510 correction: `LaunchInvocation` now carries
      // `stdoutIsTurnText`. This fixture is Codex's own shape (CODEX_PATH),
      // and Codex is `true` in `ONE_SHOT_STDOUT_IS_TURN_TEXT` (launch.ts), so
      // this default keeps every test built on this fixture exactly what it
      // asserted before.
      stdoutIsTurnText: true,
      ...overrides
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the exit code and reads the stderr the child wrote to its file, for an exit inside the window', async () => {
    const spawn = fakeSpawn()
    const files = fakeStderrFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      files,
      fakeStdoutFile()
    )
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    // Standing in for the child's own writes to the fd `buildLaunchSpawn`
    // handed it — nothing here reads a live stream any more (#263).
    files.writeStderr('codex: another instance is already running\n')
    spawn.exit(1)

    expect(onEarlyFailure).toHaveBeenCalledWith({
      exitCode: 1,
      signal: null,
      stderrTail: 'codex: another instance is already running\n'
    })
  })

  it('never reports a clean exit inside the window as a failure', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )
    const onEarlyFailure = vi.fn()
    retained?.onEarlyFailure?.(onEarlyFailure)

    spawn.exit(0)

    expect(onEarlyFailure).not.toHaveBeenCalled()
  })

  /*
   * The whole point of the window: a real session ending, minutes or hours
   * later, must read as the ordinary end it is rather than a launch failure.
   */
  it('never reports an exit once the window has passed — that is an ordinary end of session', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )
    const onEarlyFailure = vi.fn()
    retained?.onEarlyFailure?.(onEarlyFailure)

    vi.advanceTimersByTime(EARLY_FAILURE_WINDOW_MS + 1)
    spawn.exit(1)

    expect(onEarlyFailure).not.toHaveBeenCalled()
  })

  it('reports a signal-only exit too, with no code', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile()
    )
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    spawn.exit(null, 'SIGTERM')

    expect(onEarlyFailure).toHaveBeenCalledWith({
      exitCode: null,
      signal: 'SIGTERM',
      stderrTail: ''
    })
  })

  it('tells a listener that subscribes AFTER the failure already latched', async () => {
    const spawn = fakeSpawn()
    const files = fakeStderrFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      files,
      fakeStdoutFile()
    )

    files.writeStderr('auth expired\n')
    spawn.exit(1)
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    expect(onEarlyFailure).toHaveBeenCalledWith({
      exitCode: 1,
      signal: null,
      stderrTail: 'auth expired\n'
    })
  })

  it('keeps only the tail of a flood of stderr, bounded rather than unbounded', async () => {
    const spawn = fakeSpawn()
    const files = fakeStderrFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      files,
      fakeStdoutFile()
    )
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    // Comfortably past any reasonable KiB-scale bound; asserting the exact
    // cap here would pin an implementation detail rather than the property
    // that matters — this must never grow without limit.
    const flood = 'x'.repeat(64 * 1024)
    files.writeStderr(flood)
    spawn.exit(1)

    const failure = onEarlyFailure.mock.calls[0]![0]
    expect(failure.stderrTail.length).toBeLessThan(flood.length)
    // The END of the flood survives, not the start — the last lines of a
    // refusal are the ones that say what actually happened.
    expect(flood.endsWith(failure.stderrTail)).toBe(true)
  })

  it('never watches a child this process could not hold onto (no pid)', async () => {
    const spawn = fakeSpawn('spawn', null)
    const files = fakeStderrFile()

    await expect(
      runLaunchProcess(invocation(), spawn.spawnProcess, files, fakeStdoutFile())
    ).resolves.toBeUndefined()
    // Nothing to assert an onEarlyFailure against — there is no handle at all,
    // which is the existing 'retains nothing' rule this respects rather than
    // reopens. The file this launch never got to use is still cleaned up.
    expect(files.removedPaths()).toHaveLength(1)
  })
})

/*
 * #510. What a detached launch's own exit concluded — read off the stdout
 * and stderr temp files this launch captured, mapped through the pure
 * `oneShotTurnOutcome` (proven on its own in `oneShotTurnOutcome.test.ts`),
 * and handed to whichever caller subscribes to `onTurnOutcome`. Registered
 * before `EarlyFailureWatch` inside `retainedProcess`, so its read of the
 * stderr tail happens before that watch's own unconditional removal of the
 * same file on every exit — see `retainedProcess`'s own comment in
 * `launchRunner.ts`.
 */
describe('onTurnOutcome (#510)', () => {
  function invocation(overrides: Partial<LaunchInvocation> = {}): LaunchInvocation {
    return {
      command: CODEX_PATH,
      args: ['exec', '-'],
      env: { PATH: '/usr/bin' },
      cwd: MINE_PATH,
      stdin: 'dig',
      viaNodeEntry: false,
      // AMENDED for #510 correction: `LaunchInvocation` now carries
      // `stdoutIsTurnText`. This fixture is Codex's own shape (CODEX_PATH),
      // and Codex is `true` in `ONE_SHOT_STDOUT_IS_TURN_TEXT` (launch.ts), so
      // this default keeps every test built on this fixture exactly what it
      // asserted before.
      stdoutIsTurnText: true,
      ...overrides
    }
  }

  const NOW = 1_726_000_000_000

  it('reports a concluded turn, its text read off the stdout capture file', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    outFiles.writeStdout('the build is green\n')
    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'concluded',
      text: 'the build is green',
      endedAt: NOW
    })
  })

  it('reports a concluded turn with no text when stdout was empty', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile(),
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({ kind: 'concluded', endedAt: NOW })
  })

  it('reports an errored turn for a non-zero exit, the stderr tail as its detail', async () => {
    const spawn = fakeSpawn()
    const stderrFiles = fakeStderrFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      stderrFiles,
      fakeStdoutFile(),
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    stderrFiles.writeStderr('auth token expired')
    spawn.exit(1)

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'errored',
      detail: 'exit 1: auth token expired',
      endedAt: NOW
    })
  })

  it('reports an interrupted turn for a signal-terminated exit', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      fakeStdoutFile(),
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    spawn.exit(null, 'SIGTERM')

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'interrupted',
      detail: 'SIGTERM',
      endedAt: NOW
    })
  })

  /*
   * Codex's own `-o` file (#510) carries the clean final message alone;
   * stdout also carries whatever the run printed along the way, so the
   * output file wins whenever it actually has something in it.
   */
  it('prefers the Codex output file over the piped stdout tail when both are present', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const outputPath = 'fake-codex-output-1.log'
    const retained = await runLaunchProcess(
      invocation({ outputFile: outputPath }),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    // The piped stdout capture (opened by the runner itself) carries the
    // whole run's chatter; Codex's own -o file (never opened by this app —
    // written directly, at its own named path) carries only the clean
    // final message.
    outFiles.writeStdout('progress: step 1\nprogress: step 2\n')
    outFiles.write(outputPath, 'the clean final message\n')
    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'concluded',
      text: 'the clean final message',
      endedAt: NOW
    })
  })

  it('falls back to the piped stdout tail when an output file was named but never written', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const outputPath = 'fake-codex-output-unwritten.log'
    const retained = await runLaunchProcess(
      invocation({ outputFile: outputPath }),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    outFiles.writeStdout('the stdout tail answer\n')
    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'concluded',
      text: 'the stdout tail answer',
      endedAt: NOW
    })
  })

  /*
   * #511 T4: the `--mcp-config` temp file `launchClaudeSession` writes for a
   * delegating Claude launch is removed on exit through the SAME `StdoutFile`
   * port as the piped stdout capture and Codex's own `-o` file — it is just
   * another path this app owns and must not leave behind, never a fourth
   * kind of file with its own lifecycle.
   */
  it('removes the mcp-config file on exit, same as the stdout capture and the Codex output file', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const configPath = 'fake-mcp-config-1.json'
    await runLaunchProcess(
      invocation({ delegationConfigFile: configPath }),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )

    spawn.exit(0)

    expect(outFiles.removedPaths()).toContain(configPath)
  })

  it('removes the stdout capture file on exit, same as stderr already does', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    await runLaunchProcess(invocation(), spawn.spawnProcess, fakeStderrFile(), outFiles, () => NOW)

    expect(outFiles.removedPaths()).toHaveLength(0)
    spawn.exit(0)
    expect(outFiles.removedPaths()).toHaveLength(1)
  })

  it('tells a listener that subscribes AFTER the outcome already latched', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )

    outFiles.writeStdout('done\n')
    spawn.exit(0)
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    expect(onTurnOutcome).toHaveBeenCalledWith({ kind: 'concluded', text: 'done', endedAt: NOW })
  })

  it('keeps only the bounded tail of a flood of stdout, never the whole thing', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const retained = await runLaunchProcess(
      invocation(),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    const flood = 'y'.repeat(STDOUT_TAIL_BYTES * 2)
    outFiles.writeStdout(flood)
    spawn.exit(0)

    const outcome = onTurnOutcome.mock.calls[0]![0]
    expect(outcome.kind).toBe('concluded')
    expect(outcome.text.length).toBeLessThan(flood.length)
    expect(flood.endsWith(outcome.text)).toBe(true)
  })

  /*
   * #510 correction. `buildLaunchSpawn`'s capture is provider-agnostic on
   * purpose (every launch's stdout goes to a file the same way), but reading
   * that capture back as an ANSWER is not — an OpenCode invocation's own
   * stdout is `--format json`'s raw event stream, never proven as prose, so
   * its `LaunchInvocation.stdoutIsTurnText` is `false`
   * (`ONE_SHOT_STDOUT_IS_TURN_TEXT.opencode`, launch.ts) and this is the
   * proof that `TurnOutcomeWatch` → `oneShotTurnOutcome` actually honours it
   * end to end, not only in the pure function's own unit tests.
   */
  it('carries no text for an OpenCode invocation, whose stdout is not turn text', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const retained = await runLaunchProcess(
      invocation({ stdoutIsTurnText: false }),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    // A representative slice of OpenCode's own `--format json` event stream
    // (docs/opencode-format.md's own M1 says only that a session's `.text`
    // eventually appears inside events shaped like this) — never proven
    // prose, and this must never be read as if it were.
    outFiles.writeStdout('{"type":"message.part.updated","part":{"type":"text","text":"hi"}}\n')
    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({ kind: 'concluded', endedAt: NOW })
  })

  it('still carries text for a Codex invocation, whose stdout IS turn text, on the same terms as before', async () => {
    const spawn = fakeSpawn()
    const outFiles = fakeStdoutFile()
    const retained = await runLaunchProcess(
      invocation({ stdoutIsTurnText: true }),
      spawn.spawnProcess,
      fakeStderrFile(),
      outFiles,
      () => NOW
    )
    const onTurnOutcome = vi.fn()
    retained?.onTurnOutcome?.(onTurnOutcome)

    outFiles.writeStdout('the build is green\n')
    spawn.exit(0)

    expect(onTurnOutcome).toHaveBeenCalledWith({
      kind: 'concluded',
      text: 'the build is green',
      endedAt: NOW
    })
  })
})

/*
 * The one honest exception to "no real disk in a unit test" (see
 * `skills/tdd/SKILL.md`): `createNodeStderrFile` IS the real adapter, so
 * this proves it actually works against the machine's own temp directory
 * rather than mocking around the one thing that needed proving. Everything
 * above this block, and everywhere else `StderrFile` is used, stays on the
 * in-memory fake.
 */
describe('createNodeStderrFile (#263)', () => {
  it('opens a real file under the OS temp directory, and a caller can write the fd it hands back', () => {
    const files = createNodeStderrFile()
    const path = files.path()
    expect(path.startsWith(tmpdir())).toBe(true)

    const fd = files.openForWrite(path)
    writeSync(fd, 'codex: another instance is already running\n')
    files.close(fd)

    expect(files.readTail(path, STDERR_TAIL_BYTES)).toBe(
      'codex: another instance is already running\n'
    )

    files.remove(path)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps only the real tail of a file larger than the cap', () => {
    const files = createNodeStderrFile()
    const path = files.path()
    const fd = files.openForWrite(path)
    writeSync(fd, 'x'.repeat(STDERR_TAIL_BYTES * 2))
    files.close(fd)

    const tail = files.readTail(path, STDERR_TAIL_BYTES)

    expect(tail).toHaveLength(STDERR_TAIL_BYTES)
    files.remove(path)
  })

  it('reads as empty rather than throwing for a path that was never created', () => {
    const files = createNodeStderrFile()
    expect(files.readTail(join(tmpdir(), 'dwarfai-launch-stderr-never-existed.log'), 1024)).toBe('')
  })

  it('removing a path that is already gone is a no-op, not a throw', () => {
    const files = createNodeStderrFile()
    expect(() =>
      files.remove(join(tmpdir(), 'dwarfai-launch-stderr-never-existed.log'))
    ).not.toThrow()
  })

  it('generates a fresh path on every call, never reusing one launch’s file for another', () => {
    const files = createNodeStderrFile()
    expect(files.path()).not.toBe(files.path())
  })
})

/*
 * `createNodeStdoutFile`'s own proof (#510), the same real-adapter exception
 * `createNodeStderrFile` above states, and the same reason: this one thing
 * needs proving against the machine's own temp directory, and nothing else
 * in this suite should.
 */
describe('createNodeStdoutFile (#510)', () => {
  it('opens a real file under the OS temp directory, and a caller can write the fd it hands back', () => {
    const files = createNodeStdoutFile()
    const path = files.path()
    expect(path.startsWith(tmpdir())).toBe(true)

    const fd = files.openForWrite(path)
    writeSync(fd, 'the build is green\n')
    files.close(fd)

    expect(files.readTail(path, STDOUT_TAIL_BYTES)).toBe('the build is green\n')

    files.remove(path)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps only the real tail of a file larger than the cap', () => {
    const files = createNodeStdoutFile()
    const path = files.path()
    const fd = files.openForWrite(path)
    writeSync(fd, 'x'.repeat(STDOUT_TAIL_BYTES * 2))
    files.close(fd)

    const tail = files.readTail(path, STDOUT_TAIL_BYTES)

    expect(tail).toHaveLength(STDOUT_TAIL_BYTES)
    files.remove(path)
  })

  it('reads as empty rather than throwing for a path that was never created', () => {
    const files = createNodeStdoutFile()
    expect(files.readTail(join(tmpdir(), 'dwarfai-launch-stdout-never-existed.log'), 1024)).toBe('')
  })

  it('removing a path that is already gone is a no-op, not a throw', () => {
    const files = createNodeStdoutFile()
    expect(() =>
      files.remove(join(tmpdir(), 'dwarfai-launch-stdout-never-existed.log'))
    ).not.toThrow()
  })

  it('generates a fresh path on every call, never reusing one launch’s file for another', () => {
    const files = createNodeStdoutFile()
    expect(files.path()).not.toBe(files.path())
  })

  it('never reuses a stderr path for a stdout file, or vice versa', () => {
    // The two ports are separate files with the same lifetime, never one
    // file wearing two hats — a real launch opens both at once.
    expect(createNodeStdoutFile().path()).not.toBe(createNodeStderrFile().path())
  })
})

/*
 * Hosting the console the launched CLI's own children will inherit (#208).
 *
 * The intermediary is a program TEXT rather than a script file because it
 * travels on `node -e`: the packaged app lives inside app.asar, which a plain
 * node.exe cannot read, so there is no file on disk to point at. Running that
 * text here against a recording spawn is what pins its one decision — a hidden
 * console of its own, and deliberately NOT detached — to a test instead of to
 * prose.
 */
describe('hosting the launched CLI’s console (#208)', () => {
  function runIntermediary(argv: string[]) {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const listeners = new Map<string, (value: unknown) => void>()
    const exitCodes: Array<number | undefined> = []
    const child = {
      on(event: string, listener: (value: unknown) => void) {
        listeners.set(event, listener)
        return child
      }
    }
    const fakeRequire = (id: string): unknown => {
      if (id !== 'child_process') throw new Error(`unexpected require: ${id}`)
      return {
        spawn(command: string, args: readonly string[], options: SpawnOptions) {
          calls.push({ command, args, options })
          return child
        }
      }
    }
    const fakeProcess = {
      argv: ['node', ...argv],
      exit(code?: number) {
        exitCodes.push(code)
      }
    }
    // The program is our own constant, evaluated against fakes: nothing here
    // reads the disk, spawns a process or touches the running OS.
    new Function('require', 'process', CONSOLE_HOSTING_PROGRAM)(fakeRequire, fakeProcess)
    return { calls, listeners, exitCodes }
  }

  /*
   * The Win32 flag interaction this whole fix turns on. CREATE_NO_WINDOW is
   * honoured only when DETACHED_PROCESS is absent, so the intermediary's child
   * must NOT be detached — that is what buys it an invisible console of its own,
   * which the CLI it starts in turn inherits. Measured live: the grandchild
   * reported hasConsole=true with consoleVisible=false, owned by the
   * intermediary's child rather than by itself.
   */
  it('gives its target a hidden console of its own, and never detaches it', () => {
    const { calls } = runIntermediary(['node', NPM_ENTRY, 'exec', '-'])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe('node')
    expect(call.args).toEqual([NPM_ENTRY, 'exec', '-'])
    expect(call.options.windowsHide).toBe(true)
    expect(call.options.detached).toBeUndefined()
    expect(call.options.shell).toBeUndefined()
    // stdin is inherited so the prompt the panel wrote reaches the CLI through
    // the intermediary without being read and rewritten on the way.
    expect(call.options.stdio).toEqual(['inherit', 'ignore', 'ignore'])
  })

  /*
   * libuv puts every non-detached child in a job object created with
   * KILL_ON_JOB_CLOSE, and that job's handle belongs to the spawning process —
   * so the intermediary has to stay alive for as long as its child, or the
   * session dies the moment it exits. Measured live: an intermediary that
   * spawned and returned had its child killed before the child's first
   * statement ran. It must also not outlive the child, or a launch would leak
   * an idle process for every session ever started.
   */
  it('waits for its target and then leaves with the same exit code', () => {
    const { listeners, exitCodes } = runIntermediary(['node', NPM_ENTRY, 'exec', '-'])

    expect(exitCodes).toEqual([])
    listeners.get('exit')!(0)
    expect(exitCodes).toEqual([0])
  })

  it('marks a shim launch as a node-entry launch, so the runner hosts its console', async () => {
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      cli: shimDetector(NPM_SHIM),
      fs
    })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.viaNodeEntry).toBe(true)
  })

  it('does not mark a real executable as a node-entry launch', async () => {
    // A program that IS the console program needs no host: spawned detached it
    // simply has no console, and nothing allocates a visible one for it.
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), fs: new FakeFs() })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.viaNodeEntry).toBe(false)
  })
})

describe('a detached launch that names a model and an effort (#239)', () => {
  it('leaves the argv untouched when the request tunes nothing', async () => {
    // The promise the Add Panel's row rests on: a person who ignores it gets
    // the launch this app has always made.
    const { run, result } = launch({ provider: 'claude' })
    await result
    expect(argvOf(run)).toEqual(['-p', '--input-format', 'text'])
  })

  it("carries the model into Claude's argv, and still not the prompt", async () => {
    const { run, result } = launch({
      provider: 'claude',
      prompt: 'rotate the deploy key',
      tuning: { model: 'sonnet', effort: 'high' }
    })
    await result

    expect(argvOf(run)).toEqual([
      '-p',
      '--input-format',
      'text',
      '--model',
      'sonnet',
      '--effort',
      'high'
    ])
    // The argv/stdin split survives the new flags: what a user typed is still
    // invisible to every other process on this machine.
    expect(argvOf(run).join(' ')).not.toContain('rotate the deploy key')
  })

  it("carries the model into Codex's argv in Codex's own spelling", async () => {
    const { run, result } = launch({
      provider: 'codex',
      cli: installedCodex(),
      tuning: { model: 'gpt-5.6-sol', effort: 'medium' }
    })
    await result

    // AMENDED for #510 (was: no trailing `-o` pair) — see the dedicated -o
    // wiring test in 'launching Codex' above.
    expect(argvOf(run)).toEqual([
      'exec',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=medium',
      '-o',
      CODEX_OUTPUT_PATH,
      '-'
    ])
  })

  it('keeps the tuning behind the shim’s own node entry, not in front of it', async () => {
    // A shim launch runs `node <entry> <the CLI's own argv>` (#193). The
    // tuning belongs to the CLI's argv, so it must land after the entry —
    // in front of it, it would be an argument to node itself.
    const fs = new FakeFs()
    fs.addFile(NPM_SHIM, NPM_SHIM_TEXT)
    const { run, result } = launch({
      provider: 'codex',
      platform: 'win32',
      cli: shimDetector(NPM_SHIM),
      fs,
      tuning: { model: 'gpt-5.6-luna' }
    })
    await result

    // AMENDED for #510 (was: no trailing `-o` pair).
    expect(argvOf(run)).toEqual([
      NPM_ENTRY,
      'exec',
      '-m',
      'gpt-5.6-luna',
      '-o',
      CODEX_OUTPUT_PATH,
      '-'
    ])
  })

  it('refuses an empty prompt before it looks at the tuning at all', async () => {
    // The cheapest refusal stays the cheapest: a tuned launch with nothing to
    // say is still nothing to start, and it must not cost a disk probe.
    const cli = installed()
    const { run, result } = launch({
      prompt: '   ',
      cli,
      tuning: { model: 'sonnet', effort: 'max' }
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'none',
      error: 'Type a prompt first.'
    })
    expect(run).not.toHaveBeenCalled()
    expect(cli.detect).not.toHaveBeenCalled()
  })

  it('says nothing about the model in the verdict, because it cannot know', async () => {
    // What model a session actually ran is the CLI's to report. Repeating the
    // request back would be a claim dressed as an observation.
    const { result } = launch({ provider: 'claude', tuning: { model: 'sonnet', effort: 'low' } })
    await expect(result).resolves.toEqual({ launched: true, provider: 'claude' })
  })
})
