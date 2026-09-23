import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCodexPendingQuestion } from './parse'

/**
 * The red half of #265. Codex writes no record while an APPROVAL prompt waits —
 * `docs/codex-v2-format.md` §9 measures that from both ends — but a question the
 * model itself asks does leave one: a `response_item`/`function_call` named
 * `request_user_input`, whose `arguments` carry the questions and their options.
 *
 * A call line is appended when the call is emitted, not when its result arrives
 * (§9(b): one orphaned call in 7 198, with 234 records written after it), so a
 * `request_user_input` with no `function_call_output` for its `call_id` is a
 * session waiting on its human, said in the model's own words. That is the whole
 * reason this may become a `DwarfQuestion` at all: `contracts.ts` forbids prose
 * as evidence, and this is not prose.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')
const pending = readFileSync(join(FIXTURES, 'rollout-pending-question.jsonl'), 'utf8')

/** The same rollout once the person has chosen — the question is over. */
const answered =
  pending +
  JSON.stringify({
    timestamp: '2026-08-24T12:39:40.997Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      id: 'fc_9c052f81d6b44ae0',
      call_id: 'call_9c052f81d6b44',
      output: '{"answers":[{"id":"scope_choice","label":"Source only"}]}'
    }
  }) +
  '\n'

describe('parseCodexPendingQuestion', () => {
  it('reads the question and its options from an unanswered request_user_input', () => {
    // AMENDED for #362 (was: the same object without `questionCount`), and
    // again for #443 (was: the question's fields flat beside `questionCount:
    // 1`). The same values, inside the call's one-entry `questions` list.
    expect(parseCodexPendingQuestion(pending)).toEqual({
      toolUseId: 'call_9c052f81d6b44',
      askedAt: '2026-08-24T12:37:01.545Z',
      questions: [
        {
          header: 'Scope',
          question:
            "Should the rename cover the sample module's tests as well, or only its source?",
          multiSelect: false,
          options: [
            {
              label: 'Source and tests',
              description: 'Rename every occurrence, including the fixtures the tests read.'
            },
            {
              label: 'Source only',
              description: 'Leave the tests untouched so their failures stay readable.'
            }
          ]
        }
      ]
    })
  })

  it('reports nothing once a function_call_output answers that call_id', () => {
    expect(parseCodexPendingQuestion(answered)).toBeUndefined()
  })

  it('reports nothing for a rollout that never asked', () => {
    const rollout = readFileSync(join(FIXTURES, 'rollout.jsonl'), 'utf8')
    expect(parseCodexPendingQuestion(rollout)).toBeUndefined()
  })

  it('ignores a function_call that is not request_user_input', () => {
    const shell = JSON.stringify({
      timestamp: '2026-08-24T12:37:01.545Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'call_shell',
        arguments: '{"command":"pnpm test"}'
      }
    })
    expect(parseCodexPendingQuestion(`${shell}\n`)).toBeUndefined()
  })

  /*
   * Issue #443. The wire carries a call's questions as a list, and Codex's
   * measured calls each asked one — so the list it emits has one entry, with the
   * single-select flag Codex's argument shape implies.
   */
  it('emits the one question Codex asked as a one-element list', () => {
    expect(parseCodexPendingQuestion(pending)?.questions).toEqual([
      {
        header: 'Scope',
        question: "Should the rename cover the sample module's tests as well, or only its source?",
        multiSelect: false,
        options: [
          {
            label: 'Source and tests',
            description: 'Rename every occurrence, including the fixtures the tests read.'
          },
          {
            label: 'Source only',
            description: 'Leave the tests untouched so their failures stay readable.'
          }
        ]
      }
    ])
  })

  it('carries a call that asked two things as two, so the card still says it cannot answer it', () => {
    // Never observed, and the reason it is carried rather than narrowed: a
    // list cut to its first entry would read as a one-question ask, and the
    // card would offer an answer where it used to say this ask belongs to its
    // terminal (#362, #443).
    const call = JSON.stringify({
      timestamp: '2026-08-24T12:37:01.545Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_two',
        arguments: JSON.stringify({
          questions: [
            { id: 'a', question: 'Which colour?', options: [{ label: 'Red' }] },
            { id: 'b', question: 'Which shape?', options: [{ label: 'Round' }] }
          ]
        })
      }
    })
    const asked = parseCodexPendingQuestion(`${call}\n`)
    expect(asked?.questions.map((entry) => entry.question)).toEqual([
      'Which colour?',
      'Which shape?'
    ])
  })
})
