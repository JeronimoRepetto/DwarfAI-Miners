import type { SpawnOptions } from 'node:child_process'
import { existsSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import type { LaunchTuning } from '../domain/launchTuning'
import { NOT_LAUNCHABLE } from '../domain/launchProviders'
import { DWARF_PROVIDERS, type DwarfProvider } from '../domain/types'
import type { CliDetection, CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import type { LaunchFailure } from './launchedSessions'
import {
  CONSOLE_HOSTING_PROGRAM,
  EARLY_FAILURE_WINDOW_MS,
  STDERR_TAIL_BYTES,
  STDOUT_TAIL_BYTES,
  createNodeStderrFile,
  createNodeStdoutFile,
  launchClaudeSession,
  runLaunchProcess,
  type LaunchChild,
  type LaunchInvocation,
  type LaunchRunner,
  type SpawnLaunch,
  type StderrFile,
  type StdoutFile
} from './launchRunner'
import type { DelegationInjectionContext } from '../mcp/delegationInjection'

const CLAUDE_PATH = '/home/j/.local/bin/claude'
const CODEX_PATH = '/home/j/.local/bin/codex'
const OPENCODE_PATH = '/home/j/.local/bin/opencode'
const MINE_PATH = '/home/j/work/project'

/** A node entry an npm cmd-shim names, as the console host below receives it. */
const NPM_DIR = 'C:\\Users\\x\\AppData\\Roaming\\npm'
const NPM_ENTRY = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`
function detector(verdict: CliDetection): CliDetector {
  return { detect: vi.fn().mockResolvedValue(verdict), peek: vi.fn().mockReturnValue(verdict) }
}

function installed(): CliDetector {
  return detector({ cli: 'claude', installed: true, path: CLAUDE_PATH, source: 'convention' })
}

function installedOpenCode(): CliDetector {
  return detector({ cli: 'opencode', installed: true, path: OPENCODE_PATH, source: 'convention' })
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
  /** #511 T4: the gate's own approved injection, or absent for an ordinary launch. */
  delegation?: DelegationInjectionContext
}) {
  const run = options.run ?? vi.fn().mockResolvedValue(undefined)
  // AMENDED for ISSUE-184, the step-3a deletion (was: Claude and a detected
  // `claude` by default): today's launcher starts OpenCode only, so the cases
  // that prove the launcher itself run on a detected OpenCode.
  return {
    run,
    result: launchClaudeSession({
      provider: options.provider ?? 'opencode',
      minePath: MINE_PATH,
      prompt: options.prompt ?? 'set up the build',
      detector: options.cli ?? installedOpenCode(),
      env: options.env ?? { PATH: '/usr/bin' },
      platform: options.platform ?? 'linux',
      fs: options.fs ?? new FakeFs(),
      run,
      ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
      ...(options.tuning === undefined ? {} : options.tuning)
    })
  }
}

// AMENDED for ISSUE-184, the step-3a deletion (was: these cases on a detected
// Claude). AMENDED for ISSUE-239, the step-4b deletion (was: "the launcher's
// own behaviour runs on OpenCode, the one provider it still starts"): today's
// OpenCode launch left the tree, so the launcher starts no provider; the cases
// that started one left with it (docs/test-removals.md).
describe('launchClaudeSession', () => {
  it('refuses every provider before detecting or spawning anything since the step-4b deletion', async () => {
    for (const provider of DWARF_PROVIDERS) {
      const cli = installedOpenCode()
      const { run, result } = launch({ provider, cli })

      await expect(result).resolves.toEqual({
        launched: false,
        provider,
        error: NOT_LAUNCHABLE
      })
      expect(run).not.toHaveBeenCalled()
      expect(cli.detect).not.toHaveBeenCalled()
    }
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

  it('still refuses when detection claims installed but names no path', async () => {
    const { run, result } = launch({ cli: detector({ cli: 'opencode', installed: true }) })

    await expect(result).resolves.toMatchObject({ launched: false, provider: 'opencode' })
    expect(run).not.toHaveBeenCalled()
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
 * (`openForWrite`/`writeStdout`, exactly like `fakeStderrFile`), and a file
 * a CLI writes directly at a path this app names and only ever reads and
 * removes — `write(path, text)` stands in for that write, never through
 * `openForWrite` (Codex's own `-o` file was the one such file until
 * ISSUE-185 deleted today's Codex launch).
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
})
