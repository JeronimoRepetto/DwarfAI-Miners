import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PIPE_ACL_UNAVAILABLE,
  PIPE_NAME_IN_USE,
  type OwnerOnlyPipeHandlers
} from '../../../transport/endpoint/windowsPipeSecurity'
import {
  createNativeOwnerOnlyPipe,
  WIN_PIPE_BINARY,
  winPipePrebuildsDir,
  type NativeOwnerOnlyPipeOptions,
  type WinPipeBinding
} from './nativeOwnerOnlyPipe'

// L2 (17 §1.2): the loader and the decisions around the native helper, with a fake binding, on
// every OS. The real binding (win_pipe.c) is the Windows OS lane's (nativeOwnerOnlyPipe.os.test.ts).

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A prebuilds folder holding a binary file for `arch` (its bytes are never read by the fake). */
function prebuilds(arch: string, withBinary = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dw022n-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (withBinary) {
    mkdirSync(join(dir, `win32-${arch}`))
    writeFileSync(join(dir, `win32-${arch}`, WIN_PIPE_BINARY), '')
  }
  return dir
}

type OnEvent = (error: number, fd: number) => void

/** A binding double: records what the adapter asks and lets the test play the native side. */
function fakeBinding(listen?: (name: string) => void): WinPipeBinding & {
  listened: string[]
  closed: number
  emit: OnEvent
} {
  const state = { listened: [] as string[], closed: 0, emit: (() => {}) as OnEvent }
  return {
    get listened() {
      return state.listened
    },
    get closed() {
      return state.closed
    },
    get emit() {
      return state.emit
    },
    listen(name, onEvent) {
      listen?.(name)
      state.listened.push(name)
      state.emit = onEvent
      return {}
    },
    close() {
      state.closed += 1
    }
  }
}

function handlers(): OwnerOnlyPipeHandlers & { sockets: Socket[]; errors: string[] } {
  const sockets: Socket[] = []
  const errors: string[] = []
  return {
    sockets,
    errors,
    onConnection: (socket) => sockets.push(socket),
    onError: (code) => errors.push(code)
  }
}

function adapter(overrides: Partial<NativeOwnerOnlyPipeOptions> & { prebuildsDir: string }) {
  return createNativeOwnerOnlyPipe({ arch: 'x64', ...overrides })
}

const NAME = '\\\\.\\pipe\\dwarfai-host-0123456789abcdef-0123456789ab'

describe('the native owner-only pipe adapter (ADR-003 item 2)', () => {
  it('[ADR-003, FM-036] a missing binary makes the pipe unavailable, named binary-missing, and nothing is loaded', async () => {
    const loaded: string[] = []
    const listen = adapter({
      prebuildsDir: prebuilds('x64', false),
      load: (path) => {
        loaded.push(path)
        return fakeBinding()
      }
    })

    const outcome = await listen(NAME, handlers())

    expect(outcome).toEqual({ ok: false, code: PIPE_ACL_UNAVAILABLE, causeClass: 'binary-missing' })
    expect(loaded).toEqual([])
  })

  it('[ADR-003, FM-036] a binary that fails to load makes the pipe unavailable, named load-failed', async () => {
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () => {
        throw new Error('The specified module could not be found.')
      }
    })

    expect(await listen(NAME, handlers())).toEqual({
      ok: false,
      code: PIPE_ACL_UNAVAILABLE,
      causeClass: 'load-failed'
    })
  })

  it('[ADR-003, FM-036] a binary without the helper functions makes the pipe unavailable, named load-failed', async () => {
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () => ({}) as WinPipeBinding
    })

    expect(await listen(NAME, handlers())).toEqual({
      ok: false,
      code: PIPE_ACL_UNAVAILABLE,
      causeClass: 'load-failed'
    })
  })

  it('[ADR-003] the binary of this architecture is loaded once, on the first listen', async () => {
    const dir = prebuilds('arm64')
    const loaded: string[] = []
    const binding = fakeBinding()
    const listen = adapter({
      prebuildsDir: dir,
      arch: 'arm64',
      load: (path) => {
        loaded.push(path)
        return binding
      }
    })
    expect(loaded).toEqual([])

    await listen(NAME, handlers())
    await listen(`${NAME}-2`, handlers())

    expect(loaded).toEqual([join(dir, 'win32-arm64', WIN_PIPE_BINARY)])
    expect(binding.listened).toEqual([NAME, `${NAME}-2`])
  })

  it('[ADR-002] a name that already has an instance (ERROR_ACCESS_DENIED from the first instance) is in use', async () => {
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () =>
        fakeBinding(() => {
          throw Object.assign(new Error('CreateNamedPipeW failed'), { code: 'WIN32_5' })
        })
    })

    expect(await listen(NAME, handlers())).toEqual({ ok: false, code: PIPE_NAME_IN_USE })
  })

  it('[ADR-003] any other creation failure keeps its Win32 code', async () => {
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () =>
        fakeBinding(() => {
          throw Object.assign(new Error('CreateNamedPipeW failed'), { code: 'WIN32_123' })
        })
    })

    expect(await listen(NAME, handlers())).toEqual({ ok: false, code: 'WIN32_123' })
  })

  it("[ADR-003] each connected client's descriptor is handed over as a socket", async () => {
    const binding = fakeBinding()
    const made: number[] = []
    const socket = new Socket()
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () => binding,
      socketFromFd: (fd) => {
        made.push(fd)
        return socket
      }
    })
    const h = handlers()
    await listen(NAME, h)

    binding.emit(0, 42)

    expect(made).toEqual([42])
    expect(h.sockets).toEqual([socket])
    expect(h.errors).toEqual([])
  })

  it('[ADR-003] a descriptor that cannot become a socket is closed and reported, never leaked', async () => {
    const binding = fakeBinding()
    const closedFds: number[] = []
    const listen = adapter({
      prebuildsDir: prebuilds('x64'),
      load: () => binding,
      socketFromFd: () => {
        throw new Error('EINVAL')
      },
      closeFd: (fd) => closedFds.push(fd)
    })
    const h = handlers()
    await listen(NAME, h)

    binding.emit(0, 42)

    expect(closedFds).toEqual([42])
    expect(h.sockets).toEqual([])
    expect(h.errors).toEqual(['ENDPOINT_PIPE_HANDOFF_FAILED'])
  })

  it('[ADR-003] an accept failure the helper reports reaches onError with its Win32 code', async () => {
    const binding = fakeBinding()
    const listen = adapter({ prebuildsDir: prebuilds('x64'), load: () => binding })
    const h = handlers()
    await listen(NAME, h)

    binding.emit(8, -1)

    expect(h.errors).toEqual(['WIN32_8'])
    expect(h.sockets).toEqual([])
  })

  it('[ADR-003] the binary is looked up at the app root: prebuilds/ in a development tree, app.asar.unpacked/prebuilds/ when packaged', () => {
    expect(winPipePrebuildsDir(join('repo'))).toBe(join('repo', 'prebuilds'))
    expect(
      winPipePrebuildsDir(join('C:', 'Program Files', 'DwarfAI', 'resources', 'app.asar'))
    ).toBe(join('C:', 'Program Files', 'DwarfAI', 'resources', 'app.asar.unpacked', 'prebuilds'))
  })

  it('[ADR-003] close closes the native listener once', async () => {
    const binding = fakeBinding()
    const listen = adapter({ prebuildsDir: prebuilds('x64'), load: () => binding })
    const outcome = await listen(NAME, handlers())
    if (!outcome.ok) throw new Error(`expected a listening pipe, got ${outcome.code}`)

    await outcome.server.close()
    await outcome.server.close()

    expect(binding.closed).toBe(1)
  })
})
