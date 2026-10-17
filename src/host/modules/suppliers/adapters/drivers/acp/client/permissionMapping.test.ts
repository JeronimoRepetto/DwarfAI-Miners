// L1 tests of the ACP rows of 15 §2.7: permission options → Allow / Deny, and form elicitation →
// the question card (ISSUE-151 "Tests to write FIRST" item 2).
import { describe, expect, it } from 'vitest'
import { answerReply, DECLINE, formOf } from './elicitation'
import { optionSet, permissionPayload, permissionReply } from './permissionMapping'

const FULL = [
  { optionId: 'always-yes', kind: 'allow_always' },
  { optionId: 'yes', kind: 'allow_once' },
  { optionId: 'yes-too', kind: 'allow_once' },
  { optionId: 'no', kind: 'reject_once' },
  { optionId: 'never', kind: 'reject_always' }
]

describe('ACP permission and question mapping (15 §2.7)', () => {
  it('[C-06] Allow answers the first allow_once option by optionId and never allow_always', () => {
    expect(permissionReply(FULL, 'allow')).toEqual({ kind: 'select', optionId: 'yes' })
    // The label plays no part: an allow_once named like a rejection is still the one chosen.
    const relabelled = [
      { optionId: 'a', kind: 'allow_always', name: 'Allow once' },
      { optionId: 'b', kind: 'allow_once', name: 'Reject' }
    ]
    expect(permissionReply(relabelled, 'allow')).toEqual({ kind: 'select', optionId: 'b' })
    expect(optionSet(FULL)).toEqual({ hasAllowOnce: true, hasRejectOnce: true })
  })

  it('[C-07] Deny answers reject_once and the turn continues', () => {
    expect(permissionReply(FULL, 'deny')).toEqual({ kind: 'select', optionId: 'no' })
    // Without reject_once, a Deny is never widened to reject_always: it is a JSON-RPC error.
    const noRejectOnce = FULL.filter((option) => option.kind !== 'reject_once')
    expect(permissionReply(noRejectOnce, 'deny')).toEqual({ kind: 'error' })
    expect(permissionReply([], 'deny')).toEqual({ kind: 'error' })
  })

  it('[C-10] an option set without allow_once is reported with hasAllowOnce false', () => {
    const noAllowOnce = FULL.filter((option) => option.kind !== 'allow_once')
    expect(optionSet(noAllowOnce)).toEqual({ hasAllowOnce: false, hasRejectOnce: true })
    // An Allow for it is refused, never sent as allow_always.
    expect(permissionReply(noAllowOnce, 'allow')).toEqual({ kind: 'refuse' })
    expect(optionSet([{ optionId: 'x', kind: 'something_new' }])).toEqual({
      hasAllowOnce: false,
      hasRejectOnce: false
    })
  })

  it('[C-06] the card names the tool and one redacted line, never the raw input', () => {
    const redact = (text: string): string => text.replace('hunter2', '[redacted]')
    expect(
      permissionPayload({ name: 'Bash', kind: 'execute', title: 'echo hunter2' }, redact)
    ).toEqual({ toolName: 'Bash', requestText: 'echo [redacted]' })
    expect(permissionPayload({ kind: 'edit', title: null }, redact)).toEqual({
      toolName: 'edit',
      requestText: 'edit'
    })
    expect(permissionPayload({ title: 'line one\nline two' }, redact)).toEqual({
      toolName: 'tool',
      requestText: 'line one'
    })
  })

  it('[C-09] form answers map to question_n and question_n_custom and decline sends the elicitation decline', () => {
    const form = formOf({
      mode: 'form',
      message: 'Claude has questions',
      requestedSchema: {
        type: 'object',
        properties: {
          question_1: { type: 'string', title: 'Which cache?', enum: ['Redis', 'Memcached'] },
          question_1_custom: { type: 'string', title: 'Other' },
          question_0: {
            type: 'string',
            description: 'Keep the logs?',
            oneOf: [
              { const: 'Yes', title: 'Yes' },
              { const: 'No', title: 'No' }
            ]
          }
        }
      }
    })
    expect(form?.payload).toEqual({
      steps: [
        { text: 'Keep the logs?', options: ['Yes', 'No'], allowsFreeText: true },
        { text: 'Which cache?', options: ['Redis', 'Memcached'], allowsFreeText: true }
      ]
    })
    if (form === null) return
    expect(
      answerReply(form, [
        { step: 0, option: 'No' },
        { step: 1, freeText: 'Only the local one' }
      ])
    ).toEqual({
      action: 'accept',
      content: { question_0: 'No', question_1_custom: 'Only the local one' }
    })
    // An empty answers array is an ordinary accept, never a decline (ADR-009 D3).
    expect(answerReply(form, [])).toEqual({ action: 'accept', content: {} })
    // Answers that do not fit the form are refused, never sent.
    expect(answerReply(form, [{ step: 0, option: 'Maybe' }])).toBe('invalid-answer')
    expect(answerReply(form, [{ step: 2, option: 'Yes' }])).toBe('invalid-answer')
    // Free text for a step with no custom property and closed options does not fit either.
    expect(answerReply(form, [{ step: 0, freeText: 'Sometimes' }])).toBe('invalid-answer')
    expect(DECLINE).toEqual({ action: 'decline' })
  })

  it('[C-09] a step shows its question, not the short header claude-agent-acp puts in the field title', () => {
    const header = (title: string, description?: string) => ({
      type: 'string',
      title,
      ...(description === undefined ? {} : { description }),
      oneOf: [
        { const: 'Red', title: 'Red' },
        { const: 'Blue', title: 'Blue' }
      ]
    })
    // One question: claude-agent-acp 0.93.0 carries it in message (fixtures/claude/acp/2.1.x).
    const single = formOf({
      mode: 'form',
      message: 'Pick a colour',
      requestedSchema: { type: 'object', properties: { question_0: header('Colour') } }
    })
    expect(single?.payload.steps.map((step) => step.text)).toEqual(['Pick a colour'])
    // Several: each field's description holds its own question.
    const several = formOf({
      mode: 'form',
      message: 'Claude has questions',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: header('Colour', 'Pick a colour'),
          question_1: header('Shade', 'Pick a shade')
        }
      }
    })
    expect(several?.payload.steps.map((step) => step.text)).toEqual([
      'Pick a colour',
      'Pick a shade'
    ])
  })

  it('[C-11] a form without a question_n property or not in form mode is not a question card', () => {
    expect(formOf({ mode: 'url', message: 'Sign in', requestedSchema: {} })).toBeNull()
    expect(
      formOf({
        mode: 'form',
        message: 'x',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
      })
    ).toBeNull()
    expect(formOf({ mode: 'form', message: 'x' })).toBeNull()
    // An option list that is not a list of labels is malformed.
    expect(
      formOf({
        mode: 'form',
        message: 'x',
        requestedSchema: { properties: { question_0: { type: 'string', enum: [1, 2] } } }
      })
    ).toBeNull()
  })
})
