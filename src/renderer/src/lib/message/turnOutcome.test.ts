import { describe, expect, it } from 'vitest'
import type { TurnOutcome } from '../../types'
import { finishedTurnWord } from './turnOutcome'

const ENDED_AT = 1_700_000_000_000

function outcome(overrides: Partial<TurnOutcome>): TurnOutcome {
  return { kind: 'concluded', endedAt: ENDED_AT, ...overrides }
}

/*
 * AMENDED for #635 (the turn outcome line ruling, MESSAGE-QUESTIONS 7; was: turnOutcomeLine, a
 * headline per kind, "Last turn concluded" with the turn's own text and a trimmed flag, and the
 * provider's detail in parentheses). The ruling keeps one fact of a finished turn for the line,
 * how it ended, in its own four words, and none of the old sentence's other parts: the turn's text
 * and its trimmed flag, and the provider's detail, leave the line. The seven old tests pinned that
 * sentence and went with it; the four kinds are pinned below, and "says nothing for a dwarf with
 * no last turn" became the plain "Turn finished" of a session the app only observes.
 */
describe('finishedTurnWord (#510, #635)', () => {
  it('reads a turn the app never saw end as finished, which a resting session is', () => {
    expect(finishedTurnWord(undefined)).toBe('Turn finished')
  })

  it('reads a concluded turn as finished, never with the words it closed on', () => {
    expect(finishedTurnWord(outcome({ kind: 'concluded', text: 'Found the seam.' }))).toBe(
      'Turn finished'
    )
  })

  it('names a turn the provider stopped on its own limit — a limit is not a conclusion', () => {
    expect(finishedTurnWord(outcome({ kind: 'capped', detail: 'error_max_turns' }))).toBe(
      'Turn stopped at a limit'
    )
  })

  it('names a failed turn, without the provider’s own code', () => {
    expect(finishedTurnWord(outcome({ kind: 'errored', detail: 'error_during_execution' }))).toBe(
      'Turn failed'
    )
  })

  it('names an interrupted turn, without the provider’s own code', () => {
    expect(finishedTurnWord(outcome({ kind: 'interrupted', detail: 'CANCELED' }))).toBe(
      'Turn interrupted'
    )
  })
})
