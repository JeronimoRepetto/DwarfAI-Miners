// layer: L6
// L6 (17 §1.6): A-N32 `answerWelcome` (14 §2.2 NEW, `host`; §3.4 `AnswerWelcomeParams` →
// `IpcResult<AnswerWelcomeResult>`; §3.8; §3.10; AMENDMENT-7; ADR-016 item 5; ADR-019 items 7, 8)
// as its `host` handler serves it, over a faked HostClient: main validates the renderer's payload
// against the registry's request (the same object as B-M40's params, 14 §1.2), mints nothing, and
// relays `preferences.answerWelcome` unchanged with the renderer's `requestId`; a per-integration
// failure arrives inside the result; every answer is checked against the registry's response schema.
//
// TC-223-01 (the A-N32 half). Its L9 case moved with A-N32's route to the cut-2 switch (later:
// ISSUE-141).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type AnswerWelcomeResult,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { ANSWER_WELCOME, createAnswerWelcomeRow } from './answerWelcome.host'

const REQUEST = '01920000-0000-7000-a000-000000000223'
const SETTLED = { due: false, legacyFound: [], offered: ['claude-hooks' as const] }

/** The HostClient `call` the row uses: records each call and answers the scripted result, or refuses. */
class FakeWelcomeHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  result: AnswerWelcomeResult = {
    integrations: {
      'claude-hooks': { state: 'on-verified' },
      'opencode-permissions': { state: 'off' }
    },
    welcome: SETTLED
  }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.result as HostResult[M])
  }
}

describe('A-N32 answerWelcome, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-016] answerWelcome relays the ticks to preferences.answerWelcome unchanged and the settled step comes back, a failure inside the result', async () => {
    const host = new FakeWelcomeHost()
    const row = createAnswerWelcomeRow(host)
    const response = CHANNELS[ANSWER_WELCOME].response
    const payload = { claudeHooks: true, openCodePermissions: false, requestId: REQUEST }

    const answer = response.parse(await row.serve(ANSWER_WELCOME, payload))

    expect(answer).toEqual({ ok: true, value: host.result })
    expect(host.calls).toEqual([{ method: 'preferences.answerWelcome', params: payload }])

    host.result = {
      integrations: {
        'claude-hooks': { state: 'off', failure: 'config-revert-failed' },
        'opencode-permissions': { state: 'off' }
      },
      welcome: SETTLED
    }
    const notNow = { claudeHooks: false, openCodePermissions: false, requestId: REQUEST }
    expect(response.parse(await row.serve(ANSWER_WELCOME, notNow))).toEqual({
      ok: true,
      value: host.result
    })
  })

  it('[ADR-019, ADR-016] an invalid payload, an origin included, never reaches the Host; a Host refusal is the result error branch', async () => {
    const host = new FakeWelcomeHost()
    const row = createAnswerWelcomeRow(host)
    const response = CHANNELS[ANSWER_WELCOME].response

    for (const payload of [
      { claudeHooks: true, openCodePermissions: false },
      { claudeHooks: true, requestId: REQUEST },
      { claudeHooks: 'yes', openCodePermissions: false, requestId: REQUEST },
      { claudeHooks: true, openCodePermissions: false, origin: 'first-run', requestId: REQUEST },
      true,
      undefined
    ]) {
      expect(response.parse(await row.serve(ANSWER_WELCOME, payload))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toEqual([])

    host.refusal = { code: 'TIMEOUT', message: 'no answer in 30 s', retryable: true }
    const ticks = { claudeHooks: true, openCodePermissions: true, requestId: REQUEST }
    expect(response.parse(await row.serve(ANSWER_WELCOME, ticks))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('claude:hooks:set', { on: true, requestId: REQUEST })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
