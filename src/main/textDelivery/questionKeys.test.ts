import { describe, expect, it } from 'vitest'
import type { DwarfQuestion } from '../domain/types'
import { questionAnswerChunks, questionKeystrokesFor } from './questionKeys'

/**
 * Issue #362. The file that decides which digits this app presses in a picker
 * drawn in a console it does not own — the sibling of permissionKeys, and
 * guarded the same way: these tests pin a MEASUREMENT, so changing what is
 * claimed costs a deliberate edit with a build written down beside it.
 *
 * Measured on Claude Code 2.1.267, Windows Terminal, 2026-09-10, one question
 * per call: a single-select digit selects and submits by itself; a multi-select
 * digit toggles its option without moving the cursor, and {RIGHT} then {ENTER}
 * accepts the set.
 */
function ask(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    question: 'Which fruit?',
    channel: 'terminal',
    multiSelect: false,
    questionCount: 1,
    options: [{ label: 'Fig' }, { label: 'Plum' }, { label: 'Pear' }, { label: 'Sloe' }],
    ...overrides
  }
}

describe('questionKeystrokesFor (#362)', () => {
  it('answers a single-select ask with the chosen option’s own digit', () => {
    // 1-based, in the order the agent gave the options — which is the order the
    // picker numbers them in.
    expect(questionKeystrokesFor(ask(), ['Pear'])).toEqual({
      ok: true,
      digits: ['3'],
      submit: false
    })
  })

  it('numbers by position and never by label, so the first option is 1', () => {
    expect(questionKeystrokesFor(ask(), ['Fig'])).toEqual({
      ok: true,
      digits: ['1'],
      submit: false
    })
  })

  it('submits nothing extra for a single-select ask', () => {
    // The measured gesture is the digit ALONE. An Enter behind it would submit
    // the input box of a session whose picker has already closed.
    const resolved = questionKeystrokesFor(ask(), ['Plum'])
    expect(resolved).toEqual({ ok: true, digits: ['2'], submit: false })
  })

  it('toggles a multi-select ask in ascending option order and then submits', () => {
    // Ascending regardless of the order they were clicked in: the sequence has
    // to be deterministic from the picker's initial state, and the person's
    // click order is not part of that state.
    expect(questionKeystrokesFor(ask({ multiSelect: true }), ['Sloe', 'Plum'])).toEqual({
      ok: true,
      digits: ['2', '4'],
      submit: true
    })
  })

  it('takes a single choice on a multi-select ask, still through the submit', () => {
    // One toggle is a legitimate answer to "choose any"; what it must not lose
    // is the confirmation, because a multi-select picker does not fire on the
    // digit the way a single-select one does.
    expect(questionKeystrokesFor(ask({ multiSelect: true }), ['Fig'])).toEqual({
      ok: true,
      digits: ['1'],
      submit: true
    })
  })

  it('refuses an ask that carried more than one question', () => {
    // Typing an answer to question 1 walks the picker on to question 2, which
    // the wire does not carry — so a partial answer would be left behind in a
    // TUI nobody here can see. That ask belongs to its own terminal.
    expect(questionKeystrokesFor(ask({ questionCount: 2 }), ['Fig'])).toEqual({
      ok: false,
      reason: 'several-questions'
    })
  })

  it('refuses a label the agent did not offer', () => {
    // Nothing here may be free text: a label with no option behind it has no
    // digit, and guessing one would press whatever row happened to be there.
    expect(questionKeystrokesFor(ask(), ['Quince'])).toEqual({
      ok: false,
      reason: 'label-not-offered'
    })
  })

  it('refuses when nothing was chosen', () => {
    expect(questionKeystrokesFor(ask(), [])).toEqual({ ok: false, reason: 'nothing-chosen' })
    expect(questionKeystrokesFor(ask({ multiSelect: true }), [])).toEqual({
      ok: false,
      reason: 'nothing-chosen'
    })
  })

  it('refuses several labels for an ask that said it takes one', () => {
    // Two digits at a single-select picker are two answers: the first fires
    // and closes it, and the second lands in the session's input box.
    expect(questionKeystrokesFor(ask(), ['Fig', 'Plum'])).toEqual({
      ok: false,
      reason: 'wrong-arity'
    })
  })

  it('refuses the same option chosen twice, which would toggle it back off', () => {
    // Measured: a digit TOGGLES. Two identical digits leave the option exactly
    // as it started, so the answer sent would not be the answer given.
    expect(questionKeystrokesFor(ask({ multiSelect: true }), ['Plum', 'Plum'])).toEqual({
      ok: false,
      reason: 'option-chosen-twice'
    })
  })

  it('refuses an ask with a tenth option, whose rows have no digit', () => {
    // The picker numbers 1-9; nothing this app can press reaches a tenth row,
    // and a two-character "10" is two keystrokes at two different rows.
    const ten = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` }))
    expect(questionKeystrokesFor(ask({ options: ten }), ['Option 1'])).toEqual({
      ok: false,
      reason: 'more-options-than-digits'
    })
  })

  it('matches a label exactly, never by prefix or case', () => {
    expect(questionKeystrokesFor(ask(), ['fig'])).toEqual({
      ok: false,
      reason: 'label-not-offered'
    })
    expect(questionKeystrokesFor(ask(), ['Fig '])).toEqual({
      ok: false,
      reason: 'label-not-offered'
    })
  })
})

/*
 * The chunks those digits become on the wire (#402).
 *
 * Measured live 2026-09-16 on Claude Code 2.1.273, written into the session's
 * own console by pid rather than synthesized at a window: a digit as one text
 * record selects a single-select outright and toggles a multi-select row; `ESC
 * [ C` as three text records opens the multi-select summary; a bare Enter
 * accepts it. Each of those is one `WriteConsoleInputW` call, which is why they
 * are a LIST here rather than a string — see docs/console-hosting.md §6.
 *
 * The digit guard moved here with them, from buildQuestionAnswerCommand in
 * sendKeys.ts, which #402 deleted with the SendKeys answer path.
 */
describe('questionAnswerChunks (#402)', () => {
  it('writes a single-select answer as its digit and nothing else', () => {
    // Measured: the digit fires the selection on its own. An Enter behind it
    // would submit the input box of a session whose picker has already closed.
    expect(questionAnswerChunks(['3'], false)).toEqual(['3'])
  })

  it('writes a multi-select answer as its toggles, then cursor-right, then Enter', () => {
    expect(questionAnswerChunks(['2', '4'], true)).toEqual(['2', '4', '\u001b[C', '\r'])
  })

  it('spells the confirmation as the VT sequence, never as a virtual key name', () => {
    // The finding #402 turns on: an arrow does not have to travel as a virtual
    // key at all. Three ordinary characters — ESC, '[', 'C' — moved the picker
    // onto its Submit tab, so the chunk carries exactly those code units.
    const chunks = questionAnswerChunks(['1'], true) as string[]
    expect([...(chunks[1] ?? '')].map((unit) => unit.codePointAt(0))).toEqual([27, 91, 67])
    expect(chunks.join('')).not.toContain('{RIGHT}')
  })

  it('refuses an empty set of digits, which would accept an empty answer', () => {
    // A confirmation with no toggle in front of it submits nothing chosen.
    expect(questionAnswerChunks([], true)).toBeNull()
    expect(questionAnswerChunks([], false)).toBeNull()
  })

  it('refuses a tenth digit, which the picker numbers no row for', () => {
    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    expect(questionAnswerChunks(nine, true)).not.toBeNull()
    expect(questionAnswerChunks([...nine, '1'], true)).toBeNull()
  })

  it.each([['0'], ['10'], [''], ['a'], ['{ENTER}'], ['1 2'], ['+'], ['\r'], ['\u001b[C']])(
    'refuses %j, which is not one of the nine digits this picker answers to',
    (digit) => {
      // The whole payload a chunk may carry on this path is a digit, and this
      // guard is what keeps anything else out of somebody else's console.
      expect(questionAnswerChunks([digit], false)).toBeNull()
    }
  )
})
