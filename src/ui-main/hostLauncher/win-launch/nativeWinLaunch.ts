// The UI's launch helper on Windows (ADR-002 D6 item 1; spike-results/SP-02.md): the loader of the
// native module win_launch.c in this folder, which starts the Host with job breakaway from inside
// UI main, so no PowerShell or compiler process stands between the UI and the Host (windows.ts).
//
// - Only this folder loads the binary (R11 containment, eslint.config.mjs deviation 7). It is the
//   UI's own module, built from this folder's source: the UI never loads the Host's binary
//   (R10: the UI and Host trees share nothing but the local channel and the contracts).
// - It is prebuilt per architecture (CI, `pnpm build:native`) and ships in the app under
//   `prebuilds/win32-<arch>/` (asar-unpacked), next to the Host's pipe helper; nothing is compiled
//   on a person's machine, and the static C runtime means no VC++ redistributable.
// - A binary that is missing, does not load, or lacks this surface is a named failure
//   (LAUNCHER_HELPER_MISSING, LAUNCHER_HELPER_LOAD_FAILED), which fails the spawn: the Host's own
//   pipe helper ships beside it, so an install without one has neither and no fallback would help.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The binary's file name inside `prebuilds/win32-<arch>/`. */
export const WIN_LAUNCH_BINARY = 'dwarfai_win_launch.node'

/** A Host process the helper holds a handle to, opaque to JavaScript. */
export type HostProcessHandle = object

/** What one breakaway attempt did (ADR-002 D6 item 1 with the SP-02 job check). */
export type BreakawayResult =
  /** `process` is null only when the helper ran out of memory wrapping it: the Host runs unwatched. */
  | { status: 'launched'; process: HostProcessHandle | null }
  /** Breakaway refused: `CREATE_5` (ERROR_ACCESS_DENIED) or `STILL_IN_JOB`; WMI follows. */
  | { status: 'refused'; code: string }
  /** The create itself failed (`CREATE_<n>`, `RESUME_<n>`); nothing runs. */
  | { status: 'failed'; code: string }

/** The surface of win_launch.c. */
export interface WinLaunchBinding {
  /**
   * CreateProcessW(`file`, `commandLine`) in `cwd` with the Unicode environment block
   * `environment` and `flags`, which must hold CREATE_SUSPENDED and never DETACHED_PROCESS (a
   * TypeError otherwise). The child is resumed only when IsProcessInJob says it is outside every
   * job; otherwise it is ended and the result is `refused STILL_IN_JOB`.
   */
  breakaway(
    file: string,
    commandLine: string,
    cwd: string,
    environment: string,
    flags: number
  ): BreakawayResult
  /** The process `pid`, opened to wait for it and read its exit code; null when it cannot be. */
  open(pid: number): HostProcessHandle | null
  /**
   * Calls `onExit` once: with the exit code when the process exits within `ms`, or with -1 when it
   * still runs then. The wait never keeps the event loop alive.
   */
  watch(process: HostProcessHandle, ms: number, onExit: (code: number) => void): void
  /** Ends the watch (`onExit` is not called afterwards) and closes the handle; the process runs on. */
  release(process: HostProcessHandle): void
}

export type LoadedWinLaunch =
  { ok: true; binding: WinLaunchBinding } | { ok: false; errCode: string }

export interface LoadWinLaunchOptions {
  /** The folder holding `win32-<arch>/dwarfai_win_launch.node`: `prebuilds/` at the app root. */
  prebuildsDir: string
  /** The architecture whose binary is loaded; default this process's. */
  arch?: string
  /** Loads the binary; default `process.dlopen`. */
  load?: (path: string) => WinLaunchBinding
}

const SURFACE = ['breakaway', 'open', 'watch', 'release'] as const

export function loadWinLaunch(options: LoadWinLaunchOptions): LoadedWinLaunch {
  const path = join(
    options.prebuildsDir,
    `win32-${options.arch ?? process.arch}`,
    WIN_LAUNCH_BINARY
  )
  if (!existsSync(path)) return { ok: false, errCode: 'LAUNCHER_HELPER_MISSING' }
  let binding: WinLaunchBinding
  try {
    binding = (options.load ?? dlopenWinLaunch)(path)
  } catch {
    return { ok: false, errCode: 'LAUNCHER_HELPER_LOAD_FAILED' }
  }
  const surface = binding as unknown as Record<string, unknown>
  if (SURFACE.some((name) => typeof surface[name] !== 'function')) {
    return { ok: false, errCode: 'LAUNCHER_HELPER_LOAD_FAILED' }
  }
  return { ok: true, binding }
}

/**
 * Where the binary is, from the app root: `prebuilds/` in a development tree; in a packaged app
 * the root is `app.asar`, and the binary sits unpacked beside it (package.json
 * `build.asarUnpack`), so it is loaded from the real file, never from the archive.
 */
export function winLaunchPrebuildsDir(appRoot: string): string {
  return basename(appRoot) === 'app.asar'
    ? join(dirname(appRoot), 'app.asar.unpacked', 'prebuilds')
    : join(appRoot, 'prebuilds')
}

/** Loads the native module at `path` into this process (`process.dlopen`). */
function dlopenWinLaunch(path: string): WinLaunchBinding {
  const module = { exports: {} as WinLaunchBinding }
  process.dlopen(module, path)
  return module.exports
}
