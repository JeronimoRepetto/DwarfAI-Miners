// layer: L1
// L1 (17 §1.1): the install-moment boundary of the coal backfill (09 §5.5; ADR-006 item 8; INV-95).
import { describe, expect, it } from 'vitest'
import { coalStreamKey, isCoal } from './coalBoundary'

const AT = 1_760_000_000_000

describe('coal boundary', () => {
  it('[INV-95, ADR-006] a unit at install moment minus 1 ms is coal and a unit at the install moment is live', () => {
    expect(isCoal({ span: 'unit', providerTime: AT - 1 }, AT)).toBe(true)
    expect(isCoal({ span: 'unit', providerTime: AT }, AT)).toBe(false)
    expect(isCoal({ span: 'unit', providerTime: AT + 1 }, AT)).toBe(false)
  })

  it('[ADR-006] a lifetime-total stream whose newest record is after the install moment pays no coal', () => {
    // The honest-floor rule: a stream that only yields a lifetime total is coal only when its
    // newest record is before the moment; one that straddles it pays nothing as coal.
    expect(isCoal({ span: 'lifetime', providerTime: AT + 60_000 }, AT)).toBe(false)
    expect(isCoal({ span: 'lifetime', providerTime: AT }, AT)).toBe(false)
    expect(isCoal({ span: 'lifetime', providerTime: AT - 1 }, AT)).toBe(true)
    expect(coalStreamKey('thread-1')).toBe('coal:thread-1')
  })
})
