// layer: L6
// L6 (17 §1.6): A-N07 `setAskStep` (14 §2.2 NEW, `host`; §3.4 `SetAskStepParams` → `IpcResult<void>`;
// §3.8; OQ-03, PO #92; ADR-010 item 9; ADR-019 items 7, 8) as its `host` handler serves it, over a
// faked HostClient: main validates the renderer's payload against the registry's request (the same
// object as B-M32's params, 14 §1.2) and relays `asking.setStep` with `{ askId, step }` only — no
// requestId, never a pick; every answer is checked against the registry's response schema.
//
// TC-129-03.
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
import { createSetAskStepRow, SET_ASK_STEP } from './setAskStep.host'

const ASK = '01920000-0000-7000-a000-000000000129'

/** The HostClient `call` the row uses: records each call and answers `{}`, or refuses. */
class FakeStepHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve({} as HostResult[M])
  }
}

describe('A-N07 setAskStep, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-019] A-N07 validates SetAskStepParams in main and carries no picks', async () => {
    const host = new FakeStepHost()
    const row = createSetAskStepRow(host)
    const response = CHANNELS[SET_ASK_STEP].response

    // A valid step reaches the Host as exactly `{ askId, step }` (TC-129-03).
    expect(response.parse(await row.serve(SET_ASK_STEP, { askId: ASK, step: 2 }))).toEqual({
      ok: true
    })
    expect(host.calls).toEqual([{ method: 'asking.setStep', params: { askId: ASK, step: 2 } }])

    // Picks, a requestId, a negative or non-integer step never leave main (OQ-03; 14 §3.4).
    for (const payload of [
      { askId: ASK, step: 1, picks: [{ step: 0, option: 'All' }] },
      { askId: ASK, step: 1, answers: [{ step: 0, option: 'All' }] },
      { askId: ASK, step: 1, requestId: '01920000-0000-7000-a000-00000000012a' },
      { askId: ASK, step: -1 },
      { askId: ASK, step: 0.5 },
      { askId: 'ask-1', step: 1 },
      { askId: ASK },
      1,
      undefined
    ]) {
      expect(
        response.parse(await row.serve(SET_ASK_STEP, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)

    // A Host call error is the result's error branch, never a throw into the renderer (14 §1.5).
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(SET_ASK_STEP, { askId: ASK, step: 1 }))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('claude:hooks:set', { askId: ASK, step: 1 })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
