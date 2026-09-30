import { describe, expect, it } from 'vitest'
import { UuidV7Generator } from './UuidV7Generator'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 48-bit Unix millisecond timestamp at the front of a UUIDv7 (RFC 9562 §5.7). */
function timestampOf(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

describe('UuidV7Generator', () => {
  it('[ADR-005] uuidv7 returns 36-character version-7 ids that sort by creation order', () => {
    const start = Date.UTC(2026, 8, 30, 12, 0, 0)
    let now = start
    const generator = new UuidV7Generator({ clock: { now: () => now } })
    const ids: string[] = []
    // More ids inside one millisecond than the 12-bit counter holds, then a later millisecond,
    // then a clock that stepped back: creation order must stay sort order throughout.
    for (let i = 0; i < 5_000; i += 1) ids.push(generator.uuidv7())
    now += 1
    for (let i = 0; i < 10; i += 1) ids.push(generator.uuidv7())
    now -= 1_000
    for (let i = 0; i < 10; i += 1) ids.push(generator.uuidv7())

    for (const id of ids) {
      expect(id).toHaveLength(36)
      expect(id).toMatch(UUID_V7)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
    expect(timestampOf(ids[0] ?? '')).toBe(start)
  })
})
