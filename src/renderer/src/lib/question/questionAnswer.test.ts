import { describe, expect, it } from 'vitest'
import type { DwarfAnswerState, DwarfPermissionRequest, DwarfQuestion } from '../../types'
import {
  PERMISSION_OPTIONS,
  answerRequest,
  answerStateForAsk,
  answerStatusLine,
  canSendAnswer,
  decisionForLabel,
  isAnswerable,
  optionState,
  permissionRequest,
  permissionStatusLine,
  selectOption
} from './questionAnswer'

function question(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    channel: 'held',
    multiSelect: false,
    questionCount: 1,
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

describe('isAnswerable', () => {
  it('is open until something is in flight against this ask', () => {
    expect(isAnswerable(undefined, 'toolu_01')).toBe(true)
    expect(isAnswerable({ phase: 'answering', toolUseId: 'toolu_01' }, 'toolu_01')).toBe(false)
    expect(isAnswerable({ phase: 'answered', toolUseId: 'toolu_01' }, 'toolu_01')).toBe(false)
    expect(isAnswerable({ phase: 'refused', toolUseId: 'toolu_01' }, 'toolu_01')).toBe(true)
  })

  it('ignores a verdict that belongs to a different ask', () => {
    expect(isAnswerable({ phase: 'answered', toolUseId: 'toolu_01' }, 'toolu_02')).toBe(true)
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

/**
 * A permission prompt (#203): Claude Code's own fixed two answers, never the
 * agent's own words. The selection machinery above (selectOption, optionState,
 * canSendAnswer, isAnswerable, answerStateForAsk) is reused as-is — it is keyed
 * by toolUseId, and a permission's toolUseId is exactly as good a key as a
 * question's.
 */
function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    input: 'rm -rf /tmp/scratch',
    channel: 'held',
    askedAt: '2026-09-05T09:00:00.000Z',
    ...overrides
  }
}

describe('PERMISSION_OPTIONS', () => {
  it('offers exactly Allow then Deny, Claude Code’s own fixed vocabulary', () => {
    expect(PERMISSION_OPTIONS.map((option) => option.label)).toEqual(['Allow', 'Deny'])
  })

  it('offers no "always allow" — nothing here outlives the prompt', () => {
    expect(PERMISSION_OPTIONS.some((option) => /always/i.test(option.label))).toBe(false)
  })
})

describe('decisionForLabel', () => {
  it('maps the two option labels to their decision', () => {
    expect(decisionForLabel('Allow')).toBe('allow')
    expect(decisionForLabel('Deny')).toBe('deny')
  })

  it('recognizes nothing else', () => {
    expect(decisionForLabel('Always Allow')).toBeNull()
    expect(decisionForLabel('')).toBeNull()
  })
})

describe('permissionRequest', () => {
  it('carries the dwarf, the prompt’s own toolUseId and the chosen decision', () => {
    expect(permissionRequest('claude:s1', permission(), 'allow')).toEqual({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_09',
      decision: 'allow'
    })
  })

  it('names whichever prompt was actually decided, not a stale one', () => {
    const later = permission({ toolUseId: 'toolu_10' })
    expect(permissionRequest('claude:s1', later, 'deny').toolUseId).toBe('toolu_10')
  })
})

describe('permissionStatusLine', () => {
  it('says the blocked call was released, never what it then did', () => {
    const answered: DwarfAnswerState = { phase: 'answered', toolUseId: 'toolu_09' }
    const line = permissionStatusLine(answered, 'held') ?? ''
    expect(line).toContain('released')
    expect(line).not.toMatch(/reacted|ran|executed|acted on/i)
  })

  it('has no line to show while the decision is in flight or was refused', () => {
    expect(permissionStatusLine({ phase: 'answering', toolUseId: 'toolu_09' }, 'held')).toBeNull()
    expect(permissionStatusLine({ phase: 'refused', toolUseId: 'toolu_09' }, 'held')).toBeNull()
    expect(permissionStatusLine(undefined, 'held')).toBeNull()
  })

  /*
   * Issue #203. A decision typed at somebody else's terminal has weaker
   * evidence behind it than one released through a stream this panel holds,
   * and a different risk if it lands late — so it may not borrow the held
   * channel's sentence. Delivered is not reacted: the key was pressed, and
   * the session acting on it is a separate fact the transcript reports later
   * by dropping the card.
   */
  it('says only that Allow was typed, and that the session has yet to act', () => {
    const line =
      permissionStatusLine(
        { phase: 'answered', toolUseId: 'toolu_09', decision: 'allow' },
        'terminal'
      ) ?? ''
    expect(line).toBe('Typed at the terminal — waiting for the session to act on it.')
    expect(line).not.toContain('released')
  })

  it('warns that a late Deny interrupts the turn instead, because Esc does', () => {
    // Deny is Esc (measured, #203). If the prompt was answered at the terminal
    // a moment earlier, the tool is already running and Esc cuts that turn
    // short. Bounded and accepted — the person wanted that tool not to run —
    // but not something to leave them to discover.
    const line =
      permissionStatusLine(
        { phase: 'answered', toolUseId: 'toolu_09', decision: 'deny' },
        'terminal'
      ) ?? ''
    expect(line).toBe(
      'Typed Esc at the terminal — if the prompt was already answered there, ' +
        'this interrupts the turn instead.'
    )
  })

  it('falls back to the Allow wording when a verdict names no decision', () => {
    // Cannot happen through `decide`, which always records one. The weaker of
    // the two sentences is the safe default: it claims a keypress and nothing
    // about a turn.
    expect(permissionStatusLine({ phase: 'answered', toolUseId: 'toolu_09' }, 'terminal')).toBe(
      'Typed at the terminal — waiting for the session to act on it.'
    )
  })
})
