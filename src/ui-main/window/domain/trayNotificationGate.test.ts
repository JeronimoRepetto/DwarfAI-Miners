// layer: L1
import { describe, expect, it } from 'vitest'
import {
  TRAY_NOTIFICATIONS_PASSED,
  drawsWithoutWindow,
  type TrayNotificationPlatform
} from './trayNotificationGate'

describe('the S-018-1 gate of level-3 notifications with no window open', () => {
  it('[S-018-1] the windowless tray process draws on an OS only once S-018-1 passed there, and it has passed on none', () => {
    const platforms = Object.keys(TRAY_NOTIFICATIONS_PASSED) as TrayNotificationPlatform[]
    expect(platforms.sort()).toEqual(['darwin', 'linux', 'win32'])
    // The documented fallback holds on every OS, window-only (21 §9 cut 1 entry; R-16 lists it). An entry turns
    // `true` in the same change that proves the spike passed on that OS, and that change updates this expectation.
    for (const platform of platforms) expect(drawsWithoutWindow(platform), platform).toBe(false)
  })
})
