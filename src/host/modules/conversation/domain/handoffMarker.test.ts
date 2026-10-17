import { describe, expect, it } from 'vitest'
import { handoffMarkOf, markHandoff } from './handoffMarker'

// L1 (17 §1.1): the DwarfAI handoff marker (ADR-013 item 6; 18 §4.3 T-25, architect-proposed: the
// marker carries the delegation id). A pushed result is marked on its first line; reading a text
// back names the delegation it was marked for, or nothing.
const DELEGATION = '00000000-0000-7000-8000-0000000c2051'
const RESULT = 'The old shafts below the north seam are mapped.\nTwo are flooded.'

describe('handoff marker', () => {
  it('[ADR-013] a marked result names its delegation and keeps the result text whole', () => {
    const marked = markHandoff(DELEGATION, RESULT)

    expect(handoffMarkOf(marked)).toBe(DELEGATION)
    expect(marked.endsWith(RESULT)).toBe(true)
    // An echo may come back with surrounding whitespace or CRLF line ends.
    expect(handoffMarkOf(`  ${marked.replace(/\n/g, '\r\n')}\r\n`)).toBe(DELEGATION)
  })

  it('[ADR-013] a text with no marker, or the marker anywhere but its first line, names no delegation', () => {
    expect(handoffMarkOf(RESULT)).toBeNull()
    expect(handoffMarkOf(`Quoting: ${markHandoff(DELEGATION, RESULT)}`)).toBeNull()
    expect(handoffMarkOf('')).toBeNull()
  })
})
