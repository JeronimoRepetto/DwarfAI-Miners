import { describe, expect, it } from 'vitest'
import type { DwarfAnswerState, DwarfQuestion } from '../../types'
import {
  answerRequest,
  answerStateForAsk,
  answerStatusLine,
  canSendAnswer,
  optionState,
  selectOption
} from './questionAnswer'

function question(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'Neither' }],
    ...overrides
  }
}

describe('selectOption', () => {
  it('selects the option that was clicked', () => {
    expect(selectOption(null, 'toolu_01', 'Postgres')).toEqual({
      toolUseId: 'toolu_01',
      label: 'Postgres'
    })
  })

  it('replaces the selection when another option is clicked', () => {
    const first = selectOption(null, 'toolu_01', 'Postgres')
    expect(selectOption(first, 'toolu_01', 'SQLite')).toEqual({
      toolUseId: 'toolu_01',
      label: 'SQLite'
    })
  })

  it('clears the selection when the selected option is clicked again', () => {
    const first = selectOption(null, 'toolu_01', 'Postgres')
    expect(selectOption(first, 'toolu_01', 'Postgres')).toBeNull()
  })

  it('never carries a selection from one ask into the next', () => {
    // The panel shows whatever ask is outstanding NOW. A choice made against a
    // question the agent has moved on from would be sent as an answer to a
    // question nobody read.
    const stale = selectOption(null, 'toolu_01', 'Postgres')
    expect(selectOption(stale, 'toolu_02', 'Postgres')).toEqual({
      toolUseId: 'toolu_02',
      label: 'Postgres'
    })
  })
})

describe('optionState', () => {
  it('leaves every card in its base state before anything is chosen', () => {
    for (const label of ['Postgres', 'SQLite', 'Neither']) {
      expect(optionState(null, 'toolu_01', label)).toBe('base')
    }
  })

  it('marks the chosen card selected and dims the rest', () => {
    const chosen = selectOption(null, 'toolu_01', 'SQLite')
    expect(optionState(chosen, 'toolu_01', 'SQLite')).toBe('selected')
    expect(optionState(chosen, 'toolu_01', 'Postgres')).toBe('dimmed')
    expect(optionState(chosen, 'toolu_01', 'Neither')).toBe('dimmed')
  })

  it('ignores a selection belonging to a different ask', () => {
    const stale = selectOption(null, 'toolu_01', 'SQLite')
    expect(optionState(stale, 'toolu_02', 'SQLite')).toBe('base')
  })
})

describe('canSendAnswer', () => {
  const chosen = selectOption(null, 'toolu_01', 'Postgres')

  it('refuses to send while nothing is selected', () => {
    // Selection alone does not send, and no selection sends nothing at all.
    expect(canSendAnswer(null, 'toolu_01', undefined)).toBe(false)
  })

  it('allows Enter once an option is selected', () => {
    expect(canSendAnswer(chosen, 'toolu_01', undefined)).toBe(true)
  })

  it('refuses a second send while one is still in flight', () => {
    const inFlight: DwarfAnswerState = { phase: 'answering', toolUseId: 'toolu_01' }
    expect(canSendAnswer(chosen, 'toolu_01', inFlight)).toBe(false)
  })

  it('allows another attempt after a refusal', () => {
    const refused: DwarfAnswerState = {
      phase: 'refused',
      toolUseId: 'toolu_01',
      error: 'That question is no longer open.'
    }
    expect(canSendAnswer(chosen, 'toolu_01', refused)).toBe(true)
  })

  it('refuses to answer an ask that was already released', () => {
    // The ask is gone the moment it is answered; the card stays on screen only
    // until the next snapshot drops it, and must not offer to answer twice.
    const answered: DwarfAnswerState = { phase: 'answered', toolUseId: 'toolu_01' }
    expect(canSendAnswer(chosen, 'toolu_01', answered)).toBe(false)
  })

  it('refuses a selection that belongs to a different ask', () => {
    expect(canSendAnswer(chosen, 'toolu_02', undefined)).toBe(false)
  })
})

describe('answerStateForAsk', () => {
  it('shows a verdict only against the ask it was given for', () => {
    const state: DwarfAnswerState = { phase: 'answered', toolUseId: 'toolu_01' }
    expect(answerStateForAsk(state, 'toolu_01')).toEqual(state)
    expect(answerStateForAsk(state, 'toolu_02')).toBeUndefined()
  })

  it('has nothing to show for a dwarf nobody has answered', () => {
    expect(answerStateForAsk(undefined, 'toolu_01')).toBeUndefined()
  })
})

describe('answerRequest', () => {
  it('keys the answer by the question text and values it by the option label', () => {
    // The shape the agent's own tool takes. Both halves are checked in main
    // against the ask it actually made, so an answer can only ever repeat the
    // agent's own words back to it.
    expect(answerRequest('claude:s1', question(), 'SQLite')).toEqual({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database should the importer write to?': 'SQLite' }
    })
  })

  it('repeats the question exactly as it reached the panel', () => {
    // Redaction happens at the provider boundary, and main matches on the
    // redacted spelling. Trimming or folding it here would break that match.
    const redacted = question({ question: '  Use the key [redacted]?  ' })
    expect(answerRequest('claude:s1', redacted, 'Postgres').answers).toEqual({
      '  Use the key [redacted]?  ': 'Postgres'
    })
  })

  it('carries one label even where the agent said it would take several', () => {
    // multiSelect changes nothing here: the channel takes a single label per
    // question, because how a picker joins several is unmeasured.
    const request = answerRequest('claude:s1', question({ multiSelect: true }), 'Neither')
    expect(Object.values(request.answers)).toEqual(['Neither'])
  })
})

describe('answerStatusLine', () => {
  it('says the agent was handed the choice, never that it acted on it', () => {
    const answered: DwarfAnswerState = { phase: 'answered', toolUseId: 'toolu_01' }
    const line = answerStatusLine(answered) ?? ''
    expect(line).toContain('released')
    expect(line).not.toMatch(/reacted|acted|chose|decided/i)
  })

  it('has no line to show while the answer is in flight or was refused', () => {
    // A refusal carries its reason into the panel's own alert row instead.
    expect(answerStatusLine({ phase: 'answering', toolUseId: 'toolu_01' })).toBeNull()
    expect(answerStatusLine({ phase: 'refused', toolUseId: 'toolu_01' })).toBeNull()
    expect(answerStatusLine(undefined)).toBeNull()
  })
})
