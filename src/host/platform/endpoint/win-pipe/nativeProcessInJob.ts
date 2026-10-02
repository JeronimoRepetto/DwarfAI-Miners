// The Host's own in-job read on Windows (13 FM-012, S12.04 "IsProcessInJob at boot"; ISSUE-056): the adapter around
// `isProcessInJob` of the native module win_pipe.c (the same binary as the owner-only pipe, nativeOwnerOnlyPipe.ts).
//
// The composition root reads it once, before the Host spawns anything. libuv adds the process itself to a job of its
// own at its first non-detached spawn (libuv 1.51.0 src/win/process.c:109, AssignProcessToJobObject(own job,
// GetCurrentProcess())), so any later read answers true on every Windows Host; the PowerShell read this replaces was
// itself such a spawn. Nothing is started for the read: no PowerShell, no other process.
//
// A read never throws (privilege.ts gathers facts, the boot decides): a binary that is missing, does not load or has no
// `isProcessInJob` answers its cause (`binary-missing`, `load-failed`), and a Win32 failure its `WIN32_<n>` code, as a
// ReadOutcome failure (process/probe/types.ts). The boot reports such an answer as `in-job` (wiring/boot.ts
// jobStatusOf), never a guessed value. The binary is loaded on the first read only (Windows only).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ReadOutcome } from '../../process/probe/types'
import { dlopenWinPipe, WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'

/** The part of win_pipe.c's surface this adapter uses. */
export interface WinJobBinding {
  /** IsProcessInJob(GetCurrentProcess(), NULL); throws `WIN32_<n>` when it cannot be read. */
  isProcessInJob(): boolean
}

export interface NativeProcessInJobOptions {
  /** The folder holding `win32-<arch>/dwarfai_win_pipe.node`: `prebuilds/` at the app root. */
  prebuildsDir: string
  /** The architecture whose binary is loaded; default this process's. */
  arch?: string
  /** Loads the binary; default `process.dlopen`. */
  load?: (path: string) => WinJobBinding
}

/** Reads whether this process is in any job object now. */
export function createNativeProcessInJob(
  options: NativeProcessInJobOptions
): () => ReadOutcome<boolean> {
  const path = join(options.prebuildsDir, `win32-${options.arch ?? process.arch}`, WIN_PIPE_BINARY)
  const load = options.load ?? dlopenWinPipe<WinJobBinding>
  return () => {
    if (!existsSync(path)) return { ok: false, cause: 'binary-missing' }
    let binding: WinJobBinding
    try {
      binding = load(path)
    } catch {
      return { ok: false, cause: 'load-failed' }
    }
    if (typeof binding.isProcessInJob !== 'function') return { ok: false, cause: 'load-failed' }
    try {
      return { ok: true, value: binding.isProcessInJob() }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return { ok: false, cause: typeof code === 'string' ? code : 'read-failed' }
    }
  }
}
