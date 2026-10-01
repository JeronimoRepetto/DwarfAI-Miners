import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeWinLaunch } from '../fakes/FakeWinLaunch'
import { WIN_LAUNCH_BINARY, loadWinLaunch, winLaunchPrebuildsDir } from './nativeWinLaunch'

// L2 (17 §1.2): the loader of the launch helper, with a fake binding, on every OS. The real binding
// (win_launch.c) is the Windows OS lane's (nativeWinLaunch.os.test.ts).

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A prebuilds folder holding a binary file for `arch` (its bytes are never read by the fake). */
function prebuilds(arch: string, withBinary = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dw-winlaunch-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (withBinary) {
    mkdirSync(join(dir, `win32-${arch}`))
    writeFileSync(join(dir, `win32-${arch}`, WIN_LAUNCH_BINARY), '')
  }
  return dir
}

describe('the launch helper loader (ADR-002 D6)', () => {
  it('[ADR-002] the helper is loaded from prebuilds/win32-<arch>/; a missing or broken binary is a named failure, never a fallback', () => {
    const helper = new FakeWinLaunch()
    const dir = prebuilds('arm64')
    const loadedFrom: string[] = []
    const loaded = loadWinLaunch({
      prebuildsDir: dir,
      arch: 'arm64',
      load: (path) => {
        loadedFrom.push(path)
        return helper.binding
      }
    })
    expect(loaded).toEqual({ ok: true, binding: helper.binding })
    expect(loadedFrom).toEqual([join(dir, 'win32-arm64', WIN_LAUNCH_BINARY)])

    expect(
      loadWinLaunch({
        prebuildsDir: prebuilds('x64', false),
        arch: 'x64',
        load: () => helper.binding
      })
    ).toEqual({ ok: false, errCode: 'LAUNCHER_HELPER_MISSING' })
    expect(
      loadWinLaunch({
        prebuildsDir: prebuilds('x64'),
        arch: 'x64',
        load: () => {
          throw new Error('not a valid Win32 application')
        }
      })
    ).toEqual({ ok: false, errCode: 'LAUNCHER_HELPER_LOAD_FAILED' })
    // A binary that loads but is not this helper (an older or a foreign one).
    expect(
      loadWinLaunch({
        prebuildsDir: prebuilds('x64'),
        arch: 'x64',
        load: () => ({ breakaway: () => ({ status: 'failed', code: 'X' }) }) as never
      })
    ).toEqual({ ok: false, errCode: 'LAUNCHER_HELPER_LOAD_FAILED' })
  })

  it('[ADR-002] the binary is looked up at the app root: prebuilds/ in a development tree, app.asar.unpacked/prebuilds/ when packaged', () => {
    expect(winLaunchPrebuildsDir(join('repo'))).toBe(join('repo', 'prebuilds'))
    expect(
      winLaunchPrebuildsDir(join('C:', 'Program Files', 'DwarfAI', 'resources', 'app.asar'))
    ).toBe(join('C:', 'Program Files', 'DwarfAI', 'resources', 'app.asar.unpacked', 'prebuilds'))
  })
})
