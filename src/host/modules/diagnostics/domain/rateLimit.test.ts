import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RATE_LIMIT_WINDOW_MS, RecordFolder, type FoldableRecord } from './rateLimit'

const DWARF_A = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e5f'
const DWARF_B = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e60'

interface Rec extends FoldableRecord {
  level: 'warn'
  msg?: string
}

const failed = (dwarfId: string, msg?: string): Rec => ({
  level: 'warn',
  event: 'driver.error',
  subsystem: 'suppliers',
  causeClass: 'transport-closed',
  dwarfId,
  ...(msg === undefined ? {} : { msg })
})

describe('rate limiting (ADR-026 item 6)', () => {
  it('[ADR-026] identical records within 60 s fold into one with count; a record 60 001 ms later is written again', () => {
    const clock = new FakeClock(1_000_000)
    const folder = new RecordFolder<Rec>()

    expect(folder.offer(failed(DWARF_A), clock.now())).toBe(true)
    clock.advance(1)
    // Identical by (event, subsystem, causeClass, dwarfId): a different msg does not matter.
    expect(folder.offer(failed(DWARF_A, 'second attempt'), clock.now())).toBe(false)
    // Another dwarf is another record.
    expect(folder.offer(failed(DWARF_B), clock.now())).toBe(true)
    clock.advance(RATE_LIMIT_WINDOW_MS - 1) // exactly 60 000 ms after the first: still folded
    expect(folder.offer(failed(DWARF_A), clock.now())).toBe(false)
    expect(folder.expired(clock.now())).toEqual([])

    clock.advance(1) // 60 001 ms after the first
    expect(folder.expired(clock.now())).toEqual([{ ...failed(DWARF_A), count: 2 }])
    expect(folder.expired(clock.now())).toEqual([])
    expect(folder.offer(failed(DWARF_A), clock.now())).toBe(true)
    expect(folder.offer(failed(DWARF_A), clock.now())).toBe(false)
  })
})
