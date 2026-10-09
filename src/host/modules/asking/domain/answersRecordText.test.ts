// layer: L1
// The "Answers:" record's text (ADR-010 items 2, 13; US-ASK-001.AC11): the line "Answers:", a blank
// line, then one list line per step, "- ", the step's text with one trailing "?" removed, ": ", and
// the answer in bold. Its format is the one the renderer's `lib/question/answersRecord` already
// tests (05 §3.7 "Domain ← renderer `lib/question` rules"); the texts below are this suite's own.
import { describe, expect, it } from 'vitest'
import type { PermissionPayload, QuestionPayload } from '../../../kernel/domain/sharedContracts'
import { permissionRecordText, questionRecordText } from './answersRecordText'

const QUESTION: QuestionPayload = {
  steps: [
    {
      text: 'Which store should the cache use?',
      options: ['Redis', 'Memory'],
      allowsFreeText: true
    },
    {
      text: 'Keep the old keys for a release, or drop them now?',
      options: ['Keep them', 'Drop them'],
      allowsFreeText: true
    },
    {
      text: 'Can I run the slow suite? It takes a while.',
      options: ['Yes', 'No'],
      allowsFreeText: true
    }
  ]
}

const PERMISSION: PermissionPayload = {
  toolName: 'Bash',
  requestText: 'pnpm install in feat/cache'
}

describe('answersRecordText', () => {
  it('[US-ASK-001.AC11] the record reads "Answers:", a blank line, then one line per question without its trailing question mark and with the answer in bold', () => {
    expect(
      questionRecordText(QUESTION, [
        { step: 0, option: 'Redis' },
        { step: 1, option: 'Drop them' },
        { step: 2, option: 'Yes' }
      ])
    ).toBe(
      [
        'Answers:',
        '',
        '- Which store should the cache use: **Redis**',
        '- Keep the old keys for a release, or drop them now: **Drop them**',
        '- Can I run the slow suite? It takes a while.: **Yes**'
      ].join('\n')
    )
  })

  it('[US-ASK-001.AC11] the lines follow the step order whatever order the answers arrive in', () => {
    expect(
      questionRecordText(QUESTION, [
        { step: 2, option: 'No' },
        { step: 0, option: 'Memory' },
        { step: 1, option: 'Keep them' }
      ])
    ).toBe(
      [
        'Answers:',
        '',
        '- Which store should the cache use: **Memory**',
        '- Keep the old keys for a release, or drop them now: **Keep them**',
        '- Can I run the slow suite? It takes a while.: **No**'
      ].join('\n')
    )
  })

  it('[US-ASK-002.AC07] a step answered with Other thing text shows that text as its answer', () => {
    expect(
      questionRecordText(QUESTION, [
        { step: 0, option: 'Redis' },
        { step: 1, freeText: 'Keep them until Friday' },
        { step: 2, option: 'Yes' }
      ])
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

  it('[US-ASK-001.AC11] words that Markdown would read as formatting are shown as written', () => {
    const one: QuestionPayload = {
      steps: [{ text: '- Use **bold** or `code`?', options: ['A'], allowsFreeText: true }]
    }
    expect(questionRecordText(one, [{ step: 0, freeText: 'keep_it *as* is' }])).toBe(
      'Answers:\n\n- \\- Use \\*\\*bold\\*\\* or \\`code\\`: **keep\\_it \\*as\\* is**'
    )
  })

  it('[US-ASK-003.AC07] a permission record names the request and the bold decision', () => {
    expect(permissionRecordText(PERMISSION, 'allow')).toBe(
      'Answers:\n\n- Bash · pnpm install in feat/cache: **Allow**'
    )
    expect(permissionRecordText(PERMISSION, 'deny')).toBe(
      'Answers:\n\n- Bash · pnpm install in feat/cache: **Deny**'
    )
  })

  it('[US-ASK-003.AC07] a request of several lines stays one list line, its lines joined by a space', () => {
    expect(
      permissionRecordText(
        { toolName: 'Bash', requestText: 'rm -rf dist\nClean the build?' },
        'deny'
      )
    ).toBe('Answers:\n\n- Bash · rm -rf dist Clean the build: **Deny**')
  })
})
