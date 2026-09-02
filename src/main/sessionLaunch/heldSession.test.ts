import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine, type Mine } from '../domain/types'
import {
  askToWireQuestion,
  parseAskUserQuestion,
  resolveAnswers,
  stampHeldQuestions,
  type HeldAsk
} from './heldSession'

const ASKED_AT = '2026-09-02T07:00:00.000Z'

/** One well-formed AskUserQuestion input, as the SDK hands it to canUseTool. */
function askInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Green', description: 'The calm one', preview: '#0f0' },
          { label: 'Red', description: 'The loud one' }
        ]
      }
    ]
  }
}

describe('parseAskUserQuestion', () => {
  it('reads the question, its header, its flag and every option', () => {
    expect(parseAskUserQuestion('toolu_01', askInput())).toEqual({
      toolUseId: 'toolu_01',
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [
            { label: 'Green', description: 'The calm one' },
            { label: 'Red', description: 'The loud one' }
          ]
        }
      ]
    })
  })

  it('keeps every question of a multi-question ask, in the order it was asked', () => {
    const ask = parseAskUserQuestion('toolu_02', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })

    expect(ask?.questions.map((entry) => entry.question)).toEqual(['First?', 'Second?'])
    expect(ask?.questions[1]?.multiSelect).toBe(true)
  })

  it("drops each option's preview, which is never display text the panel needs", () => {
    const ask = parseAskUserQuestion('toolu_03', askInput())
    expect(ask?.questions[0]?.options[0]).toEqual({ label: 'Green', description: 'The calm one' })
  })

  it('refuses an input that is not an object, or carries no questions list', () => {
    expect(parseAskUserQuestion('toolu_04', null as unknown as Record<string, unknown>)).toBeNull()
    expect(parseAskUserQuestion('toolu_04', {})).toBeNull()
    expect(parseAskUserQuestion('toolu_04', { questions: 'Which colour?' })).toBeNull()
    expect(parseAskUserQuestion('toolu_04', { questions: [] })).toBeNull()
  })

  it('refuses the whole ask when a question is not the shape the schema promises', () => {
    // A non-array `options` means this block is not an AskUserQuestion at all,
    // so nothing is salvaged from it — the same split parse.ts drew for the
    // transcript-derived ask (#94 phase 1).
    expect(
      parseAskUserQuestion('toolu_05', {
        questions: [{ question: 'Which colour?', multiSelect: false, options: 'Green' }]
      })
    ).toBeNull()
    expect(
      parseAskUserQuestion('toolu_05', { questions: [{ multiSelect: false, options: [] }] })
    ).toBeNull()
  })

  it('drops one unusable option on its own, because the question is the load-bearing half', () => {
    const ask = parseAskUserQuestion('toolu_06', {
      questions: [
        { question: 'Which colour?', multiSelect: false, options: [{ label: 'Green' }, {}, 7] }
      ]
    })
    expect(ask?.questions[0]?.options).toEqual([{ label: 'Green' }])
  })

  it('refuses an ask no option could be read from: nothing could answer it', () => {
    expect(
      parseAskUserQuestion('toolu_07', {
        questions: [{ question: 'Which colour?', multiSelect: false, options: [{}, 7] }]
      })
    ).toBeNull()
  })

  it('treats a missing or non-boolean multiSelect as single-select', () => {
    const ask = parseAskUserQuestion('toolu_08', {
      questions: [{ question: 'Which colour?', options: [{ label: 'Green' }, { label: 'Red' }] }]
    })
    expect(ask?.questions[0]?.multiSelect).toBe(false)
  })
})

describe('askToWireQuestion', () => {
  it('carries the first question only — the wire shape is singular', () => {
    const ask = parseAskUserQuestion('toolu_10', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })!

    expect(askToWireQuestion(ask, ASKED_AT)).toEqual({
      toolUseId: 'toolu_10',
      question: 'First?',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
      askedAt: ASKED_AT
    })
  })

  it('redacts the question, the header, every label and every description', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const ask = parseAskUserQuestion('toolu_11', {
      questions: [
        {
          question: `Use ${secret}?`,
          header: `Key ${secret}`,
          multiSelect: false,
          options: [
            { label: `Yes ${secret}`, description: `Send ${secret}` },
            { label: 'No', description: 'Stop' }
          ]
        }
      ]
    })!

    const wire = askToWireQuestion(ask, ASKED_AT)
    expect(wire.question).toBe('Use [redacted]?')
    expect(wire.header).toBe('Key [redacted]')
    expect(wire.options[0]).toEqual({ label: 'Yes [redacted]', description: 'Send [redacted]' })
    expect(wire.options[1]).toEqual({ label: 'No', description: 'Stop' })
  })

  it('omits a header and a description the ask never carried', () => {
    const ask = parseAskUserQuestion('toolu_12', {
      questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }]
    })!
    const wire = askToWireQuestion(ask, ASKED_AT)
    expect('header' in wire).toBe(false)
    expect('description' in wire.options[0]!).toBe(false)
  })
})

describe('resolveAnswers', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx'
  const redacting = (): HeldAsk =>
    parseAskUserQuestion('toolu_20', {
      questions: [
        {
          question: `Use ${secret}?`,
          multiSelect: false,
          options: [{ label: `Yes ${secret}` }, { label: 'No' }]
        }
      ]
    })!

  it('answers with the option label the agent offered, keyed by the question text', () => {
    const ask = parseAskUserQuestion('toolu_21', askInput())!
    expect(resolveAnswers(ask, { 'Which colour?': 'Green' })).toEqual({
      ok: true,
      answers: { 'Which colour?': 'Green' }
    })
  })

  it('maps a redacted question and label back to the strings the agent actually wrote', () => {
    // The panel only ever saw the redacted spellings, so those are what come
    // back — and the agent's own tool would not recognise them.
    const resolved = resolveAnswers(redacting(), { 'Use [redacted]?': 'Yes [redacted]' })
    expect(resolved).toEqual({ ok: true, answers: { [`Use ${secret}?`]: `Yes ${secret}` } })
  })

  it('refuses an empty record: nothing was answered', () => {
    const ask = parseAskUserQuestion('toolu_22', askInput())!
    expect(resolveAnswers(ask, {}).ok).toBe(false)
  })

  it('refuses a question text the ask never carried', () => {
    const ask = parseAskUserQuestion('toolu_23', askInput())!
    const resolved = resolveAnswers(ask, { 'Which shape?': 'Green' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('question')
  })

  it('refuses a value that is not one of the labels the agent offered', () => {
    const ask = parseAskUserQuestion('toolu_24', askInput())!
    const resolved = resolveAnswers(ask, { 'Which colour?': 'Blue' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('option')
  })

  it('refuses two labels joined into one value, even where the ask was multi-select', () => {
    // Answering more than one option is unproven against a live agent, so the
    // engine sends exactly one label rather than a separator it guessed.
    const ask = parseAskUserQuestion('toolu_25', {
      questions: [
        { question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
      ]
    })!
    expect(resolveAnswers(ask, { 'Which?': 'A, B' }).ok).toBe(false)
  })

  it('refuses more answers than the ask has questions', () => {
    const ask = parseAskUserQuestion('toolu_26', askInput())!
    expect(resolveAnswers(ask, { 'Which colour?': 'Green', 'Which shape?': 'Round' }).ok).toBe(
      false
    )
  })

  it('refuses an answer to two questions that redact to the same text', () => {
    // Redaction is lossy on purpose, so it can collapse two distinct questions
    // into one string. Guessing which of them was answered is how the agent
    // would come to read an answer nobody gave.
    const ask = parseAskUserQuestion('toolu_28', {
      questions: [
        { question: `Use ${secret}?`, multiSelect: false, options: [{ label: 'A' }] },
        {
          question: 'Use sk-zyxwvutsrqponmlkjihgfe?',
          multiSelect: false,
          options: [{ label: 'B' }]
        }
      ]
    })!
    const resolved = resolveAnswers(ask, { 'Use [redacted]?': 'A' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('same')
  })

  it('accepts a partial record, because the wire only ever showed the first question', () => {
    const ask = parseAskUserQuestion('toolu_27', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })!
    expect(resolveAnswers(ask, { 'First?': 'A' })).toEqual({ ok: true, answers: { 'First?': 'A' } })
  })
})

describe('stampHeldQuestions', () => {
  const question = {
    toolUseId: 'toolu_30',
    question: 'Which colour?',
    multiSelect: false,
    options: [{ label: 'Green' }]
  }

  function board(): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [
          { ...defaultDwarf(), id: 'foreman-1', role: 'foreman', sessionId: 'sess-1' },
          { ...defaultDwarf(), id: 'worker-1', role: 'worker', sessionId: 'sess-1' }
        ]
      }
    ]
  }

  it("stamps the held session's live question onto its foreman", () => {
    const stamped = stampHeldQuestions(board(), () => ({ held: true, question }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toEqual(question)
  })

  it('supersedes a tail-derived question, and clears it when nothing is open', () => {
    const mines = board()
    mines[0]!.dwarfs[0] = {
      ...mines[0]!.dwarfs[0]!,
      pendingQuestion: { ...question, toolUseId: 'toolu_old' }
    }

    const stamped = stampHeldQuestions(mines, () => ({ held: true }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toBeUndefined()
    expect('pendingQuestion' in stamped[0]!.dwarfs[0]!).toBe(false)
  })

  it('leaves a session this panel does not hold exactly as the provider reported it', () => {
    const mines = board()
    const tail = { ...question, toolUseId: 'toolu_tail' }
    mines[0]!.dwarfs[0] = { ...mines[0]!.dwarfs[0]!, pendingQuestion: tail }

    const stamped = stampHeldQuestions(mines, () => ({ held: false }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toEqual(tail)
  })

  it("never stamps a worker, which shares its foreman's session id", () => {
    const stamped = stampHeldQuestions(board(), () => ({ held: true, question }))
    expect(stamped[0]!.dwarfs[1]!.pendingQuestion).toBeUndefined()
  })
})
