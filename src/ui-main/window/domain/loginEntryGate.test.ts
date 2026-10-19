// layer: L1
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_ENTRY_PASSED, loginEntryOffered, type LoginEntryPlatform } from './loginEntryGate'

/** The spike record S-027-4 writes when it has run (17 §4 "Gate"); the repository root is vitest's working folder. */
const RECORD = join(process.cwd(), 'spike-results', 'S-027-4.md')
const OS_NAMES: Readonly<Record<LoginEntryPlatform, RegExp>> = {
  win32: /windows/i,
  darwin: /macos/i,
  linux: /linux/i
}

describe('the S-027-4 gate of the rebuilt login entry', () => {
  it('[S-027-4] the rebuilt login entry is offered on an OS only once the S-027-4 record says it passed there', () => {
    const platforms = Object.keys(LOGIN_ENTRY_PASSED) as LoginEntryPlatform[]
    expect(platforms.sort()).toEqual(['darwin', 'linux', 'win32'])
    if (!existsSync(RECORD)) {
      // No record yet: the candidate autostart stays on every OS until v1 (21 §2 cut 1) and nothing is offered.
      for (const platform of platforms) expect(loginEntryOffered(platform), platform).toBe(false)
      return
    }
    // With the record, an OS is offered only when the record names it as passed.
    const record = readFileSync(RECORD, 'utf8')
    for (const platform of platforms.filter(loginEntryOffered)) {
      const passed = record
        .split('\n')
        .some((line) => OS_NAMES[platform].test(line) && /\bpass(ed)?\b/i.test(line))
      expect(passed, `${platform} offered without a passed S-027-4 line`).toBe(true)
    }
  })
})
