// layer: L6
// L6 (17 §1.6): the A-40 / A-41 dispatch by AskId namespace (21 §3 `LegacyAskRelay`, §3.1 `LegacyAnswerShapeAdapter`,
// §2 cut 2 "Qualified routes": the qualifier is decided by the AskId namespace, never by guessing; 14 §8 I-11). A
// `legacy:` AskId goes to the legacy shape adapter and never to `asking.*`; any other id goes to the `host` handler of
// ISSUE-128 and never to the legacy runtime. The `host` side is the real `createAnswerDwarfRows` over a faked
// HostClient; the legacy side is a recording `RouteTarget` (the shape adapter lives in src/legacy-bridge, which only
// the composition roots may import, R16).
//
// TC-137-01. The recorded observed-Codex case (TC-137-03) composes this dispatch with the real relay and adapter, so
// it lives in src/legacy-bridge/LegacyAskRelay.answer.test.ts (R16 forbids this file from importing the bridge).
import { describe, expect, it } from 'vitest'
import {
  askIdSchema,
  isUuidV7,
  type AnswerOutcome,
  type HostMethod,
  type HostParams,
  type HostResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'
import {
  ANSWER_DWARF_PERMISSION,
  ANSWER_DWARF_QUESTION,
  createAnswerDwarfRows
} from './answerDwarf.host'
import { createAnswerDwarfDispatch, isLegacyAskId } from './answerDwarf.dispatch'

const HOST_ASK = '01920000-0000-7000-9000-0000000000a5'
const REQUEST = '01920000-0000-7000-a000-000000000001'
/** Today's ask ids: a Claude `tool_use` id, and a Codex call id that happens to be a UUIDv7. */
const LEGACY_CLAUDE = 'legacy:toolu_01AbCdEfGhIjKlMnOpQrStUv'
const LEGACY_CODEX = 'legacy:0199aa00-0000-7000-8000-0000000a5c01'

/** The HostClient `call` the host rows use: records each call and answers `accepted`. */
class FakeAnswerHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    return Promise.resolve({ kind: 'accepted' } as HostResult[M])
  }
}

/** The legacy shape adapter's seat: records each call it is handed. */
class RecordingLegacyTarget implements RouteTarget {
  readonly served: Array<[string, unknown]> = []

  serve(channel: string, payload: unknown): Promise<unknown> {
    this.served.push([channel, payload])
    return Promise.resolve({ ok: true, value: { kind: 'accepted' } satisfies AnswerOutcome })
  }
}

function world() {
  const host = new FakeAnswerHost()
  const legacy = new RecordingLegacyTarget()
  const dispatch = createAnswerDwarfDispatch({ host: createAnswerDwarfRows(host), legacy })
  return { host, legacy, dispatch }
}

describe('A-40 / A-41 dispatch by AskId namespace (21 §3, §3.1; 14 §8 I-11)', () => {
  it('[ADR-001] a legacy: AskId never reaches asking.answerQuestion or asking.answerPermission', async () => {
    const { host, legacy, dispatch } = world()
    const question = {
      askId: LEGACY_CODEX,
      answers: [{ step: 0, option: 'develop' }],
      requestId: REQUEST
    }
    const permission = { askId: LEGACY_CLAUDE, decision: 'allow', requestId: REQUEST }

    await dispatch.serve(ANSWER_DWARF_QUESTION, question)
    await dispatch.serve(ANSWER_DWARF_PERMISSION, permission)

    // Each reaches the legacy seat unchanged (the renderer's requestId included, nothing minted)…
    expect(legacy.served).toEqual([
      [ANSWER_DWARF_QUESTION, question],
      [ANSWER_DWARF_PERMISSION, permission]
    ])
    // …and the Host is never called, even for the Codex id whose tail is a UUIDv7.
    expect(host.calls).toEqual([])
  })

  it('[ADR-001] a Host AskId never reaches the legacy runtime', async () => {
    const { host, legacy, dispatch } = world()
    const question = {
      askId: HOST_ASK,
      answers: [{ step: 0, freeText: 'Keep them until Friday' }],
      requestId: REQUEST
    }
    const permission = { askId: HOST_ASK, decision: 'deny', requestId: REQUEST }

    expect(await dispatch.serve(ANSWER_DWARF_QUESTION, question)).toEqual({
      ok: true,
      value: { kind: 'accepted' }
    })
    await dispatch.serve(ANSWER_DWARF_PERMISSION, permission)
    // The host handler relays the renderer's payload unchanged: its requestId is relayed, never minted.
    expect(host.calls).toEqual([
      { method: 'asking.answerQuestion', params: question },
      { method: 'asking.answerPermission', params: permission }
    ])

    // An id outside the namespace that is no Host id either is the host handler's to refuse, never legacy's.
    for (const askId of [
      'toolu_01AbCdEfGhIjKlMnOpQrStUv',
      'LEGACY:toolu_1',
      'x-legacy:toolu_1',
      7
    ]) {
      expect(
        await dispatch.serve(ANSWER_DWARF_PERMISSION, {
          askId,
          decision: 'allow',
          requestId: REQUEST
        })
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(await dispatch.serve(ANSWER_DWARF_QUESTION, null)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' }
    })
    expect(legacy.served).toEqual([])
    expect(host.calls).toHaveLength(2)
  })

  it('[ADR-001] a legacy: id cannot be a valid UUIDv7, so the two namespaces never collide', () => {
    // A legacy id is in the namespace even when today's id is itself a UUIDv7 (a Codex call id)…
    for (const askId of [LEGACY_CLAUDE, LEGACY_CODEX]) {
      expect(isLegacyAskId(askId)).toBe(true)
      expect(isUuidV7(askId)).toBe(false)
      expect(askIdSchema.safeParse(askId).success).toBe(false)
    }
    // …and a Host AskId, always a UUIDv7, never is.
    expect(isUuidV7(HOST_ASK)).toBe(true)
    expect(isLegacyAskId(HOST_ASK)).toBe(false)
    // The bare prefix names no legacy ask.
    expect(isLegacyAskId('legacy:')).toBe(false)
  })
})
