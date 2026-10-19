// layer: L6
// L6 (17 §1.6): B-M24 `conversation.send` (14 §2.3, §3.4 `SendMessageParams` / `SendMessageResult`,
// frozen; ADR-019 runtime validation; 14 §1.6 durable dedupe; 14 §1.7 answer at acceptance) through
// the seam-B dispatcher, over a faked `ConversationCommands.send`.
import { describe, expect, it } from 'vitest'
import { HOST_METHOD_SCHEMAS } from '@dwarfai/contracts'
import type { DwarfId, MessageId, Result } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RequestIdOfAnotherDwarfError } from '../../modules/conversation'
import { Dispatcher } from '../dispatcher'
import { registerConversationSend } from './conversationSend'

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8166'
const DWARF = '01890a5d-ac96-774b-bcce-b302099a80d1' as DwarfId
const MESSAGE = '01890a5d-ac96-774b-bcce-b302099a80a1' as MessageId
const UI = { role: 'ui' as const, clientId: 'c-ui' }
const TEXT = 'dig the north seam'
const PARAMS = { dwarfId: DWARF, text: TEXT, attachments: [], requestId: REQUEST_ID }

type SendAnswer = Result<MessageId, 'cannot-receive' | 'attachment-refused'> | Error

function served(answer: SendAnswer = { ok: true, value: MESSAGE }) {
  const clock = new FakeClock(1_790_000_000_000)
  const log = new RecordingDiagnosticsLog()
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const calls: unknown[][] = []
  registerConversationSend(dispatcher, {
    conversation: {
      send: async (...args) => {
        calls.push(args)
        if (answer instanceof Error) throw answer
        return answer
      }
    }
  })
  return { dispatcher, calls, log }
}

describe('conversation.send params and result (14 §3.4, B-M24)', () => {
  it('[ADR-019] conversation.send params are strict', async () => {
    const { dispatcher, calls } = served()
    const ok = await dispatcher.dispatch(
      { id: '1', method: 'conversation.send', params: PARAMS },
      UI
    )
    expect(ok).toMatchObject({ ok: true, result: { ok: true, value: { messageId: MESSAGE } } })
    expect(calls).toEqual([[DWARF, TEXT, [], REQUEST_ID]])

    const refused = [
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8167', pressEnter: true },
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8168', holdId: 'h-1' },
      { dwarfId: DWARF, text: 'no request id', attachments: [] },
      { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8169', text: 'x'.repeat(65_537) }
    ]
    for (const [n, params] of refused.entries()) {
      const res = await dispatcher.dispatch(
        { id: `bad-${n}`, method: 'conversation.send', params },
        UI
      )
      expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(calls).toHaveLength(1)
  })

  it('[US-MSG-001.AC11, INV-33] a dwarf that cannot receive answers the cannot-receive outcome, not an error', async () => {
    const { dispatcher } = served({ ok: false, error: 'cannot-receive' })
    const res = await dispatcher.dispatch(
      { id: '1', method: 'conversation.send', params: PARAMS },
      UI
    )
    expect(res).toMatchObject({ ok: true, result: { ok: false, error: 'cannot-receive' } })
  })

  it('[ADR-022] a repeat of the same requestId on the connection answers the first outcome and sends once', async () => {
    const { dispatcher, calls } = served()
    const first = await dispatcher.dispatch(
      { id: '1', method: 'conversation.send', params: PARAMS },
      UI
    )
    const again = await dispatcher.dispatch(
      { id: '2', method: 'conversation.send', params: PARAMS },
      UI
    )
    expect(first).toMatchObject({ ok: true, result: { ok: true, value: { messageId: MESSAGE } } })
    expect(again).toMatchObject({ ok: true, result: { ok: true, value: { messageId: MESSAGE } } })
    expect(calls).toHaveLength(1)
  })

  it('[ADR-022, ADR-019] a requestId that belongs to another dwarf is refused INVALID_PARAMS, never answered with that message', async () => {
    const { dispatcher } = served(new RequestIdOfAnotherDwarfError())
    const res = await dispatcher.dispatch(
      { id: '1', method: 'conversation.send', params: PARAMS },
      UI
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', retryable: false } })
  })

  it('[ADR-003] only a ui connection may send, and the text never reaches the log', async () => {
    const { dispatcher, calls, log } = served()
    for (const role of ['notifier', 'viewer'] as const) {
      const res = await dispatcher.dispatch(
        { id: role, method: 'conversation.send', params: PARAMS },
        { role, clientId: `c-${role}` }
      )
      expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(calls).toEqual([])
    await dispatcher.dispatch({ id: '3', method: 'conversation.send', params: PARAMS }, UI)
    expect(JSON.stringify(log.entries)).not.toContain(TEXT)
  })

  it('[ADR-019] the B-M24 result schema refuses any other outcome', () => {
    const { result } = HOST_METHOD_SCHEMAS['conversation.send']
    expect(result.safeParse({ ok: true, value: { messageId: MESSAGE } }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'attachment-refused' }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: 'session-closed' }).success).toBe(false)
    expect(
      result.safeParse({ ok: true, value: { messageId: MESSAGE, phase: 'sending' } }).success
    ).toBe(false)
  })
})
