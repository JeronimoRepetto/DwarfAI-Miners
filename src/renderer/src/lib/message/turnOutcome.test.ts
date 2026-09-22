import { describe, expect, it } from 'vitest'
import type { TurnOutcome } from '../../types'
import { turnOutcomeLine } from './turnOutcome'

const ENDED_AT = 1_700_000_000_000

function outcome(overrides: Partial<TurnOutcome>): TurnOutcome {
  return { kind: 'concluded', endedAt: ENDED_AT, ...overrides }
}

describe('turnOutcomeLine (#510)', () => {
  it('says nothing for a dwarf with no last turn', () => {
    expect(turnOutcomeLine(undefined)).toBeUndefined()
  })

  it('reads a concluded turn as its own headline plus the text it actually said', () => {
    const line = turnOutcomeLine(outcome({ kind: 'concluded', text: 'Found the seam.' }))
    expect(line).toEqual({
      kind: 'concluded',
      headline: 'Last turn concluded',
      text: 'Found the seam.',
      trimmed: false
    })
  })

  it('marks a concluded turn trimmed only when the wire itself says so', () => {
    const line = turnOutcomeLine(
      outcome({ kind: 'concluded', text: 'Found the seam.', truncated: true })
    )
    expect(line?.trimmed).toBe(true)
  })

  it('never carries text for a capped turn — a limit is not a conclusion', () => {
    const line = turnOutcomeLine(outcome({ kind: 'capped', detail: 'error_max_turns' }))
    expect(line).toEqual({
      kind: 'capped',
      headline: 'Last turn stopped at a limit (error_max_turns)',
      text: undefined,
      trimmed: false
    })
  })

  it('never carries text for an errored turn, and names the provider’s own word', () => {
    const line = turnOutcomeLine(outcome({ kind: 'errored', detail: 'error_during_execution' }))
    expect(line).toEqual({
      kind: 'errored',
      headline: 'Last turn failed (error_during_execution)',
      text: undefined,
      trimmed: false
    })
  })

  it('never carries text for an interrupted turn, and names the provider’s own word', () => {
    const line = turnOutcomeLine(outcome({ kind: 'interrupted', detail: 'CANCELED' }))
    expect(line).toEqual({
      kind: 'interrupted',
      headline: 'Last turn was interrupted (CANCELED)',
      text: undefined,
      trimmed: false
    })
  })

  it('drops the parenthetical rather than printing empty parens when a provider gave no detail', () => {
    const line = turnOutcomeLine(outcome({ kind: 'errored' }))
    expect(line?.headline).toBe('Last turn failed')
  })
})
