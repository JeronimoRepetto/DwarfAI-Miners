import type { SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import { MAX_DWARF_TEXT_CHARS, type DwarfProvider } from '../domain/types'
import type { CliDetection, CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import {
  CONSOLE_HOSTING_PROGRAM,
  launchClaudeSession,
  runLaunchProcess,
  type LaunchChild,
  type LaunchInvocation,
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
  run?: (invocation: LaunchInvocation) => Promise<void>
  env?: NodeJS.ProcessEnv
  platform?: Platform
  fs?: FsLike
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
      run
    })
  }
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

  function fakeSpawn(outcome: 'spawn' | 'error' = 'spawn') {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const written: string[] = []
    let unrefCalls = 0
    const spawnProcess: SpawnLaunch = (command, args, options) => {
      calls.push({ command, args, options })
      const spawned: Array<() => void> = []
      const failed: Array<(error: Error) => void> = []
      const child: LaunchChild = {
        once(event, listener) {
          if (event === 'spawn') spawned.push(listener as () => void)
          else failed.push(listener)
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
    return { spawnProcess, calls, written, unrefCalls: () => unrefCalls }
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

    await expect(
      runLaunchProcess(
        invocation({ command: 'node', args: [NPM_ENTRY, 'exec', '-'] }),
        spawn.spawnProcess
      )
    ).resolves.toBeUndefined()

    expect(spawn.calls).toHaveLength(1)
    const call = spawn.calls[0]!
    expect(call.command).toBe('node')
    expect(call.args).toEqual([NPM_ENTRY, 'exec', '-'])
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
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
    expect(call.options).toEqual({
      cwd: MINE_PATH,
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
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
