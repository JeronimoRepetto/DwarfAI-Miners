import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OS-lane smoke test, L8 (testing strategy `17` §1.8, §1.13; NFR-PLAT-01).
 *
 * One trivial test per platform, so the OS lane of each CI leg is never empty before EPIC-02
 * adds the real ones. Each block runs only on its own platform; the other two are reported as
 * skipped, which the empty-lane guard (`scripts/checks/os-lane-guard.mjs`) never counts as
 * executed. A mistyped platform name therefore empties that leg's lane and fails its job.
 */

/** The real OS reports the platform the leg runs on, and a real temp directory round-trips. */
function expectRunningOn(expected: NodeJS.Platform): void {
  expect(platform()).toBe(expected)
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-os-lane-'))
  try {
    expect(statSync(dir).isDirectory()).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.runIf(process.platform === 'win32')('OS lane on Windows', () => {
  it('[NFR-PLAT-01] the OS lane runs on this platform', () => {
    expectRunningOn('win32')
  })
})

describe.runIf(process.platform === 'darwin')('OS lane on macOS', () => {
  it('[NFR-PLAT-01] the OS lane runs on this platform', () => {
    expectRunningOn('darwin')
  })
})

describe.runIf(process.platform === 'linux')('OS lane on Linux', () => {
  it('[NFR-PLAT-01] the OS lane runs on this platform', () => {
    expectRunningOn('linux')
  })
})
