// layer: L1
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TRAY_NOTIFICATIONS_PASSED,
  drawsWithoutWindow,
  type TrayNotificationPlatform
} from './trayNotificationGate'

/** The spike record S-018-1 writes when it has run (17 §4 "Gate"); the repository root is vitest's working folder. */
const RECORD = join(process.cwd(), 'spike-results', 'S-018-1.md')
const OS_NAMES: Readonly<Record<TrayNotificationPlatform, RegExp>> = {
  win32: /windows/i,
  darwin: /macos/i,
  linux: /linux/i
}

describe('the S-018-1 gate of level-3 notifications with no window open', () => {
  it('[S-018-1] the windowless tray process draws on an OS only once the S-018-1 record says it passed there', () => {
    const platforms = Object.keys(TRAY_NOTIFICATIONS_PASSED) as TrayNotificationPlatform[]
    expect(platforms.sort()).toEqual(['darwin', 'linux', 'win32'])
    if (!existsSync(RECORD)) {
      // No record yet: the documented fallback on every OS, window-only (21 §9 cut 1 entry; R-16 lists it).
      for (const platform of platforms) expect(drawsWithoutWindow(platform), platform).toBe(false)
      return
    }
    // With the record, an OS draws with no window only when the record names it as passed.
    const record = readFileSync(RECORD, 'utf8')
    for (const platform of platforms.filter(drawsWithoutWindow)) {
      const passed = record
        .split('\n')
        .some((line) => OS_NAMES[platform].test(line) && /\bpass(ed)?\b/i.test(line))
      expect(passed, `${platform} draws with no window without a passed S-018-1 line`).toBe(true)
    }
  })
})
