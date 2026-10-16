// This process's user SID on Windows, read natively (owner-approved 2026-10-15, ISSUE-200): the
// adapter around `currentUserSid` of the native module win_pipe.c (the same binary as the owner-only
// pipe, nativeOwnerOnlyPipe.ts). The MCP relay names the Host's MCP endpoint with it (ADR-013 item 3:
// `\\.\pipe\dwarfai-mcp-<sha256(userSid)[0..16]>-<profileKey>`) and starts no process for the read:
// no `whoami`, no `node:child_process` in the relay.
//
// The SID is the token user's, as `ConvertSidToStringSidW` writes it, which is what `whoami /user`
// prints, so the relay and the Host (nodeEndpointEnv.ts) name the same endpoint.
//
// A read never throws: a binary that is missing, does not load or has no `currentUserSid` answers
// its cause (`binary-missing`, `load-failed`), a Win32 failure its `WIN32_<n>` code, and an answer
// that is not a SID is unparseable, as a ReadOutcome failure (process/probe/types.ts). The binary is
// loaded on the first read only (Windows only).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UNPARSEABLE, type ReadOutcome } from '../../process/probe/types'
import { dlopenWinPipe, WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'

/** The part of win_pipe.c's surface this adapter uses. */
export interface WinUserSidBinding {
  /** This process's token user SID, string form; throws `WIN32_<n>` when it cannot be read. */
  currentUserSid(): string
}

export interface NativeUserSidOptions {
  /** The folder holding `win32-<arch>/dwarfai_win_pipe.node`: `prebuilds/` at the app root. */
  prebuildsDir: string
  /** The architecture whose binary is loaded; default this process's. */
  arch?: string
  /** Loads the binary; default `process.dlopen`. */
  load?: (path: string) => WinUserSidBinding
}

const SID = /^S-1-\d+(?:-\d+)+$/

/** Reads this process's user SID. */
export function createNativeUserSid(options: NativeUserSidOptions): () => ReadOutcome<string> {
  const path = join(options.prebuildsDir, `win32-${options.arch ?? process.arch}`, WIN_PIPE_BINARY)
  const load = options.load ?? dlopenWinPipe<WinUserSidBinding>
  return () => {
    if (!existsSync(path)) return { ok: false, cause: 'binary-missing' }
    let binding: WinUserSidBinding
    try {
      binding = load(path)
    } catch {
      return { ok: false, cause: 'load-failed' }
    }
    if (typeof binding.currentUserSid !== 'function') return { ok: false, cause: 'load-failed' }
    let sid: unknown
    try {
      sid = binding.currentUserSid()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return { ok: false, cause: typeof code === 'string' ? code : 'read-failed' }
    }
    return typeof sid === 'string' && SID.test(sid) ? { ok: true, value: sid } : UNPARSEABLE
  }
}
