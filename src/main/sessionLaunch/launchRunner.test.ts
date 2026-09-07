import type { SpawnOptions } from 'node:child_process'
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
  launchClaudeSession,
  runLaunchProcess,
  type LaunchChild,
  type LaunchInvocation,
  type LaunchRunner,
  type SpawnLaunch
} from './launchRunner'

const CLAUDE_PATH = '/home/j/.local/bin/claude'
const CODEX_PATH = '/home/j/.local/bin/codex'
const MINE_PATH = '/home/j/work/project'

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
      ...(options.tuning === undefined ? {} : options.tuning)
    })
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

  it('trims and caps the prompt before it reaches the child', async () => {
    const { run, result } = launch({ prompt: `  ${'x'.repeat(MAX_DWARF_TEXT_CHARS + 100)}  ` })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.stdin).toHaveLength(MAX_DWARF_TEXT_CHARS)
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

  it('maps a spawn failure to a stated reason rather than a silent no-op', async () => {
    const { result } = launch({
      run: vi.fn().mockRejectedValue(new Error('ENOENT'))
    })

    await expect(result).resolves.toEqual({
      launched: false,
      provider: 'claude',
      error: 'Claude Code could not be started.'
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
    expect(invocation.args).toEqual(['exec', '-'])
    expect(invocation.stdin).toBe('dig')
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
    expect(invocation.args).toEqual([NPM_ENTRY, 'exec', '-'])
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

  it('says Codex could not be started when the shim names nothing it can run', async () => {
    // A third shim dialect, or a hand-written wrapper: an honest generic
    // failure, never a guess at an entry and never a path on the wire.
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
      error: 'Codex CLI could not be started.'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('starts a real codex executable as itself, reading no shim', async () => {
    const fs = new FakeFs()
    const { run, result } = launch({ provider: 'codex', cli: installedCodex(), fs })
    await result

    const invocation = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchInvocation
    expect(invocation.command).toBe(CODEX_PATH)
    expect(invocation.args).toEqual(['exec', '-'])
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
 * AMENDED for #263 (was: `exit` took no arguments, there was no stderr stream
 * at all, and this lived only inside `describe('runLaunchProcess')`). The
 * runner now reads both — the exit code, to tell a failure from an ordinary
 * end, and stderr, for the CLI's own words — so the fake grows a `stderr` the
 * child exposes and an `exit(code, signal)` that matches what Node's real
 * 'exit' event actually carries. It is hoisted to module scope so the
 * early-failure describe block below can share it rather than duplicating it.
 * Every existing call site that calls `exit()` with no arguments is
 * unchanged: the default below is a clean 0, which is what "the process just
 * ended" already meant to every test that predates this issue.
 */
function fakeSpawn(outcome: 'spawn' | 'error' = 'spawn', pid: number | null = 4242) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const written: string[] = []
  let unrefCalls = 0
  const exited: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const stderrListeners: Array<(chunk: Buffer | string) => void> = []
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
      stderr: {
        on(event, listener) {
          if (event === 'data') stderrListeners.push(listener)
          return child.stderr
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
    },
    writeStderr: (chunk: string) => {
      for (const listener of stderrListeners) listener(chunk)
    }
  }
}

describe('runLaunchProcess', () => {
  function invocation(overrides: Partial<LaunchInvocation> = {}): LaunchInvocation {
    return {
      command: CODEX_PATH,
      args: ['exec', '-'],
      env: { PATH: '/usr/bin' },
      cwd: MINE_PATH,
      stdin: 'dig',
      viaNodeEntry: false,
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

    // Was `resolves.toBeUndefined()` before #217; the runner now answers with
    // the retained handle, and the spawn assertions below are unchanged.
    await expect(
      runLaunchProcess(
        invocation({ command: 'node', args: [NPM_ENTRY, 'exec', '-'] }),
        spawn.spawnProcess
      )
    ).resolves.toMatchObject({ pid: 4242 })

    expect(spawn.calls).toHaveLength(1)
    const call = spawn.calls[0]!
    expect(call.command).toBe('node')
    expect(call.args).toEqual([NPM_ENTRY, 'exec', '-'])
    // AMENDED for #263 (was: stdio: ['pipe', 'ignore', 'ignore']). stderr is
    // now piped rather than discarded, so a launch that fails almost at once
    // can say why — see the early-failure window describe block below.
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    expect(spawn.written).toEqual(['dig'])
    expect(spawn.unrefCalls()).toBe(1)
  })

  it('rejects when the child reports it could not start, writing nothing', async () => {
    const spawn = fakeSpawn('error')

    await expect(runLaunchProcess(invocation(), spawn.spawnProcess)).rejects.toThrow('EINVAL')
    expect(spawn.written).toEqual([])
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
      spawn.spawnProcess
    )

    const call = spawn.calls[0]!
    // The same node, twice: once to run the intermediary, once as the program
    // the intermediary starts. Nothing else is introduced into the chain.
    expect(call.command).toBe('node')
    expect(call.args).toEqual(['-e', CONSOLE_HOSTING_PROGRAM, 'node', NPM_ENTRY, 'exec', '-'])
    // The outer spawn is unchanged: detached is still what makes the session
    // outlive the panel, and no shell is involved in either hop.
    // AMENDED for #263, for the same reason the test above was.
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    expect(spawn.written).toEqual(['dig'])
  })

  it('spawns a program that is its own console program as itself, with no intermediary', async () => {
    const spawn = fakeSpawn()

    await runLaunchProcess(
      invocation({ command: CODEX_PATH, args: ['exec', '-'], viaNodeEntry: false }),
      spawn.spawnProcess
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
      spawn.spawnProcess
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
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)

    let gone = false
    retained?.onExit(() => {
      gone = true
    })
    expect(gone).toBe(false)
    spawn.exit()
    expect(gone).toBe(true)
  })

  it('retains nothing when the child reports no pid at all', async () => {
    const spawn = fakeSpawn('spawn', null)
    await expect(runLaunchProcess(invocation(), spawn.spawnProcess)).resolves.toBeUndefined()
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
      spawn.spawnProcess
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
      ...overrides
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the exit code and the stderr the child wrote, for an exit inside the window', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    spawn.writeStderr('codex: another instance is already running\n')
    spawn.exit(1)

    expect(onEarlyFailure).toHaveBeenCalledWith({
      exitCode: 1,
      signal: null,
      stderrTail: 'codex: another instance is already running\n'
    })
  })

  it('never reports a clean exit inside the window as a failure', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)
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
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)
    const onEarlyFailure = vi.fn()
    retained?.onEarlyFailure?.(onEarlyFailure)

    vi.advanceTimersByTime(EARLY_FAILURE_WINDOW_MS + 1)
    spawn.exit(1)

    expect(onEarlyFailure).not.toHaveBeenCalled()
  })

  it('reports a signal-only exit too, with no code', async () => {
    const spawn = fakeSpawn()
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)
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
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)

    spawn.writeStderr('auth expired\n')
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
    const retained = await runLaunchProcess(invocation(), spawn.spawnProcess)
    const onEarlyFailure = vi.fn<(failure: LaunchFailure) => void>()
    retained?.onEarlyFailure?.(onEarlyFailure)

    // Comfortably past any reasonable KiB-scale bound; asserting the exact
    // cap here would pin an implementation detail rather than the property
    // that matters — this must never grow without limit.
    const flood = 'x'.repeat(64 * 1024)
    spawn.writeStderr(flood)
    spawn.exit(1)

    const failure = onEarlyFailure.mock.calls[0]![0]
    expect(failure.stderrTail.length).toBeLessThan(flood.length)
    // The END of the flood survives, not the start — the last lines of a
    // refusal are the ones that say what actually happened.
    expect(flood.endsWith(failure.stderrTail)).toBe(true)
  })

  it('never watches a child this process could not hold onto (no pid)', async () => {
    const spawn = fakeSpawn('spawn', null)

    await expect(runLaunchProcess(invocation(), spawn.spawnProcess)).resolves.toBeUndefined()
    // Nothing to assert an onEarlyFailure against — there is no handle at all,
    // which is the existing 'retains nothing' rule this respects rather than
    // reopens.
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

    expect(argvOf(run)).toEqual([
      'exec',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=medium',
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

    expect(argvOf(run)).toEqual([NPM_ENTRY, 'exec', '-m', 'gpt-5.6-luna', '-'])
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
