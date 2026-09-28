import { describe, expect, it } from 'vitest'
import { joinAnswerLabels, type DwarfPermissionRequest, type DwarfQuestion } from '../../types'
import { permissionAnswerRecord, questionAnswersRecord, wordsAnswerRecord } from './answersRecord'

/*
 * The "Answers:" record (#635; MESSAGE-QUESTIONS 8, decision log, Answers bubble is a record): the
 * line "Answers:", a blank line, then one "- <question, one trailing ? removed>: **<answer>**"
 * item per step, in step order (screens/message.md, As built). The texts below are this suite's
 * own, never the design's sample.
 */

function ask(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    channel: 'held',
    questions: [
      {
        question: 'Which store should the cache use?',
        multiSelect: false,
        options: [{ label: 'Redis' }, { label: 'Memory' }]
      },
      {
        question: 'Keep the old keys for a release, or drop them now?',
        multiSelect: false,
        options: [{ label: 'Keep them' }, { label: 'Drop them' }]
      },
      {
        question: 'Can I run the slow suite? It takes a while.',
        multiSelect: false,
        options: [{ label: 'Yes' }, { label: 'No' }]
      }
    ],
    ...overrides
  }
}

function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_p1',
    toolName: 'Bash',
    input: 'pnpm install in feat/cache',
    channel: 'held',
    askedAt: '2026-09-28T09:00:00.000Z',
    ...overrides
  }
}

describe('questionAnswersRecord', () => {
  it('writes one bold answer per step, in step order, under "Answers:" and a blank line', () => {
    expect(questionAnswersRecord(ask(), ['Redis', 'Keep them', 'Yes'])).toBe(
      [
        'Answers:',
        '',
        '- Which store should the cache use: **Redis**',
        '- Keep the old keys for a release, or drop them now: **Keep them**',
        '- Can I run the slow suite? It takes a while.: **Yes**'
      ].join('\n')
    )
  })

  it('removes one trailing "?" only, and leaves a question without one as it is', () => {
    const one = ask({
      questions: [
        { question: 'Really??', multiSelect: false, options: [{ label: 'Yes' }] },
        { question: 'Pick a store', multiSelect: false, options: [{ label: 'Redis' }] }
      ]
    })
    expect(questionAnswersRecord(one, ['Yes', 'Redis'])).toBe(
      'Answers:\n\n- Really?: **Yes**\n- Pick a store: **Redis**'
    )
  })

  it('takes a one-question answer given as one label', () => {
    const one = ask({ questions: [ask().questions[0]!] })
    expect(questionAnswersRecord(one, 'Memory')).toBe(
      'Answers:\n\n- Which store should the cache use: **Memory**'
    )
  })

  it('puts a free-text step’s own words in bold, as the person wrote them', () => {
    expect(
      questionAnswersRecord(ask(), ['Redis', { ownWords: 'Keep them until Friday' }, 'Yes'])
    ).toBe(
      [
        'Answers:',
        '',
        '- Which store should the cache use: **Redis**',
        '- Keep the old keys for a release, or drop them now: **Keep them until Friday**',
        '- Can I run the slow suite? It takes a while.: **Yes**'
      ].join('\n')
    )
  })

  /*
   * A multi-select value is several labels joined by the wire's line break (joinAnswerLabels),
   * which inside a list item would end the list. The record lists them with ", ", the SDK's own
   * spelling of a multi-select answer (reported as a design gap in #635's PR).
   */
  it('lists a multi-select step’s labels on its one line', () => {
    const one = ask({
      questions: [
        {
          question: 'Which checks?',
          multiSelect: true,
          options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }]
        }
      ]
    })
    expect(questionAnswersRecord(one, [joinAnswerLabels(['Lint', 'Tests'])])).toBe(
      'Answers:\n\n- Which checks: **Lint, Tests**'
    )
  })
})

describe('wordsAnswerRecord', () => {
  it('records a one-question ask answered in the person’s own words', () => {
    const one = ask({ channel: 'terminal', questions: [ask().questions[0]!] })
    expect(wordsAnswerRecord(one, 'A file on disk')).toBe(
      'Answers:\n\n- Which store should the cache use: **A file on disk**'
    )
  })
})

describe('permissionAnswerRecord', () => {
  it('is one item whose text is the request and whose bold answer is Allow', () => {
    expect(permissionAnswerRecord(permission(), 'allow')).toBe(
      'Answers:\n\n- Bash · pnpm install in feat/cache: **Allow**'
    )
  })

  it('answers Deny with the label Deny', () => {
    expect(permissionAnswerRecord(permission(), 'deny')).toBe(
      'Answers:\n\n- Bash · pnpm install in feat/cache: **Deny**'
    )
  })

  it('removes one trailing "?" from the request, as from a question', () => {
    expect(permissionAnswerRecord(permission({ input: 'rm -rf dist?' }), 'deny')).toBe(
      'Answers:\n\n- Bash · rm -rf dist: **Deny**'
    )
  })

  /*
   * The card prints the request on several lines (the CLI's sentence and subtitle under the tool
   * and its input), and a line break inside a list item would end the list: the record keeps it
   * one item, its lines joined by a space, as the bubble's Markdown joins a paragraph's lines
   * (reported as a design gap in #635's PR).
   */
  it('keeps a request of several lines one item', () => {
    expect(
      permissionAnswerRecord(
        permission({ title: 'Run this command?', description: 'It changes the lockfile.' }),
        'allow'
      )
    ).toBe(
      'Answers:\n\n- Bash · pnpm install in feat/cache Run this command? It changes the lockfile.: **Allow**'
    )
  })
})
