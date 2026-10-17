// L1 tests of the Codex app-server protocol readers (15 §2.7, §4.4) over the bv@88eaa5c reference
// messages (MIT; `fixtures/codex/app-server-rpc/0.153.x-bv/meta.json` carries the notice), each
// read as copied and in its `-with-extra` variant (HR T1): an unknown field never changes a reading.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { activityOf, messageOf, readItemEvent } from './items'
import {
  KNOWN_REQUESTS,
  permissionReply,
  questionReply,
  readServerRequest,
  threadPolicy
} from './permissionMapping'
import { errorCause, readTokenUsage, turnEndOf, unitTokens } from './usage'

const BV = fileURLToPath(
  new URL('../../../../../../../fixtures/codex/app-server-rpc/0.153.x-bv/', import.meta.url)
)

/** A bv message as copied and with unknown fields; `-with-extra` names are upstream's own. */
function both(name: string): { method: string; params: unknown }[] {
  const read = (file: string) =>
    JSON.parse(readFileSync(`${BV}${file}.json`, 'utf8')) as { method: string; params: unknown }
  return name.endsWith('-with-extra') ? [read(name)] : [read(name), read(`${name}-with-extra`)]
}

const same = (text: string): string => text

describe('Codex app-server protocol readers (bv@88eaa5c)', () => {
  it('[C-06, C-07] a command or file-change approval opens one permission ask and answers only accept or decline', () => {
    for (const request of both('server-request-command-approval')) {
      const read = readServerRequest(request.method, request.params, same)
      expect(read).toMatchObject({
        kind: 'permission',
        approval: 'commandExecution',
        threadId: 'thr_123',
        turnId: 'turn_1',
        ask: {
          kind: 'permission',
          channel: 'driver',
          payload: { toolName: 'commandExecution', requestText: 'npm test' },
          options: { hasAllowOnce: true, hasRejectOnce: true },
          turnKey: 'turn_1'
        }
      })
    }
    for (const request of both('server-request-file-change-approval')) {
      expect(readServerRequest(request.method, request.params, same)).toMatchObject({
        kind: 'permission',
        approval: 'fileChange',
        ask: { payload: { toolName: 'fileChange', requestText: 'write access required' } }
      })
    }
    for (const approval of ['commandExecution', 'fileChange'] as const) {
      expect(permissionReply(approval, 'allow')).toEqual({ decision: 'accept' })
      expect(permissionReply(approval, 'deny')).toEqual({ decision: 'decline' })
    }
    // No reply this module builds carries a forbidden decision (ADR-008 item 3).
    const replies = JSON.stringify([
      permissionReply('commandExecution', 'allow'),
      permissionReply('fileChange', 'allow'),
      permissionReply('permissions', 'deny')
    ]).toLowerCase()
    for (const flag of FORBIDDEN_FLAGS) expect(replies).not.toContain(flag.toLowerCase())
  })

  it('[C-10] a permissions request has no allow-once: Allow cannot be sent and Deny grants nothing', () => {
    expect(permissionReply('permissions', 'allow')).toBeNull()
    expect(permissionReply('permissions', 'deny')).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('[C-11, FM-070] the auth refresh, a dynamic tool call and a skill approval are unknown requests; an elicitation is declined', () => {
    for (const name of [
      'server-request-auth-refresh-with-extra',
      'server-request-dynamic-tool-call',
      'server-request-skill-approval'
    ]) {
      for (const request of both(name)) expect(KNOWN_REQUESTS.has(request.method)).toBe(false)
    }
    for (const request of both('server-request-mcp-elicitation')) {
      expect(KNOWN_REQUESTS.has(request.method)).toBe(true)
      expect(readServerRequest(request.method, request.params, same)).toEqual({
        kind: 'decline',
        reply: { action: 'decline', content: null }
      })
    }
    // A user-input request with no question cannot be asked: it is answered with no answer.
    for (const request of both('server-request-tool-request-user-input')) {
      expect(readServerRequest(request.method, request.params, same)).toEqual({
        kind: 'malformed',
        reply: { answers: {} }
      })
    }
  })

  it('[C-09] answers are keyed by question id, an option must be listed, and a decline is the empty answer set', () => {
    const read = readServerRequest(
      'item/tool/requestUserInput',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        isBlocking: true,
        questions: [
          {
            id: 'pick',
            header: 'Pick',
            question: 'Which?',
            options: [{ label: 'A', description: '' }]
          },
          { id: 'say', header: 'Say', question: 'Anything else?', isSecret: true, options: null }
        ]
      },
      same
    )
    if (read.kind !== 'question') throw new Error(`read ${read.kind}`)
    expect(read.ask.secret).toBe(true)
    expect(read.ask.payload.steps).toEqual([
      { text: 'Which?', options: ['A'], allowsFreeText: true },
      { text: 'Anything else?', options: [], allowsFreeText: true }
    ])
    expect(questionReply(read, { answers: [{ step: 0, option: 'A' }] })).toEqual({
      answers: { pick: { answers: ['A'] } }
    })
    expect(questionReply(read, { answers: [{ step: 0, option: 'B' }] })).toBeNull()
    expect(questionReply(read, { answers: [{ step: 2, freeText: 'x' }] })).toBeNull()
    expect(questionReply(read, { answers: [] })).toEqual({ answers: {} })
    expect(questionReply(read, { decline: true })).toEqual({ answers: {} })
  })

  it('[C-21] a token usage update reads both breakdowns and normalizes input net of cache and output net of reasoning', () => {
    for (const note of both('notification-token-usage-updated')) {
      const usage = readTokenUsage(note.params)
      expect(usage).toMatchObject({ threadId: 'thr_123', turnId: 'turn_1' })
      expect(
        unitTokens(usage?.total ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 })
      ).toEqual({
        inputNet: 50,
        output: 35,
        cacheRead: 10,
        cacheWrite: 0,
        reasoning: 5
      })
    }
    for (const note of both('notification-token-usage-updated-codex-0153')) {
      expect(readTokenUsage(note.params)?.total).toEqual({
        input: 16539,
        cached: 0,
        cacheWrite: 0,
        output: 5,
        reasoning: 0
      })
    }
  })

  it('[C-20] turn/completed maps completed to concluded and an error notification is a provider error with its code word', () => {
    for (const name of [
      'notification-turn-completed-with-extra',
      'notification-turn-completed-codex-0153'
    ]) {
      for (const note of both(name)) {
        const turn = (note.params as { turn: Record<string, unknown> }).turn
        expect(turnEndOf(turn)).toEqual({ kind: 'concluded' })
      }
    }
    for (const note of both('notification-error-notification')) {
      expect(errorCause(note.params)).toEqual({
        kind: 'provider-error',
        detail: 'other',
        retryable: false
      })
    }
    expect(errorCause({ error: { codexErrorInfo: 'unauthorized' } })).toEqual({
      kind: 'auth-required'
    })
  })

  it('[C-05] an agent message item is the dwarf line and a command item is one tool step, never its output', () => {
    for (const name of [
      'notification-item-completed-agent-message',
      'notification-item-completed-agent-message-codex-0153'
    ]) {
      for (const note of both(name)) {
        const event = readItemEvent(note.params)
        expect(event).not.toBeNull()
        expect(messageOf(event?.item ?? {})?.role).toBe('dwarf')
      }
    }
    for (const note of both('notification-item-started-command')) {
      const event = readItemEvent(note.params)
      if (event === null) throw new Error('no item')
      expect(activityOf(event, 'k', false, same)).toEqual({
        sourceKey: 'k',
        turnKey: 'turn_1',
        kind: 'tool',
        toolName: 'commandExecution',
        summary: 'npm test',
        state: 'started',
        at: null
      })
    }
    for (const note of both('notification-item-started-user-message-codex-0153')) {
      expect(messageOf(readItemEvent(note.params)?.item ?? {})?.role).toBe('person')
    }
  })

  it('[C-24, ADR-011] the thread policy asks on request by default and never lifts the sandbox', () => {
    expect(threadPolicy(null)).toEqual({ approvalPolicy: 'on-request' })
    const mode = (options: Record<string, string>) => ({
      id: 'm',
      label: 'm',
      needs: 'interactive' as const,
      providerArgs: { options }
    })
    expect(threadPolicy(mode({ sandbox: 'workspace-write' }))).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })
    expect(() => threadPolicy(mode({ sandbox: 'danger-full-access' }))).toThrow(/sandbox/)
    for (const flag of FORBIDDEN_FLAGS) {
      expect(() => threadPolicy(mode({ approvalPolicy: flag }))).toThrow(/forbidden/)
    }
  })
})
