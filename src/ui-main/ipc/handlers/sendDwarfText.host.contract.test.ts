// layer: L6
// L6 (17 §1.6): A-23 `sendDwarfText` / `dwarf:sendText` (14 §2.1 CHANGE, `host`, owner conversation; §3.4
// `SendMessageParams` → `IpcResult<SendMessageResult>`; ADR-022; ADR-019 items 7, 8) as its `host` handler serves it,
// over a faked HostClient: main validates the renderer's payload against the registry's request (the same object as
// B-M24's params, 14 §1.2) and relays `conversation.send` with exactly `{ dwarfId, text, attachments, requestId }`; the
// Host's outcome is the value (the marks arrive as `message.delivery` frames), a call error the error branch; every
// answer is checked against the registry's response schema.
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
import { createSendDwarfTextRow, SEND_DWARF_TEXT } from './sendDwarfText.host'

const DWARF = '01920000-0000-7000-a000-000000000231'
const REQUEST = '01920000-0000-7000-a000-000000000232'
const MESSAGE = '01920000-0000-7000-a000-000000000233'
const ATTACHMENT = 'C:/work/north-seam.png'

const SEND = {
  dwarfId: DWARF,
  text: 'Dig the north seam',
  attachments: [ATTACHMENT],
  requestId: REQUEST
}

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeSendHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = { ok: true, value: { messageId: MESSAGE } }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-23 sendDwarfText, host handler (14 §2.1, §3.4)', () => {
  it('[ADR-019, ADR-022] A-23 validates SendMessageParams in main and relays conversation.send unchanged', async () => {
    const host = new FakeSendHost()
    const row = createSendDwarfTextRow(host)
    const response = CHANNELS[SEND_DWARF_TEXT].response

    expect(response.parse(await row.serve(SEND_DWARF_TEXT, SEND))).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MESSAGE } }
    })
    expect(host.calls).toEqual([{ method: 'conversation.send', params: SEND }])

    // Today's `pressEnter` and `holdId`, a missing requestId and a malformed dwarf id never leave main.
    for (const payload of [
      { ...SEND, pressEnter: true },
      { ...SEND, holdId: 'hold-1' },
      { dwarfId: DWARF, text: 'Dig', attachments: [] },
      { ...SEND, dwarfId: 'dwarf-1' },
      'Dig the north seam',
      undefined
    ]) {
      expect(
        response.parse(await row.serve(SEND_DWARF_TEXT, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)
  })

  it('[US-MSG-001.AC11, ADR-022] the Host outcomes are the value, a call error is the error branch, never a throw', async () => {
    const host = new FakeSendHost()
    const row = createSendDwarfTextRow(host)
    const response = CHANNELS[SEND_DWARF_TEXT].response

    for (const error of ['cannot-receive', 'attachment-refused'] as const) {
      host.answer = { ok: false, error }
      expect(response.parse(await row.serve(SEND_DWARF_TEXT, SEND))).toEqual({
        ok: true,
        value: { ok: false, error }
      })
    }
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(SEND_DWARF_TEXT, SEND))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('dwarf:message:retry', SEND)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(3)
  })
})
