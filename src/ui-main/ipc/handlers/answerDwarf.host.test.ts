// layer: L6
// L6 (17 §1.6): A-40 `answerDwarfQuestion` and A-41 `answerDwarfPermission` (14 §2.1 CHANGE, §3.4
// `AnswerQuestionParams`, `AnswerPermissionParams` → `IpcResult<AnswerOutcome>`; ADR-019 items 7, 8)
// as their `host` handlers serve them, over a faked HostClient: main validates the renderer's
// payload against the registry's target request (the same objects as B-M30's and B-M31's params,
// 14 §1.2), mints nothing, and relays `asking.answerQuestion` / `asking.answerPermission` unchanged
// with the renderer's `requestId`; every answer is checked against the registry's response schema.
//
// TC-128-03 (A-40 / A-41 half).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type AnswerOutcome,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import {
  ANSWER_DWARF_PERMISSION,
  ANSWER_DWARF_QUESTION,
  createAnswerDwarfRows
} from './answerDwarf.host'

const ASK = '01920000-0000-7000-9000-0000000000a5'
const REQUEST = '01920000-0000-7000-a000-000000000001'

/** The HostClient `call` the rows use: records each call and answers the scripted outcome, or refuses. */
class FakeAnswerHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  outcome: AnswerOutcome = { kind: 'accepted' }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.outcome as HostResult[M])
  }
}

describe('A-40 answerDwarfQuestion and A-41 answerDwarfPermission, host handlers (14 §2.1, §3.4)', () => {
  it('[ADR-019] A-40 and A-41 relay the 14 shapes and a not-open outcome reaches the renderer unchanged', async () => {
    const host = new FakeAnswerHost()
    const rows = createAnswerDwarfRows(host)
    const questionResponse = CHANNELS[ANSWER_DWARF_QUESTION].response
    const permissionResponse = CHANNELS[ANSWER_DWARF_PERMISSION].response

    // Each valid payload is relayed unchanged — the renderer's requestId included, nothing minted.
    const question = {
      askId: ASK,
      answers: [
        { step: 0, option: 'Yes' },
        { step: 1, freeText: 'Keep them until Friday' }
      ],
      requestId: REQUEST
    }
    const permission = { askId: ASK, decision: 'deny', requestId: REQUEST }
    expect(questionResponse.parse(await rows.serve(ANSWER_DWARF_QUESTION, question))).toEqual({
      ok: true,
      value: { kind: 'accepted' }
    })
    host.outcome = { kind: 'not-open' }
    expect(permissionResponse.parse(await rows.serve(ANSWER_DWARF_PERMISSION, permission))).toEqual(
      { ok: true, value: { kind: 'not-open' } }
    )
    host.outcome = { kind: 'refused', reason: 'ask-closed' }
    expect(await rows.serve(ANSWER_DWARF_PERMISSION, permission)).toEqual({
      ok: true,
      value: { kind: 'refused', reason: 'ask-closed' }
    })
    expect(host.calls).toEqual([
      { method: 'asking.answerQuestion', params: question },
      { method: 'asking.answerPermission', params: permission },
      { method: 'asking.answerPermission', params: permission }
    ])

    // An invalid payload — today's shapes included — is refused in main and never reaches the Host.
    const relayed = host.calls.length
    for (const [channel, invalid] of [
      [ANSWER_DWARF_PERMISSION, { askId: ASK, decision: 'always', requestId: REQUEST }],
      [ANSWER_DWARF_PERMISSION, { askId: ASK, decision: 'allow' }],
      [ANSWER_DWARF_PERMISSION, { dwarfId: 'claude:s1', toolUseId: 'toolu_02', decision: 'allow' }],
      [ANSWER_DWARF_QUESTION, { askId: ASK, answers: [{ step: 0, option: 'Yes' }] }],
      [
        ANSWER_DWARF_QUESTION,
        { askId: ASK, answers: [{ step: 0, picks: [] }], requestId: REQUEST }
      ],
      [ANSWER_DWARF_QUESTION, { dwarfId: 'claude:s1', toolUseId: 'toolu_01', answers: ['Yes'] }],
      [ANSWER_DWARF_QUESTION, undefined]
    ] as const) {
      const refused = await rows.serve(channel, invalid)
      expect(CHANNELS[channel].response.parse(refused), JSON.stringify(invalid)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toHaveLength(relayed)

    // A Host call error is the result's error branch (14 §1.5), never a throw into the renderer.
    host.refusal = { code: 'TIMEOUT', message: 'no answer in time', retryable: true }
    expect(await rows.serve(ANSWER_DWARF_PERMISSION, permission)).toEqual({
      ok: false,
      error: host.refusal
    })
    host.refusal = null
    expect(await rows.serve('dwarf:feed:page', { dwarfId: ASK })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
