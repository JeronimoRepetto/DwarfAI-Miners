import { describe, expect, it } from 'vitest'
import { askHasAReachableOtherRow, type DwarfQuestion } from '../domain/types'
import {
  answerChunksPressable,
  questionAnswerChunks,
  questionFreeTextChunks,
  questionKeystrokesFor
} from './questionKeys'

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

/*
 * The keys that type a person's OWN words into the picker's "Other" row
 * (#481).
 *
 * Measured live by the maintainer at the keyboard on **Claude Code 2.1.276**,
 * Windows Terminal, 2026-09-18, one question per call, single-select:
 *
 * - On a TWO-option ask, pressing `3` — the digit one past the last option —
 *   landed on the Other row with its text field READY: no Enter opened it. The
 *   sentence typed, then ONE Enter, arrived as the tool's answer.
 * - On a THREE-option ask, `4` did the same. So the digit is N+1, which is
 *   #402's "the picker numbers its own rows after the agent's" arriving AT the
 *   row rather than past it.
 * - Pressing Down N times reached the same row in the same state.
 *
 * What is NOT measured and is refused rather than guessed: the Other row of a
 * MULTI-select ask (Enter toggles there), a call carrying several questions,
 * and an ask with more options than the picker numbers rows for. The
 * nine-option arrow route below is DERIVED from the N+1 rule rather than
 * watched — it is where the digit runs out, not where the arrows were counted.
 */
describe('questionFreeTextChunks (#481)', () => {
  it('reaches the Other row of a two-option ask by the digit one past its options', () => {
    // Measured: on a two-option ask the row is 3, and its field is ready to
    // type into the moment it is reached.
    const two = [{ label: 'Fig' }, { label: 'Plum' }]
    expect(questionFreeTextChunks(ask({ options: two }), 'both')).toEqual({
      ok: true,
      chunks: ['3', 'both', '\r']
    })
  })

  it('reaches it by 4 on a three-option ask, which is the same N+1 arithmetic', () => {
    // The second measurement, and the one that makes N+1 a rule rather than a
    // coincidence of one reading.
    const three = [{ label: 'Fig' }, { label: 'Plum' }, { label: 'Pear' }]
    expect(questionFreeTextChunks(ask({ options: three }), 'a quince')).toEqual({
      ok: true,
      chunks: ['4', 'a quince', '\r']
    })
  })

  it('still has a digit at eight options, which is the last row past them', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index + 1}` }))
    expect(questionFreeTextChunks(ask({ options: eight }), 'mine')).toEqual({
      ok: true,
      chunks: ['9', 'mine', '\r']
    })
  })

  it('walks down to it with one arrow per option where the digits run out', () => {
    // Nine options take every digit the picker numbers, so the Other row has
    // none: N Down arrows land on it instead, each its own chunk because each
    // is its own keystroke (#404).
    const nine = Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index + 1}` }))
    const down = '\u001b[B'
    expect(questionFreeTextChunks(ask({ options: nine }), 'mine')).toEqual({
      ok: true,
      chunks: [down, down, down, down, down, down, down, down, down, 'mine', '\r']
    })
  })

  it('spells that arrow as the VT sequence, never as a virtual key name', () => {
    // The same finding #402 turned on for cursor-right: ConPTY hands the hosted
    // process VT input, so Down is the three ordinary characters ESC, '[', 'B'.
    const nine = Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index + 1}` }))
    const built = questionFreeTextChunks(ask({ options: nine }), 'mine')
    const first = built.ok ? (built.chunks[0] ?? '') : ''
    expect([...first].map((unit) => unit.codePointAt(0))).toEqual([27, 91, 66])
  })

  it('ends on one Enter, which is the whole of what sends the typed answer', () => {
    const built = questionFreeTextChunks(ask({ options: [{ label: 'Fig' }] }), 'a quince')
    expect(built.ok && built.chunks.at(-1)).toBe('\r')
    expect(built.ok && built.chunks.filter((chunk) => chunk === '\r')).toHaveLength(1)
  })

  it('carries the words exactly as typed, neither trimmed nor flattened', () => {
    // A message is flattened before it is written, because a console submits on
    // a newline. Here the newline is refused instead (below), so nothing is
    // left to reshape — and reshaping an ANSWER would hand the agent words the
    // person did not write.
    const built = questionFreeTextChunks(ask({ options: [{ label: 'Fig' }] }), '  two  spaces  ')
    expect(built).toEqual({ ok: true, chunks: ['2', '  two  spaces  ', '\r'] })
  })

  it('refuses an ask that carried more than one question', () => {
    expect(questionFreeTextChunks(ask({ questionCount: 2 }), 'mine')).toEqual({
      ok: false,
      reason: 'several-questions'
    })
  })

  it('refuses a multi-select ask, where Enter toggles rather than sends', () => {
    // Unmeasured on this build, and the gesture underneath is known to differ:
    // Enter on a multi-select picker toggles the row the cursor is on (#362
    // round 1), so what it does on that picker's Other row is nobody's finding.
    expect(questionFreeTextChunks(ask({ multiSelect: true }), 'mine')).toEqual({
      ok: false,
      reason: 'other-row-not-measured'
    })
  })

  it('refuses an ask with more options than the picker numbers rows', () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` }))
    expect(questionFreeTextChunks(ask({ options: ten }), 'mine')).toEqual({
      ok: false,
      reason: 'other-row-not-measured'
    })
  })

  it('refuses an ask offering nothing, whose first row was never counted', () => {
    expect(questionFreeTextChunks(ask({ options: [] }), 'mine')).toEqual({
      ok: false,
      reason: 'other-row-not-measured'
    })
  })

  it.each([[''], ['   '], ['\t \t']])(
    'refuses %j, which would send an empty answer on the Enter behind it',
    (text) => {
      expect(questionFreeTextChunks(ask(), text)).toEqual({ ok: false, reason: 'nothing-typed' })
    }
  )

  it.each([['a\rb'], ['a\nb'], ['a\r\nb'], ['a\u001bb'], ['a\u001b[Bb'], ['a\tb'], ['a\u0000b']])(
    'refuses %j rather than sanitising it',
    (text) => {
      // Refused and not repaired, because every repair is a different sentence
      // from the one the person wrote: a carriage return SENDS the field early,
      // an escape steers the picker out of it, and a tab moves between its
      // controls. The person is told, and keeps their words.
      expect(questionFreeTextChunks(ask(), text)).toEqual({
        ok: false,
        reason: 'text-would-steer-the-picker'
      })
    }
  )

  it('bounds a long answer into chunks the console reads whole (#425)', () => {
    // The ceiling measured for a message holds here for the same reason: one
    // WriteConsoleInputW call carrying too much loses its own beginning
    // somewhere between ConPTY and a live TUI's reader.
    const built = questionFreeTextChunks(ask(), 'x'.repeat(1_200))
    expect(built.ok && built.chunks).toEqual([
      '5',
      'x'.repeat(500),
      'x'.repeat(500),
      'x'.repeat(200),
      '\r'
    ])
  })

  it('agrees exactly with the rule the renderer draws the box from', () => {
    // The card offers the box off askHasAReachableOtherRow and main builds the
    // keys here. A shape one accepts and the other refuses is a box that types
    // into a refusal, so the two are pinned against each other rather than
    // trusted to stay aligned.
    const labelled = (count: number): { label: string }[] =>
      Array.from({ length: count }, (_, index) => ({ label: `Option ${index + 1}` }))
    const shapes: DwarfQuestion[] = [
      ask(),
      ask({ multiSelect: true }),
      ask({ questionCount: 2 }),
      ask({ options: [] }),
      ask({ options: labelled(9) }),
      ask({ options: labelled(10) })
    ]
    for (const shape of shapes) {
      expect(questionFreeTextChunks(shape, 'mine').ok).toBe(askHasAReachableOtherRow(shape))
    }
  })
})

/*
 * The guard the Windows port runs over whatever chunk list it is handed
 * (#481).
 *
 * The digit route has had one since #402 — a chunk is one of the nine digits or
 * nothing is written — and the free-text route needs its own, because its
 * payload is a person's own words rather than an option position. Same
 * fail-closed shape: a key this app has not measured does not reach somebody
 * else's console.
 */
describe('answerChunksPressable (#481)', () => {
  it('accepts the digit route it has always carried', () => {
    expect(answerChunksPressable(['2', '4', '\u001b[C', '\r'])).toBe(true)
  })

  it('accepts a free-text answer: the reach, the words, and the Enter', () => {
    expect(answerChunksPressable(['3', 'write to Postgres', '\r'])).toBe(true)
    expect(answerChunksPressable(['\u001b[B', '\u001b[B', 'mine', '\r'])).toBe(true)
  })

  it('refuses an empty list, which would attach to a console and press nothing', () => {
    expect(answerChunksPressable([])).toBe(false)
  })

  it('refuses an empty chunk, which spends a call writing no records', () => {
    expect(answerChunksPressable(['3', '', '\r'])).toBe(false)
  })

  it.each([['ship it\r'], ['ship\nit'], ['ship \u001b it'], ['ship\tit']])(
    'refuses %j, whose control characters are keys rather than letters',
    (chunk) => {
      expect(answerChunksPressable(['3', chunk, '\r'])).toBe(false)
    }
  )
})
