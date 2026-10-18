// layer: L6
// L6 (17 §1.6): A-N06 `retryDwarfMessage` / `dwarf:message:retry` (14 §2.2 NEW, `host`, owner conversation;
// `RetryMessageParams` → `IpcResult<RetryMessageResult>`; ADR-022 item 5; ADR-019 items 7, 8) as its `host` handler
// serves it, over a faked HostClient: main validates the renderer's payload against the registry's request (the same
// object as B-M25's params, 14 §1.2) and relays `conversation.retry` with exactly `{ messageId, requestId }`; the Host's
// outcome is the value, a call error the error branch; every answer is checked against the registry's response schema.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createRetryDwarfMessageRow, RETRY_DWARF_MESSAGE } from './retryDwarfMessage.host'

const MESSAGE = '01920000-0000-7000-a000-000000000061'
const REQUEST = '01920000-0000-7000-a000-000000000062'

const RETRY = { messageId: MESSAGE, requestId: REQUEST }

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeRetryHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = { ok: true, value: {} }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-N06 retryDwarfMessage, host handler (14 §2.2)', () => {
  it('[ADR-019, ADR-022] A-N06 validates RetryMessageParams in main and relays conversation.retry unchanged', async () => {
    const host = new FakeRetryHost()
    const row = createRetryDwarfMessageRow(host)
    const response = CHANNELS[RETRY_DWARF_MESSAGE].response

    expect(response.parse(await row.serve(RETRY_DWARF_MESSAGE, RETRY))).toEqual({
      ok: true,
      value: { ok: true, value: {} }
    })
    expect(host.calls).toEqual([{ method: 'conversation.retry', params: RETRY }])

    // A new text, a missing requestId and a malformed message id never leave main: a retry resends the same message.
    for (const payload of [
      { ...RETRY, text: 'again' },
      { messageId: MESSAGE },
      { ...RETRY, messageId: 'message-1' },
      [MESSAGE],
      undefined
    ]) {
      expect(
        response.parse(await row.serve(RETRY_DWARF_MESSAGE, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)
  })

  it('[US-MSG-003.AC01] the Host outcomes are the value, a call error is the error branch, never a throw', async () => {
    const host = new FakeRetryHost()
    const row = createRetryDwarfMessageRow(host)
    const response = CHANNELS[RETRY_DWARF_MESSAGE].response

    for (const error of ['cannot-receive', 'not-failed'] as const) {
      host.answer = { ok: false, error }
      expect(response.parse(await row.serve(RETRY_DWARF_MESSAGE, RETRY))).toEqual({
        ok: true,
        value: { ok: false, error }
      })
    }
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(RETRY_DWARF_MESSAGE, RETRY))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('dwarf:sendText', RETRY)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(3)
  })
})
