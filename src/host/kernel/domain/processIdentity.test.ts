import { describe, expect, it } from 'vitest'
import { PROCESS_START_TOLERANCE_MS, sameProcess, type ProcessIdentity } from './processIdentity'

const RECORDED: ProcessIdentity = {
  pid: 4242,
  processStartTimeMs: 1_790_000_000_000,
  bootId: '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f'
}

const shifted = (deltaMs: number): ProcessIdentity => ({
  ...RECORDED,
  processStartTimeMs: RECORDED.processStartTimeMs + deltaMs
})

describe('sameProcess (ADR-015 item 1)', () => {
  it('[INV-51] identities 1 999 ms apart with the same pid and bootId are the same process; 2 001 ms apart are not', () => {
    expect(PROCESS_START_TOLERANCE_MS).toBe(2_000)
    const rows: ReadonlyArray<{ deltaMs: number; same: boolean }> = [
      { deltaMs: 0, same: true },
      { deltaMs: 1_999, same: true },
      { deltaMs: -1_999, same: true },
      { deltaMs: 2_000, same: true },
      { deltaMs: -2_000, same: true },
      { deltaMs: 2_001, same: false },
      { deltaMs: -2_001, same: false }
    ]
    for (const { deltaMs, same } of rows) {
      expect({ deltaMs, same: sameProcess(RECORDED, shifted(deltaMs)) }).toEqual({ deltaMs, same })
      expect({ deltaMs, same: sameProcess(shifted(deltaMs), RECORDED) }).toEqual({ deltaMs, same })
    }
  })

  it('[INV-51] a different bootId or pid is never the same process', () => {
    expect(sameProcess(RECORDED, { ...RECORDED, bootId: 'another-boot' })).toBe(false)
    expect(sameProcess(RECORDED, { ...RECORDED, pid: RECORDED.pid + 1 })).toBe(false)
    expect(sameProcess(RECORDED, { ...RECORDED, pid: RECORDED.pid + 1, bootId: 'x' })).toBe(false)
    // An unreadable start time is never smuggled in as a number.
    expect(sameProcess(RECORDED, { ...RECORDED, processStartTimeMs: Number.NaN })).toBe(false)
    expect(sameProcess({ ...RECORDED, processStartTimeMs: Number.NaN }, RECORDED)).toBe(false)
  })
})
