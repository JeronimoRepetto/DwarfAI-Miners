import { describe, expect, it } from 'vitest'
import {
  MESSAGE_PANEL_ASK_HEIGHT,
  MESSAGE_PANEL_MAX_HEIGHT,
  MESSAGE_PANEL_MIN_HEIGHT,
  clampPanelHeight,
  initialPanelHeight
} from './panelHeight'

describe('initialPanelHeight', () => {
  it('opens at the floor for a dwarf that has said nothing', () => {
    expect(initialPanelHeight('')).toBe(MESSAGE_PANEL_MIN_HEIGHT)
    expect(initialPanelHeight(undefined)).toBe(MESSAGE_PANEL_MIN_HEIGHT)
  })

  it('opens taller for a longer latest message', () => {
    const short = initialPanelHeight('Found the seam.')
    const long = initialPanelHeight('x'.repeat(800))
    expect(long).toBeGreaterThan(short)
  })

  it("counts a message's own line breaks, not only its length", () => {
    // Twelve short lines rather than six, so both readings clear the floor and
    // the comparison is between two derived heights rather than two clamps.
    const words = 'one two three four five six seven eight nine ten eleven twelve'
    expect(initialPanelHeight(words.split(' ').join('\n'))).toBeGreaterThan(
      initialPanelHeight(words)
    )
  })

  it('never opens taller than the ceiling, whatever the agent wrote', () => {
    expect(initialPanelHeight('x'.repeat(100_000))).toBe(MESSAGE_PANEL_MAX_HEIGHT)
    expect(initialPanelHeight('line\n'.repeat(500))).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('opens tall enough for an outstanding ask, which is a surface of its own', () => {
    // The ask replaces the composer with the agent's options and a box of its
    // own, and the design's question export is 547px tall against the base
    // export's 235. A panel opened at its floor would squash the conversation
    // to nothing to fit one.
    expect(initialPanelHeight('ok', true)).toBe(MESSAGE_PANEL_ASK_HEIGHT)
  })

  it('still lets a very long message under an ask ask for more room', () => {
    expect(initialPanelHeight('x'.repeat(20_000), true)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('is a pure function of the message: the same text always opens the same height', () => {
    // The design's rule is that reopening RECALCULATES from the latest
    // message, which is only true of a function with no memory in it.
    expect(initialPanelHeight('Found the seam.')).toBe(initialPanelHeight('Found the seam.'))
  })
})

describe('clampPanelHeight', () => {
  it('holds a dragged height between the floor and the ceiling', () => {
    expect(clampPanelHeight(0)).toBe(MESSAGE_PANEL_MIN_HEIGHT)
    expect(clampPanelHeight(-400)).toBe(MESSAGE_PANEL_MIN_HEIGHT)
    expect(clampPanelHeight(10_000)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('leaves a height inside the range exactly where the drag put it', () => {
    const inside = MESSAGE_PANEL_MIN_HEIGHT + 40
    expect(clampPanelHeight(inside)).toBe(inside)
  })

  it('rounds to a whole pixel, because a pointer reports fractions', () => {
    expect(clampPanelHeight(MESSAGE_PANEL_MIN_HEIGHT + 12.4)).toBe(MESSAGE_PANEL_MIN_HEIGHT + 12)
  })
})
