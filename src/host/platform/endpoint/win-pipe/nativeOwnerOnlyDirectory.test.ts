import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createNativeOwnerOnlyDirectory,
  DATA_DIR_ACL_UNAVAILABLE,
  type WinDirectoryBinding
} from './nativeOwnerOnlyDirectory'
import { WIN_PIPE_BINARY } from './nativeOwnerOnlyPipe'

// L2 (17 §1.2): the loader of the native data-directory protection, with a fake binding, on every
// OS. The real binding (win_pipe.c) is the Windows OS lane's (nativeOwnerOnlyDirectory.os.test.ts).
//
// Owner-approved amendment (2026-10-01, ISSUE-041): protected owner-only DACL on the Windows data
// directory (SP-05 run\ row), replacing 09 §9's inherited profile ACL.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A prebuilds folder holding a binary file for `arch` (its bytes are never read by the fake). */
function prebuilds(arch: string, withBinary = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'dw041n-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (withBinary) {
    mkdirSync(join(dir, `win32-${arch}`))
    writeFileSync(join(dir, `win32-${arch}`, WIN_PIPE_BINARY), '')
  }
  return dir
}

const DATA_DIR = join('C:', 'Users', 'j', 'AppData', 'Roaming', 'DwarfAI', 'host')

/** What a thrown error carries as its `code`. */
function codeOf(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return (error as { code?: unknown }).code
  }
  return 'nothing thrown'
}

describe('the native owner-only data directory loader (ISSUE-041 amendment; SP-05 run\\ row)', () => {
  it('[ADR-017] a directory the native side changed is repaired, one it left alone is unchanged', () => {
    const asked: string[] = []
    let changes = true
    const binding: WinDirectoryBinding = {
      protectDirectory: (path) => {
        asked.push(path)
        return changes
      }
    }
    const protect = createNativeOwnerOnlyDirectory({
      prebuildsDir: prebuilds('x64'),
      arch: 'x64',
      load: () => binding
    })

    expect(protect(DATA_DIR)).toBe('repaired')
    changes = false
    expect(protect(DATA_DIR)).toBe('unchanged')
    expect(asked).toEqual([DATA_DIR, DATA_DIR])
  })

  it('[ADR-017] a missing binary fails closed with DATA_DIR_ACL_UNAVAILABLE and never loads', () => {
    let loads = 0
    const protect = createNativeOwnerOnlyDirectory({
      prebuildsDir: prebuilds('x64', false),
      arch: 'x64',
      load: () => {
        loads += 1
        return { protectDirectory: () => true }
      }
    })

    expect(codeOf(() => protect(DATA_DIR))).toBe(DATA_DIR_ACL_UNAVAILABLE)
    expect(loads).toBe(0)
  })

  it('[ADR-017] a binary that fails to load, or lacks protectDirectory, fails closed', () => {
    const failing = createNativeOwnerOnlyDirectory({
      prebuildsDir: prebuilds('x64'),
      arch: 'x64',
      load: () => {
        throw new Error('not a valid Win32 application')
      }
    })
    const older = createNativeOwnerOnlyDirectory({
      prebuildsDir: prebuilds('x64'),
      arch: 'x64',
      load: () => ({}) as WinDirectoryBinding
    })

    expect(codeOf(() => failing(DATA_DIR))).toBe(DATA_DIR_ACL_UNAVAILABLE)
    expect(codeOf(() => older(DATA_DIR))).toBe(DATA_DIR_ACL_UNAVAILABLE)
  })

  it('[ADR-017] a Win32 failure of the native side propagates with its WIN32_<n> code', () => {
    const protect = createNativeOwnerOnlyDirectory({
      prebuildsDir: prebuilds('x64'),
      arch: 'x64',
      load: () => ({
        protectDirectory: () => {
          throw Object.assign(new Error('SetNamedSecurityInfoW failed'), { code: 'WIN32_5' })
        }
      })
    })

    expect(codeOf(() => protect(DATA_DIR))).toBe('WIN32_5')
  })
})
