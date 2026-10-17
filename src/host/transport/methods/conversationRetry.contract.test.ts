// layer: L6
// L6 (17 §1.6): B-M25 `conversation.retry` (14 §2.3, §3.4 `RetryMessageParams` /
// `RetryMessageResult`, frozen; ADR-019 runtime validation; 14 §1.6 transport dedupe; 14 §1.7 answer
// at acceptance) through the seam-B dispatcher, over a faked `ConversationCommands.retry`, and the
// A-N06 registry row that relays it (14 §2.2).
//
// TC-168-02: the A-N06 row and the B-M25 member both exist with strict schemas, and the row names
// `conversation.retry`.
import { describe, expect, it } from 'vitest'
import { CHANNELS, HOST_METHOD_SCHEMAS, UNROUTED } from '@dwarfai/contracts'
import type { MessageId, Result } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { Dispatcher } from '../dispatcher'
import { registerConversationRetry } from './conversationRetry'

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8168'
const MESSAGE = '01890a5d-ac96-774b-bcce-b302099a80a8' as MessageId
const UI = { role: 'ui' as const, clientId: 'c-ui' }
const PARAMS = { messageId: MESSAGE, requestId: REQUEST_ID }

type RetryAnswer = Result<void, 'cannot-receive' | 'not-failed'>

function served(answers: RetryAnswer[] = [{ ok: true, value: undefined }]) {
  const clock = new FakeClock(1_790_000_000_000)
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const calls: unknown[][] = []
  registerConversationRetry(dispatcher, {
    conversation: {
      retry: async (...args) => {
        calls.push(args)
        return answers[Math.min(calls.length - 1, answers.length - 1)] as RetryAnswer
      }
    }
  })
  return { dispatcher, calls }
}

describe('conversation.retry params and result (14 §3.4, B-M25)', () => {
  it('[ADR-019] conversation.retry params are strict', async () => {
    const { dispatcher, calls } = served()
    const ok = await dispatcher.dispatch(
      { id: '1', method: 'conversation.retry', params: PARAMS },
      UI
    )
    expect(ok).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    expect(calls).toEqual([[MESSAGE, REQUEST_ID]])

    const refused = [
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8169', text: 'new text' },
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a816a', dwarfId: MESSAGE },
      { messageId: MESSAGE },
      { requestId: '01890a5d-ac96-774b-bcce-b302099a816b' },
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a816c', messageId: 'not-a-uuid' }
    ]
    for (const [n, params] of refused.entries()) {
      const res = await dispatcher.dispatch(
        { id: `bad-${n}`, method: 'conversation.retry', params },
        UI
      )
      expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(calls).toHaveLength(1)

    const { result } = HOST_METHOD_SCHEMAS['conversation.retry']
    expect(result.safeParse({ ok: true, value: {} }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'not-failed' }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'cannot-receive' }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'session-closed' }).success).toBe(false)
    expect(result.safeParse({ ok: true, value: { messageId: MESSAGE } }).success).toBe(false)
  })

  it('[ADR-019] the A-N06 registry row maps to conversation.retry with the target shape', () => {
    const row = CHANNELS['dwarf:message:retry']
    expect(row).toMatchObject({
      name: 'dwarf:message:retry',
      kind: 'invoke',
      placement: 'host',
      status: 'new'
    })
    // 14 §1.2: a host-placed row relays the seam-B params and result unchanged.
    expect(row.request).toBe(HOST_METHOD_SCHEMAS['conversation.retry'].params)
    expect(row.request.safeParse(PARAMS).success).toBe(true)
    expect(row.request.safeParse({ ...PARAMS, extra: true }).success).toBe(false)
    expect(row.response.safeParse({ ok: true, value: { ok: true, value: {} } }).success).toBe(true)
    expect(
      row.response.safeParse({ ok: true, value: { ok: false, error: 'not-failed' } }).success
    ).toBe(true)
    expect(
      row.response.safeParse({ ok: true, value: { ok: false, error: 'refused' } }).success
    ).toBe(false)
    // 22 §5: its route is the 3a switch's (ISSUE-001), never this handler issue's.
    expect(UNROUTED['dwarf:message:retry']).toBe('cut-3a')
  })

  it('[US-MSG-003.AC01, S7.12] a dwarf that cannot receive and a message that is not failed answer outcomes, not errors', async () => {
    const { dispatcher } = served([
      { ok: false, error: 'cannot-receive' },
      { ok: false, error: 'not-failed' }
    ])
    const first = await dispatcher.dispatch(
      { id: '1', method: 'conversation.retry', params: PARAMS },
      UI
    )
    const second = await dispatcher.dispatch(
      {
        id: '2',
        method: 'conversation.retry',
        params: { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a816d' }
      },
      UI
    )
    expect(first).toMatchObject({ ok: true, result: { ok: false, error: 'cannot-receive' } })
    expect(second).toMatchObject({ ok: true, result: { ok: false, error: 'not-failed' } })
  })

  it('[ADR-022, INV-64] a repeat of the same requestId on the connection answers the first outcome and retries once', async () => {
    const { dispatcher, calls } = served([
      { ok: true, value: undefined },
      { ok: false, error: 'not-failed' }
    ])
    const first = await dispatcher.dispatch(
      { id: '1', method: 'conversation.retry', params: PARAMS },
      UI
    )
    const again = await dispatcher.dispatch(
      { id: '2', method: 'conversation.retry', params: PARAMS },
      UI
    )
    expect(first).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    expect(again).toMatchObject({ ok: true, result: { ok: true, value: {} } })
    expect(calls).toHaveLength(1)
  })

  it('[ADR-003] only a ui connection may retry', async () => {
    const { dispatcher, calls } = served()
    for (const role of ['notifier', 'viewer'] as const) {
      const res = await dispatcher.dispatch(
        { id: role, method: 'conversation.retry', params: PARAMS },
        { role, clientId: `c-${role}` }
      )
      expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(calls).toEqual([])
  })
})
