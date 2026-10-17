// L1: the per-view tokens of ADR-003 item 12 — 32 bytes, one dwarf, single use, 60 s.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../../kernel/domain/values'
import { VIEW_TOKEN_BYTES, VIEW_TOKEN_TTL_MS, ViewTokenRegistry } from './ViewTokenRegistry'

const DWARF_A = '01920000-0000-7000-9000-0000000000a1' as DwarfId
const DWARF_B = '01920000-0000-7000-9000-0000000000b1' as DwarfId

function registry(clock = new FakeClock(1_000)): ViewTokenRegistry {
  return new ViewTokenRegistry({ clock, ids: new SequenceIdGenerator() })
}

describe('ViewTokenRegistry', () => {
  it('[ADR-003] a token is 32 random bytes in hex, and each view gets its own id and token', () => {
    const tokens = registry()
    const first = tokens.issue(DWARF_A)
    const second = tokens.issue(DWARF_A)

    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(first.token.length).toBe(VIEW_TOKEN_BYTES * 2)
    expect(second.viewId).not.toBe(first.viewId)
    expect(second.token).not.toBe(first.token)
  })

  it('[ADR-003] the token binds the hello to its one dwarf', () => {
    const tokens = registry()
    const a = tokens.issue(DWARF_A)
    const b = tokens.issue(DWARF_B)

    expect(tokens.consume(b.viewId, b.token)).toBe(DWARF_B)
    expect(tokens.consume(a.viewId, a.token)).toBe(DWARF_A)
  })

  it('[FM-040, ADR-003] a token used twice is refused the second time', () => {
    const tokens = registry()
    const view = tokens.issue(DWARF_A)

    expect(tokens.consume(view.viewId, view.token)).toBe(DWARF_A)
    expect(tokens.consume(view.viewId, view.token)).toBeNull()
  })

  it('[ADR-003] a wrong token consumes the view, so the right one is refused after it', () => {
    const tokens = registry()
    const view = tokens.issue(DWARF_A)

    expect(tokens.consume(view.viewId, '0'.repeat(64))).toBeNull()
    expect(tokens.consume(view.viewId, view.token)).toBeNull()
  })

  it('[ADR-003] another view id or a token of another view is refused', () => {
    const tokens = registry()
    const a = tokens.issue(DWARF_A)
    const b = tokens.issue(DWARF_B)

    expect(tokens.consume('00000000-0000-7000-8000-00000000ffff', a.token)).toBeNull()
    expect(tokens.consume(a.viewId, b.token)).toBeNull()
  })

  it('[FM-040, ADR-003] a token is valid for 60 s after issue and refused one millisecond later', () => {
    const clock = new FakeClock(1_000)
    const tokens = registry(clock)
    const onTime = tokens.issue(DWARF_A)
    const late = tokens.issue(DWARF_A)

    clock.advance(VIEW_TOKEN_TTL_MS)
    expect(tokens.consume(onTime.viewId, onTime.token)).toBe(DWARF_A)
    clock.advance(1)
    expect(tokens.consume(late.viewId, late.token)).toBeNull()
  })

  it('[ADR-003] dropExpired forgets the tokens past 60 s and names their views', () => {
    const clock = new FakeClock(1_000)
    const tokens = registry(clock)
    const old = tokens.issue(DWARF_A)
    clock.advance(VIEW_TOKEN_TTL_MS)
    const fresh = tokens.issue(DWARF_A)
    clock.advance(1)

    expect(tokens.dropExpired()).toEqual([old.viewId])
    expect(tokens.consume(fresh.viewId, fresh.token)).toBe(DWARF_A)
  })
})
