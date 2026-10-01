// The owner-only pipe helper of ADR-003 item 2 (frozen) on Windows: the adapter around the native
// module win_pipe.c (owner decision 2026-10-01; spike SP-05 made the helper mandatory).
//
// The module creates every instance of the pipe with the protected DACL
// `D:P(D;;GA;;;NU)(A;;GA;;;<user SID>)(A;;GA;;;SY)` (the SID is the Host process's own user) and
// PIPE_REJECT_REMOTE_CLIENTS, the first one as the first instance of its name (the ADR-002 D3
// mutex). It waits for each client, turns the connected pipe into a C runtime descriptor of this
// process (libuv's `uv_open_osfhandle`, exported by node.exe and by Electron), and this adapter
// makes that descriptor a `net.Socket`: Node does all the I/O.
//
// - Only this folder loads the binary. It is prebuilt per architecture (CI, `pnpm build:native`)
//   and ships in the app under `prebuilds/win32-<arch>/` (asar-unpacked); nothing is compiled on a
//   person's machine, and the static C runtime means no VC++ redistributable.
// - It is loaded on the first listen, so on macOS and Linux, whose endpoint is a Unix socket, it is
//   never loaded.
// - A binary that is missing or does not load is reported as PIPE_ACL_UNAVAILABLE with a cause
//   class, which fails the bind (windowsPipeSecurity.ts): the pipe is never created without it.
// - ERROR_ACCESS_DENIED when creating the first instance means the name already has one (libuv maps
//   it to EADDRINUSE the same way); any other Win32 error keeps its number as `WIN32_<n>`.
import { closeSync, existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import {
  PIPE_ACL_UNAVAILABLE,
  PIPE_NAME_IN_USE,
  type ListenOwnerOnlyPipe
} from '../../../transport/endpoint/windowsPipeSecurity'

/** The binary's file name inside `prebuilds/win32-<arch>/`. */
export const WIN_PIPE_BINARY = 'dwarfai_win_pipe.node'

/** The native listener, opaque to JavaScript. */
export type WinPipeHandle = object

/** The surface of win_pipe.c. */
export interface WinPipeBinding {
  /**
   * Creates the pipe and starts accepting. `onEvent(0, fd)` hands a connected client over as a
   * descriptor; `onEvent(win32Error, -1)` reports an accept failure. Throws an error whose `code` is
   * `WIN32_<n>` when the pipe cannot be created.
   */
  listen(name: string, onEvent: (error: number, fd: number) => void): WinPipeHandle
  /** Closes the waiting instances; connections already handed over are not touched. */
  close(handle: WinPipeHandle): void
}

export interface NativeOwnerOnlyPipeOptions {
  /** The folder holding `win32-<arch>/dwarfai_win_pipe.node`: `prebuilds/` at the app root. */
  prebuildsDir: string
  /** The architecture whose binary is loaded; default this process's. */
  arch?: string
  /** Loads the binary; default `process.dlopen`. */
  load?: (path: string) => WinPipeBinding
  /** Makes a socket of a connected descriptor; default `new net.Socket({ fd })`. */
  socketFromFd?: (fd: number) => Socket
  /** Closes a descriptor that could not become a socket; default `fs.closeSync`. */
  closeFd?: (fd: number) => void
}

/** ERROR_ACCESS_DENIED: the first instance of a name that already has one. */
const NAME_IN_USE_CODE = 'WIN32_5'

/** The accept error of a descriptor that could not become a socket. */
const HANDOFF_FAILED = 'ENDPOINT_PIPE_HANDOFF_FAILED'

type Loaded = { ok: true; binding: WinPipeBinding } | { ok: false; causeClass: string }

export function createNativeOwnerOnlyPipe(
  options: NativeOwnerOnlyPipeOptions
): ListenOwnerOnlyPipe {
  const path = join(options.prebuildsDir, `win32-${options.arch ?? process.arch}`, WIN_PIPE_BINARY)
  const load = options.load ?? dlopen
  const socketFromFd =
    options.socketFromFd ?? ((fd) => new Socket({ fd, readable: true, writable: true }))
  const closeFd = options.closeFd ?? closeSync
  let loaded: Loaded | undefined

  return (name, handlers) => {
    loaded ??= loadBinding(path, load)
    if (!loaded.ok) {
      return Promise.resolve({
        ok: false,
        code: PIPE_ACL_UNAVAILABLE,
        causeClass: loaded.causeClass
      })
    }
    const { binding } = loaded
    let handle: WinPipeHandle
    try {
      handle = binding.listen(name, (error, fd) => {
        if (fd < 0) return handlers.onError(`WIN32_${error}`)
        let socket: Socket
        try {
          socket = socketFromFd(fd)
        } catch {
          closeFd(fd)
          return handlers.onError(HANDOFF_FAILED)
        }
        handlers.onConnection(socket)
      })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return Promise.resolve({
        ok: false,
        code:
          code === NAME_IN_USE_CODE ? PIPE_NAME_IN_USE : typeof code === 'string' ? code : 'unknown'
      })
    }
    let closed = false
    return Promise.resolve({
      ok: true,
      server: {
        close: () => {
          if (!closed) {
            closed = true
            binding.close(handle)
          }
          return Promise.resolve()
        }
      }
    })
  }
}

/**
 * Where the binary is, from the app root (`out/host/main.js`'s grandparent): `prebuilds/` in a
 * development tree; in a packaged app the root is `app.asar`, and the binary sits unpacked beside
 * it (package.json `build.asarUnpack`), so it is loaded from the real file, never from the archive.
 */
export function winPipePrebuildsDir(appRoot: string): string {
  return basename(appRoot) === 'app.asar'
    ? join(dirname(appRoot), 'app.asar.unpacked', 'prebuilds')
    : join(appRoot, 'prebuilds')
}

function loadBinding(path: string, load: (path: string) => WinPipeBinding): Loaded {
  if (!existsSync(path)) return { ok: false, causeClass: 'binary-missing' }
  let binding: WinPipeBinding
  try {
    binding = load(path)
  } catch {
    return { ok: false, causeClass: 'load-failed' }
  }
  if (typeof binding.listen !== 'function' || typeof binding.close !== 'function') {
    return { ok: false, causeClass: 'load-failed' }
  }
  return { ok: true, binding }
}

function dlopen(path: string): WinPipeBinding {
  const module = { exports: {} as WinPipeBinding }
  process.dlopen(module, path)
  return module.exports
}
