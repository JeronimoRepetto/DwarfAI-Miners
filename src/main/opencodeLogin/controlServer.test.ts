import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { DirEntry, FileStat, FsLike } from '../adapters/fsLike'
import type { ProcessEndPort } from '../platform/processEnd'
import {
  buildControlServerSpawn,
  createOpenCodeControlServer,
  parseControlServerUrl,
  type ControlServerChild,
  type OpenCodeControlServerOptions,
  type SpawnControlServer
} from './controlServer'

/*
 * The spawn call as a VALUE, asserted on any host OS — the same division
 * buildLaunchSpawn/buildHostedSpawn already keep, so the Windows reasoning
 * behind these flags is pinned by a suite that runs on Linux and macOS too.
 */
describe('buildControlServerSpawn', () => {
  const PROGRAM = { command: 'C:\\tools\\opencode.exe', args: [] }

  it('runs serve --pure on loopback with an ephemeral port', () => {
    const call = buildControlServerSpawn(PROGRAM, { password: 'x', env: {} })

    expect(call.command).toBe('C:\\tools\\opencode.exe')
    expect(call.args).toEqual(['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'])
  })

  it('places the resolved program argv ahead of the serve subcommand', () => {
    const shimmed = { command: 'node', args: ['C:\\tools\\opencode.js'] }
    const call = buildControlServerSpawn(shimmed, { password: 'x', env: {} })

    expect(call.args).toEqual([
      'C:\\tools\\opencode.js',
      'serve',
      '--pure',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1'
    ])
  })

  // No shell, ever: this is the app's own argv, and a shell hop is exactly
  // what the measured node -> cmd -> wrapper -> opencode.exe tree came from.
  it('never asks for a shell', () => {
    expect(
      buildControlServerSpawn(PROGRAM, { password: 'x', env: {} }).options.shell
    ).toBeUndefined()
  })

  // Detached so it becomes its own process group on POSIX, which is what
  // ProcessEndPort.endProcessTree's group signal (kill -TERM -<pid>) needs to
  // reach — the same reason every launched, later-ended session is detached.
  it('detaches, so the tree-kill port has a group to signal', () => {
    expect(buildControlServerSpawn(PROGRAM, { password: 'x', env: {} }).options.detached).toBe(true)
  })

  it('hides the window', () => {
    expect(buildControlServerSpawn(PROGRAM, { password: 'x', env: {} }).options.windowsHide).toBe(
      true
    )
  })

  // Piped, never ignored: the port `--port 0` chose is only ever readable off
  // this child's own announcement line, which this app cannot read any other
  // way (measured: --port 0 still chose 4096).
  it('pipes stdout and stderr, and never writes to stdin', () => {
    expect(buildControlServerSpawn(PROGRAM, { password: 'x', env: {} }).options.stdio).toEqual([
      'ignore',
      'pipe',
      'pipe'
    ])
  })

  it('merges the password into the given environment without discarding it', () => {
    const call = buildControlServerSpawn(PROGRAM, { password: 'secret-123', env: { FOO: 'bar' } })

    expect(call.options.env).toEqual({ FOO: 'bar', OPENCODE_SERVER_PASSWORD: 'secret-123' })
  })

  it('never places the password in argv, where a process list could show it', () => {
    const call = buildControlServerSpawn(PROGRAM, { password: 'secret-123', env: {} })

    expect(JSON.stringify(call.args)).not.toContain('secret-123')
    expect(JSON.stringify(call.command)).not.toContain('secret-123')
  })
})

describe('parseControlServerUrl', () => {
  it('parses the announced URL — measured: --port 0 still chose 4096', () => {
    expect(parseControlServerUrl('opencode server listening on http://127.0.0.1:4096\n')).toBe(
      'http://127.0.0.1:4096'
    )
  })

  it('finds the announcement among other lines rather than requiring it be alone', () => {
    const banner = [
      'reading config...',
      'server is unsecured: set OPENCODE_SERVER_PASSWORD to protect it',
      'opencode server listening on http://127.0.0.1:51422',
      ''
    ].join('\n')

    expect(parseControlServerUrl(banner)).toBe('http://127.0.0.1:51422')
  })

  it('returns undefined for a buffer with no announcement yet', () => {
    expect(parseControlServerUrl('reading config...\n')).toBeUndefined()
  })

  it('returns undefined for an empty buffer', () => {
    expect(parseControlServerUrl('')).toBeUndefined()
  })
})

/** A recording stand-in for a real child, so readiness is asserted with no real process. */
class FakeChild implements ControlServerChild {
  pid: number | undefined
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>()
  readonly outListeners: ((chunk: Buffer | string) => void)[] = []
  readonly errListeners: ((chunk: Buffer | string) => void)[] = []
  stdout: ControlServerChild['stdout'] = {
    on: (_event, listener) => this.outListeners.push(listener)
  }
  stderr: ControlServerChild['stderr'] = {
    on: (_event, listener) => this.errListeners.push(listener)
  }

  constructor(pid: number | undefined = 4242) {
    this.pid = pid
  }

  once(event: string, listener: (...args: never[]) => void): unknown {
    const kept = this.listeners.get(event) ?? []
    kept.push(listener)
    this.listeners.set(event, kept)
    return this
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...args: unknown[]) => void)(...args)
    }
  }

  emitStdout(chunk: string): void {
    for (const listener of this.outListeners) listener(chunk)
  }

  emitStderr(chunk: string): void {
    for (const listener of this.errListeners) listener(chunk)
  }
}

function fakeSpawn(children: readonly FakeChild[]): {
  spawn: SpawnControlServer
  calls: { command: string; args: string[]; options: SpawnOptions }[]
} {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = []
  let index = 0
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args: [...args], options })
      const child = children[index]
      index += 1
      if (child === undefined) throw new Error('fakeSpawn: no more children queued')
      return child
    }
  }
}

/**
 * Waits for every microtask queued so far to drain — `ensure()` awaits the
 * injected `resolveBinaryPath()` and `resolveProgram()` before it ever spawns,
 * so a test that fires a child event right after calling `ensure()` would
 * fire it before the listeners exist. A macrotask boundary is what guarantees
 * the microtask queue is empty by the time this resolves.
 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** A real `NodeJS.ErrnoException`-shaped error, the way Node's own fs calls actually throw one. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/**
 * An `FsLike` whose `readTextHead` fails the way the real adapter does when a
 * detected shim stops existing before this app reads it back — uninstalled or
 * moved between detection and a start attempt. Every other method is unused
 * by `resolveProgram`'s shim-reading path and throws if that ever changes.
 */
class UnreadableFs implements FsLike {
  constructor(private readonly error: Error) {}
  async readTextTail(): Promise<string> {
    throw new Error('UnreadableFs: readTextTail unused by this suite')
  }
  async readTextHead(): Promise<string> {
    throw this.error
  }
  async readJson(): Promise<unknown> {
    throw new Error('UnreadableFs: readJson unused by this suite')
  }
  async listDir(): Promise<DirEntry[]> {
    return []
  }
  async stat(): Promise<FileStat | null> {
    return null
  }
  async exists(): Promise<boolean> {
    return false
  }
}

function fakeProcessEnd(): { port: ProcessEndPort; endedPids: number[] } {
  const endedPids: number[] = []
  return {
    endedPids,
    port: {
      endProcessTree: async (pid: number) => {
        endedPids.push(pid)
        return true
      },
      terminateProcess: async () => true,
      killProcess: async () => true
    }
  }
}

/** One server wired to fakes throughout, so a test only names what it overrides. */
function makeServer(
  overrides: Partial<OpenCodeControlServerOptions> = {},
  children: readonly FakeChild[] = [new FakeChild()]
) {
  const { spawn, calls } = fakeSpawn(children)
  const { port: processEnd, endedPids } = fakeProcessEnd()
  const server = createOpenCodeControlServer({
    resolveBinaryPath: async () => '/usr/local/bin/opencode',
    env: {},
    spawn,
    processEnd,
    generatePassword: () => 'test-password',
    readyTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
    ...overrides
  })
  return { server, calls, endedPids, child: children[0]! }
}

describe('createOpenCodeControlServer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the server and resolves the url once it announces itself', async () => {
    const { server, child } = makeServer()
    const started = server.ensure()

    await flushAsync()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    const result = await started

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.url).toBe('http://127.0.0.1:4096')
    expect(result.readPassword()).toBe('test-password')
  })

  it('spawns exactly once, with serve on the resolved program', async () => {
    const { server, child, calls } = makeServer()
    const started = server.ensure()
    await flushAsync()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await started

    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('serve')
  })

  it('reports not-installed and spawns nothing when opencode cannot be found', async () => {
    const { server, calls } = makeServer({ resolveBinaryPath: async () => undefined })

    const result = await server.ensure()

    expect(result).toEqual({ ok: false, reason: 'not-installed', detail: expect.any(String) })
    expect(calls).toHaveLength(0)
  })

  it('reports not-installed when the detected shim cannot be started from here', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\npm\\opencode.cmd', 'echo not a recognised shim dialect')
    const { server, calls } = makeServer({
      resolveBinaryPath: async () => 'C:\\npm\\opencode.cmd',
      fs
    })

    const result = await server.ensure()

    expect(result).toEqual({
      ok: false,
      reason: 'not-installed',
      detail: expect.stringContaining('dialect')
    })
    expect(calls).toHaveLength(0)
  })

  it('reports spawn-failed when spawn itself throws', async () => {
    const { port: processEnd } = fakeProcessEnd()
    const server = createOpenCodeControlServer({
      resolveBinaryPath: async () => '/bin/opencode',
      env: {},
      spawn: () => {
        throw new Error('EACCES')
      },
      processEnd
    })

    await expect(server.ensure()).resolves.toEqual({
      ok: false,
      reason: 'spawn-failed',
      detail: 'EACCES'
    })
  })

  it('reports spawn-failed when the child fires its own error event', async () => {
    const { server, child } = makeServer()
    const started = server.ensure()
    await flushAsync()
    const error: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), {
      code: 'ENOENT'
    })

    child.fire('error', error)

    await expect(started).resolves.toEqual({
      ok: false,
      reason: 'spawn-failed',
      detail: 'ENOENT'
    })
  })

  it('reports exited-before-ready when the process ends before announcing', async () => {
    const { server, child } = makeServer()
    const started = server.ensure()
    await flushAsync()

    child.fire('exit', 1, null)

    await expect(started).resolves.toEqual({
      ok: false,
      reason: 'exited-before-ready',
      detail: expect.any(String)
    })
  })

  it('times out and kills the whole tree when the child never announces', async () => {
    vi.useFakeTimers()
    const { server, endedPids } = makeServer({ readyTimeoutMs: 10_000 })

    const started = server.ensure()
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(started).resolves.toEqual({ ok: false, reason: 'timed-out' })
    expect(endedPids).toEqual([4242])
  })

  it('shares one start between concurrent callers', async () => {
    const { server, child, calls } = makeServer()
    const first = server.ensure()
    const second = server.ensure()
    await flushAsync()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')

    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
  })

  it('reuses a running server rather than starting a second one', async () => {
    const { server, child, calls } = makeServer()
    const first = server.ensure()
    await flushAsync()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await first

    const second = await server.ensure()

    expect(calls).toHaveLength(1)
    expect(second).toEqual({
      ok: true,
      url: 'http://127.0.0.1:4096',
      readPassword: expect.any(Function)
    })
  })

  it('stops itself after sitting idle, killing the whole tree', async () => {
    vi.useFakeTimers()
    const { server, child, endedPids } = makeServer({ idleTimeoutMs: 60_000 })
    const started = server.ensure()
    await vi.advanceTimersByTimeAsync(0)
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await started

    await vi.advanceTimersByTimeAsync(60_000)

    expect(endedPids).toEqual([4242])
  })

  it('kills the running server on stop()', async () => {
    const { server, child, endedPids } = makeServer()
    const started = server.ensure()
    await flushAsync()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await started

    await server.stop()

    expect(endedPids).toEqual([4242])
  })

  it('waits out an in-flight start before stopping, rather than leaving it orphaned', async () => {
    const { server, child, endedPids } = makeServer()
    const started = server.ensure()
    await flushAsync()

    const stopped = server.stop()
    child.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await started
    await stopped

    expect(endedPids).toEqual([4242])
  })

  it('does nothing when stop() is called with no server running or starting', async () => {
    const { server, endedPids } = makeServer()

    await expect(server.stop()).resolves.toBeUndefined()

    expect(endedPids).toEqual([])
  })

  it('starts a fresh server after the running one exits on its own', async () => {
    const childA = new FakeChild(4242)
    const childB = new FakeChild(5151)
    const { server, calls } = makeServer({}, [childA, childB])

    const first = server.ensure()
    await flushAsync()
    childA.emitStdout('opencode server listening on http://127.0.0.1:4096\n')
    await first

    // The server crashed some time after being handed out.
    childA.fire('exit', 1, null)

    const second = server.ensure()
    await flushAsync()
    childB.emitStdout('opencode server listening on http://127.0.0.1:5151\n')
    const result = await second

    expect(calls).toHaveLength(2)
    expect(result).toEqual({
      ok: true,
      url: 'http://127.0.0.1:5151',
      readPassword: expect.any(Function)
    })
  })

  /*
   * A detected shim can stop existing before this app ever reads it back —
   * opencode uninstalled or moved between detection and a start attempt.
   * `resolveProgram`'s own `fs.readTextHead` throws in that case (a real
   * ENOENT, not a refusal shape), and `ensure()` promises a typed result to
   * every caller — never an unhandled rejection.
   */
  it('reports not-installed, never rejects, when the resolved binary cannot be read', async () => {
    const enoent = errnoError(
      'ENOENT',
      "ENOENT: no such file or directory, open 'C:\\opencode.cmd'"
    )
    const { server, calls } = makeServer({
      resolveBinaryPath: async () => 'C:\\opencode.cmd',
      fs: new UnreadableFs(enoent)
    })

    await expect(server.ensure()).resolves.toEqual({
      ok: false,
      reason: 'not-installed',
      detail: 'ENOENT'
    })
    expect(calls).toHaveLength(0)
  })

  it('does not poison later ensure() calls after an unreadable-binary failure', async () => {
    const enoent = errnoError(
      'ENOENT',
      "ENOENT: no such file or directory, open 'C:\\opencode.cmd'"
    )
    const childB = new FakeChild(9000)
    let attempt = 0
    const { server, calls } = makeServer(
      {
        resolveBinaryPath: async () => {
          attempt += 1
          // First attempt: the shim path that no longer exists. Second
          // attempt: opencode is present again, at a plain (non-shim) path.
          return attempt === 1 ? 'C:\\opencode.cmd' : '/usr/local/bin/opencode'
        },
        fs: new UnreadableFs(enoent)
      },
      [childB]
    )

    await expect(server.ensure()).resolves.toEqual({
      ok: false,
      reason: 'not-installed',
      detail: 'ENOENT'
    })

    const second = server.ensure()
    await flushAsync()
    childB.emitStdout('opencode server listening on http://127.0.0.1:4096\n')

    await expect(second).resolves.toEqual({
      ok: true,
      url: 'http://127.0.0.1:4096',
      readPassword: expect.any(Function)
    })
    expect(calls).toHaveLength(1)
  })
})
