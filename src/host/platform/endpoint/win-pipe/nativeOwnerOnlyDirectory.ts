// The owner-only Host data directory on Windows: the adapter around `protectDirectory` of the
// native module win_pipe.c (the same binary as the owner-only pipe, nativeOwnerOnlyPipe.ts).
//
// Owner-approved amendment (2026-10-01, ISSUE-041): protected owner-only DACL on the Windows data
// directory (SP-05 run\ row), replacing 09 §9's inherited profile ACL.
//
// `protectDirectory(path)` gives the directory the protected DACL
// `D:P(A;OICI;FA;;;<user SID>)(A;OICI;FA;;;SY)` (the SID is the Host process's own user), which
// files and folders inherit, and propagates it to what the directory already holds. A directory
// that already has exactly that protected DACL is left alone (`unchanged`); otherwise it is
// `repaired`. Nothing is started per boot: no PowerShell, no other process.
//
// - The binary is loaded on the first call only (Windows only; macOS and Linux never call it).
// - Fail closed: a binary that is missing, does not load or has no `protectDirectory` throws
//   DATA_DIR_ACL_UNAVAILABLE, and a Win32 failure throws its `WIN32_<n>` code, so the boot step
//   fails instead of opening the data with the ACL the profile tree would pass down.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dlopenWinPipe, WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'

/** The code of a data directory whose owner-only DACL cannot be applied at all. */
export const DATA_DIR_ACL_UNAVAILABLE = 'DATA_DIR_ACL_UNAVAILABLE'

/** The part of win_pipe.c's surface this adapter uses. */
export interface WinDirectoryBinding {
  /** True when the DACL was applied, false when it was already in place; throws `WIN32_<n>`. */
  protectDirectory(path: string): boolean
}

/** Applies the protected owner-only DACL to a directory; throws when it cannot. */
export type OwnerOnlyDirectory = (path: string) => 'repaired' | 'unchanged'

export interface NativeOwnerOnlyDirectoryOptions {
  /** The folder holding `win32-<arch>/dwarfai_win_pipe.node`: `prebuilds/` at the app root. */
  prebuildsDir: string
  /** The architecture whose binary is loaded; default this process's. */
  arch?: string
  /** Loads the binary; default `process.dlopen`. */
  load?: (path: string) => WinDirectoryBinding
}

/** Why the data directory could not be protected; `code` is what the boot step logs. */
export class OwnerOnlyDirectoryUnavailableError extends Error {
  readonly code = DATA_DIR_ACL_UNAVAILABLE
  constructor(readonly causeClass: 'binary-missing' | 'load-failed') {
    super(`the owner-only data directory helper is unavailable: ${causeClass}`)
    this.name = 'OwnerOnlyDirectoryUnavailableError'
  }
}

export function createNativeOwnerOnlyDirectory(
  options: NativeOwnerOnlyDirectoryOptions
): OwnerOnlyDirectory {
  const path = join(options.prebuildsDir, `win32-${options.arch ?? process.arch}`, WIN_PIPE_BINARY)
  const load = options.load ?? dlopenWinPipe<WinDirectoryBinding>
  let binding: WinDirectoryBinding | undefined
  return (directory) => {
    binding ??= loadBinding(path, load)
    return binding.protectDirectory(directory) ? 'repaired' : 'unchanged'
  }
}

function loadBinding(
  path: string,
  load: (path: string) => WinDirectoryBinding
): WinDirectoryBinding {
  if (!existsSync(path)) throw new OwnerOnlyDirectoryUnavailableError('binary-missing')
  let binding: WinDirectoryBinding
  try {
    binding = load(path)
  } catch {
    throw new OwnerOnlyDirectoryUnavailableError('load-failed')
  }
  if (typeof binding.protectDirectory !== 'function') {
    throw new OwnerOnlyDirectoryUnavailableError('load-failed')
  }
  return binding
}
