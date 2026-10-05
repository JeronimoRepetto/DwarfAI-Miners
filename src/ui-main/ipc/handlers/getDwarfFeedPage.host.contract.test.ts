// layer: L6
// L6 (17 §1.6): A-15 `getDwarfFeedPage` (14 §2.1 CHANGE, §3.6 `FeedParams` → `IpcResult<FeedPage>`,
// §3.8; ADR-019 items 7, 8) as its `host` handler serves it, over a faked HostClient: main validates
// the renderer's payload against the registry's target request (the same object as B-M26's params,
// 14 §1.2) and relays `conversation.feed` unchanged; every answer is checked against the registry's
// response schema (14 §1.4).
//
// TC-103-03.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type FeedPage,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createGetDwarfFeedPageRow, GET_DWARF_FEED_PAGE } from './getDwarfFeedPage.host'

const DWARF = '01920000-0000-7000-9000-00000000000a'
const MESSAGE = '01920000-0000-7000-a000-000000000001'

const PAGE: FeedPage = {
  dwarfId: DWARF,
  messages: [
    {
      id: MESSAGE,
      dwarfId: DWARF,
      role: 'dwarf',
      text: 'older line',
      attachments: [],
      providerTime: 1_000,
      createdAt: 1_001
    }
  ],
  reachedStart: true
} as unknown as FeedPage

/** The HostClient `call` the row uses: records each call and answers the page, or refuses. */
class FakeFeedHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(PAGE as HostResult[M])
  }
}

describe('A-15 getDwarfFeedPage, host handler (14 §2.1, §3.6)', () => {
  it('[ADR-019] A-15 validates FeedParams in main and relays conversation.feed; an invalid payload never reaches the Host', async () => {
    const host = new FakeFeedHost()
    const row = createGetDwarfFeedPageRow(host)
    const response = CHANNELS[GET_DWARF_FEED_PAGE].response

    // A valid payload is relayed unchanged as the B-M26 params, and the page comes back as IpcResult<FeedPage>.
    const payload = { dwarfId: DWARF, page: { before: MESSAGE, limit: 20 } }
    const answer = await row.serve(GET_DWARF_FEED_PAGE, payload)
    expect(host.calls).toEqual([{ method: 'conversation.feed', params: payload }])
    expect(response.parse(answer)).toEqual({ ok: true, value: PAGE })
    expect(await row.serve(GET_DWARF_FEED_PAGE, { dwarfId: DWARF })).toEqual({
      ok: true,
      value: PAGE
    })

    // An invalid payload — today's shape included — is refused in main and never reaches the Host.
    const relayed = host.calls.length
    for (const invalid of [
      { dwarfId: DWARF, page: { limit: 51 } },
      { dwarfId: DWARF, page: { before: 7 } },
      { dwarfId: DWARF, extra: true },
      { dwarfId: 'claude:s1', before: MESSAGE },
      undefined,
      'not-an-object'
    ]) {
      const refused = await row.serve(GET_DWARF_FEED_PAGE, invalid)
      expect(response.parse(refused), JSON.stringify(invalid)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toHaveLength(relayed)

    // A Host call error is the result's error branch (14 §1.5), never a throw into the renderer.
    host.refusal = { code: 'FORBIDDEN', message: 'outside the role scope', retryable: false }
    expect(await row.serve(GET_DWARF_FEED_PAGE, { dwarfId: DWARF })).toEqual({
      ok: false,
      error: host.refusal
    })
    host.refusal = null
    expect(await row.serve('mine:history', DWARF)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
