import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeProcessInJob, type WinJobBinding } from './nativeProcessInJob'
import { WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'

// L2 (17 §1.2): the loader of the Host's native in-job read (13 FM-012, S12.04; ISSUE-056), with a fake binding, on
// every OS. The real binding (win_pipe.c `isProcessInJob`) is the Windows OS lane's (nativeProcessInJob.os.test.ts).
// A read never throws: an answer that cannot be read is a ReadOutcome failure with its cause (probe/types.ts), which
// the boot turns into `in-job` (wiring/boot.ts jobStatusOf), never a guessed value.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A prebuilds folder holding a binary file for x64 (its bytes are never read by the fake). */
function prebuilds(withBinary = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dw056j-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (withBinary) {
    mkdirSync(join(dir, 'win32-x64'))
    writeFileSync(join(dir, 'win32-x64', WIN_PIPE_BINARY), '')
  }
  return dir
}

describe('createNativeProcessInJob (FM-012)', () => {
  it("[FM-012, S12.04] answers the binary's IsProcessInJob of this process", () => {
    for (const value of [true, false]) {
      const read = createNativeProcessInJob({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({ isProcessInJob: () => value })
      })
      expect(read()).toEqual({ ok: true, value })
    }
  })

  it('[FM-012] a missing or unloadable binary, one without the export, or a failed read is reported with its cause', () => {
    expect(createNativeProcessInJob({ prebuildsDir: prebuilds(false), arch: 'x64' })()).toEqual({
      ok: false,
      cause: 'binary-missing'
    })
    const throwing = (): WinJobBinding => {
      throw new Error('not a valid Win32 application')
    }
    expect(
      createNativeProcessInJob({ prebuildsDir: prebuilds(), arch: 'x64', load: throwing })()
    ).toEqual({
      ok: false,
      cause: 'load-failed'
    })
    expect(
      createNativeProcessInJob({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({}) as unknown as WinJobBinding
      })()
    ).toEqual({ ok: false, cause: 'load-failed' })
    expect(
      createNativeProcessInJob({
        prebuildsDir: prebuilds(),
        arch: 'x64',
        load: () => ({
          isProcessInJob: () => {
            throw Object.assign(new Error('IsProcessInJob could not be read'), { code: 'WIN32_5' })
          }
        })
      })()
    ).toEqual({ ok: false, cause: 'WIN32_5' })
  })
})
