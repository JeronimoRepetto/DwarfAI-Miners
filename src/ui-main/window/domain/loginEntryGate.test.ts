// layer: L1
import { describe, expect, it } from 'vitest'
import { LOGIN_ENTRY_PASSED, loginEntryOffered, type LoginEntryPlatform } from './loginEntryGate'

describe('the S-027-4 gate of the rebuilt login entry', () => {
  it('[S-027-4] the rebuilt login entry is offered on an OS only once S-027-4 passed there, and it has passed on none', () => {
    const platforms = Object.keys(LOGIN_ENTRY_PASSED) as LoginEntryPlatform[]
    expect(platforms.sort()).toEqual(['darwin', 'linux', 'win32'])
    // The candidate autostart stays on every OS until v1 (21 §2 cut 1) and nothing is offered. An entry turns
    // `true` in the same change that proves the spike passed on that OS, and that change updates this expectation.
    for (const platform of platforms) expect(loginEntryOffered(platform), platform).toBe(false)
  })
})
