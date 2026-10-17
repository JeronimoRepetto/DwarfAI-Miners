import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'
import { createNativeUserSid, type WinUserSidBinding } from './nativeUserSid'

// L2 (17 §1.2): the loader of this process's user SID read (ADR-013 item 3, the MCP endpoint's
// `sha256(userSid)` part; owner-approved 2026-10-15, ISSUE-200), with a fake binding, on every OS.
// The real binding (win_pipe.c `currentUserSid`) is the Windows OS lane's (nativeUserSid.os.test.ts).
// A read never throws: an answer that cannot be read is a ReadOutcome failure with its cause.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A prebuilds folder holding a binary file for x64 (its bytes are never read by the fake). */
function prebuilds(withBinary = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dw200s-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (withBinary) {
    mkdirSync(join(dir, 'win32-x64'))
    writeFileSync(join(dir, 'win32-x64', WIN_PIPE_BINARY), '')
  }
  return dir
}

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'

describe('createNativeUserSid (ADR-013)', () => {
  it("[ADR-013] answers the binary's user SID of this process", () => {
    const read = createNativeUserSid({
      prebuildsDir: prebuilds(),
      arch: 'x64',
      load: () => ({ currentUserSid: () => SID })
    })
    expect(read()).toEqual({ ok: true, value: SID })
  })

  it('[ADR-013] a missing or unloadable binary, one without the export, a failed or malformed read is reported with its cause', () => {
    expect(createNativeUserSid({ prebuildsDir: prebuilds(false), arch: 'x64' })()).toEqual({
      ok: false,
      cause: 'binary-missing'
    })
    const throwing = (): WinUserSidBinding => {
      throw new Error('not a valid Win32 application')
    }
    expect(
      createNativeUserSid({ prebuildsDir: prebuilds(), arch: 'x64', load: throwing })()
    ).toEqual({ ok: false, cause: 'load-failed' })
    expect(
      createNativeUserSid({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({}) as unknown as WinUserSidBinding
      })()
    ).toEqual({ ok: false, cause: 'load-failed' })
    expect(
      createNativeUserSid({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({
          currentUserSid: () => {
            throw Object.assign(new Error('the user SID could not be read'), { code: 'WIN32_5' })
          }
        })
      })()
    ).toEqual({ ok: false, cause: 'WIN32_5' })
    expect(
      createNativeUserSid({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({ currentUserSid: () => 'not a sid' })
      })()
    ).toEqual({ ok: false, cause: 'gave an unparseable answer' })
  })
})
