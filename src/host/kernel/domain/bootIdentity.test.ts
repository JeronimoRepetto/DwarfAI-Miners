import { describe, expect, it } from 'vitest'
import {
  BOOT_TIME_TOLERANCE_MS,
  decidePreviousEpochEnd,
  type BootIdentity,
  type PreviousEpoch
} from './bootIdentity'

// L1 (17 §1.1): the ADR-015 item 4 "Reboot detection" table, one row per rule (09 §8.4 step 2).

const STARTED_AT = 1_790_000_000_000
const OPTIONS = { toleranceMs: BOOT_TIME_TOLERANCE_MS }

const BOOT: BootIdentity = {
  bootId: '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f',
  bootTimeMs: STARTED_AT - 3_600_000,
  logonSessionId: '0x3e7a1'
}

function previous(overrides: Partial<PreviousEpoch> = {}): PreviousEpoch {
  return {
    epoch: '01900000-0000-7000-8000-000000000001',
    startedAt: STARTED_AT,
    bootIdentity: BOOT,
    marker: null,
    ...overrides
  }
}

describe('decidePreviousEpochEnd (ADR-015 item 4)', () => {
  it('[ADR-015, FM-110] two readable different bootIds decide rebooted by rule boot-id', () => {
    const current: BootIdentity = { ...BOOT, bootId: '0b4e7a52-9d1c-4f3e-8a2b-1c2d3e4f5a6b' }

    expect(decidePreviousEpochEnd(previous(), current, OPTIONS)).toEqual({
      kind: 'rebooted',
      rule: 'boot-id'
    })
  })

  it('[ADR-015, FM-110] same bootId, two readable different logonSessionIds decide logged-out', () => {
    const current: BootIdentity = { ...BOOT, logonSessionId: '0x51c20' }

    expect(decidePreviousEpochEnd(previous(), current, OPTIONS)).toEqual({
      kind: 'logged-out',
      rule: 'logon-session'
    })
  })

  it('[ADR-015, FM-110] an unreadable bootId with the OS boot time more than 60 s after the previous epoch start decides rebooted by rule boot-time; 60 000 ms exactly does not', () => {
    expect(BOOT_TIME_TOLERANCE_MS).toBe(60_000)
    const rows: ReadonlyArray<{
      side: 'previous' | 'current'
      afterStartMs: number
      kind: string
    }> = [
      { side: 'current', afterStartMs: 60_001, kind: 'rebooted' },
      { side: 'previous', afterStartMs: 60_001, kind: 'rebooted' },
      { side: 'current', afterStartMs: 60_000, kind: 'crashed' },
      { side: 'previous', afterStartMs: 60_000, kind: 'crashed' },
      { side: 'current', afterStartMs: -5_000, kind: 'crashed' }
    ]
    for (const { side, afterStartMs, kind } of rows) {
      const bootTimeMs = STARTED_AT + afterStartMs
      const before = previous(
        side === 'previous' ? { bootIdentity: { ...BOOT, bootId: 'unknown' } } : {}
      )
      const current: BootIdentity =
        side === 'current' ? { ...BOOT, bootId: 'unknown', bootTimeMs } : { ...BOOT, bootTimeMs }

      const decided = decidePreviousEpochEnd(before, current, OPTIONS)

      expect({ side, afterStartMs, decided }).toEqual({
        side,
        afterStartMs,
        decided:
          kind === 'rebooted' ? { kind, rule: 'boot-time' } : { kind: 'crashed', rule: 'none' }
      })
    }
  })

  it('[ADR-015, FM-001] the same readable boot identity and no marker decide crashed', () => {
    expect(decidePreviousEpochEnd(previous(), { ...BOOT }, OPTIONS)).toEqual({
      kind: 'crashed',
      rule: 'none'
    })
  })

  it('[ADR-015] unknown never compares equal: two unknown bootIds fall through to the next rule', () => {
    const before = previous({ bootIdentity: { ...BOOT, bootId: 'unknown' } })
    const current: BootIdentity = { ...BOOT, bootId: 'unknown', logonSessionId: '0x51c20' }

    // Rule 1 does not match (neither side is readable), so rule 2 decides.
    expect(decidePreviousEpochEnd(before, current, OPTIONS)).toEqual({
      kind: 'logged-out',
      rule: 'logon-session'
    })
    // Two unknown logon sessions fall through as well; rule 3 then reads the boot time.
    const bothUnknown = previous({
      bootIdentity: { ...BOOT, bootId: 'unknown', logonSessionId: 'unknown' }
    })
    expect(
      decidePreviousEpochEnd(
        bothUnknown,
        { bootId: 'unknown', bootTimeMs: STARTED_AT + 120_000, logonSessionId: 'unknown' },
        OPTIONS
      )
    ).toEqual({ kind: 'rebooted', rule: 'boot-time' })
  })

  it('[ADR-015] a marker of the previous epoch decides clean with its reason', () => {
    for (const reason of ['stop-all', 'upgrade'] as const) {
      expect(
        decidePreviousEpochEnd(
          previous({ marker: { reason, at: STARTED_AT + 1_000 } }),
          { ...BOOT },
          OPTIONS
        )
      ).toEqual({ kind: 'clean', rule: 'none', cleanReason: reason })
    }
    // A marker os-session-end is itself the evidence of the "ended while the app was closed" row
    // (ADR-015 item 4), logged with that rule as its class (19 §9.1).
    expect(
      decidePreviousEpochEnd(
        previous({ marker: { reason: 'os-session-end', at: STARTED_AT + 1_000 } }),
        { ...BOOT },
        OPTIONS
      )
    ).toEqual({ kind: 'clean', rule: 'os-session-end', cleanReason: 'os-session-end' })
  })

  it('[ADR-015, FM-110] a reboot after a clean exit decides rebooted: the reboot evidence takes precedence over the marker', () => {
    const current: BootIdentity = { ...BOOT, bootId: '0b4e7a52-9d1c-4f3e-8a2b-1c2d3e4f5a6b' }

    expect(
      decidePreviousEpochEnd(
        previous({ marker: { reason: 'upgrade', at: STARTED_AT + 1_000 } }),
        current,
        OPTIONS
      )
    ).toEqual({ kind: 'rebooted', rule: 'boot-id' })
  })

  it('[ADR-015, FM-110] when neither bootId nor the OS boot time can be read the boot counts as a crash, marked degraded', () => {
    const unreadable: BootIdentity = {
      bootId: 'unknown',
      bootTimeMs: 'unknown',
      logonSessionId: 'unknown'
    }

    expect(decidePreviousEpochEnd(previous(), unreadable, OPTIONS)).toEqual({
      kind: 'crashed',
      rule: 'none',
      degraded: true
    })
    expect(
      decidePreviousEpochEnd(
        previous({ marker: { reason: 'stop-all', at: STARTED_AT + 1_000 } }),
        unreadable,
        OPTIONS
      )
    ).toEqual({ kind: 'clean', rule: 'none', cleanReason: 'stop-all', degraded: true })
  })
})
