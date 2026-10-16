// layer: L6
// L6 (17 §1.6): A-N29 `stopDwarf` (14 §2.2 NEW, `host`, owner crew; §3.4 `StopDwarfParams` →
// `IpcResult<StopDwarfResult>`; AMENDMENT-2, OQ-54; ADR-014; ADR-019 items 7, 8) as its `host` handler
// serves it, over a faked HostClient: main validates the renderer's payload against the registry's
// request (the same object as B-M21's params, 14 §1.2) and relays `crew.stop` with exactly
// `{ dwarfId, requestId }`; the Host's typed outcome is the value, a call error the error branch; every
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
import { createStopDwarfRow, STOP_DWARF } from './stopDwarf.host'

const DWARF = '01920000-0000-7000-a000-000000000171'
const REQUEST = '01920000-0000-7000-a000-000000000172'

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeStopHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = { ok: true, value: {} }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer as HostResult[M])
  }
}

describe('A-N29 stopDwarf, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-019, US-MSG-008.AC03] A-N29 validates StopDwarfParams in main and relays crew.stop unchanged', async () => {
    const host = new FakeStopHost()
    const row = createStopDwarfRow(host)
    const response = CHANNELS[STOP_DWARF].response

    expect(
      response.parse(await row.serve(STOP_DWARF, { dwarfId: DWARF, requestId: REQUEST }))
    ).toEqual({ ok: true, value: { ok: true, value: {} } })
    expect(host.calls).toEqual([
      { method: 'crew.stop', params: { dwarfId: DWARF, requestId: REQUEST } }
    ])

    // No mode, no other key, no malformed id ever leaves main (OQ-49: nothing interrupts only the turn).
    for (const payload of [
      { dwarfId: DWARF, requestId: REQUEST, mode: 'turn' },
      { dwarfId: DWARF },
      { dwarfId: 'dwarf-1', requestId: REQUEST },
      { dwarfId: DWARF, requestId: 'req-1' },
      1,
      undefined
    ]) {
      expect(
        response.parse(await row.serve(STOP_DWARF, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)
  })

  it('[US-MSG-008.AC07, US-MSG-016.AC02] the Host refusals are the value, a call error is the error branch, never a throw', async () => {
    const host = new FakeStopHost()
    const row = createStopDwarfRow(host)
    const response = CHANNELS[STOP_DWARF].response

    for (const error of ['already-stopping', 'could-not-end'] as const) {
      host.answer = { ok: false, error }
      expect(
        response.parse(await row.serve(STOP_DWARF, { dwarfId: DWARF, requestId: REQUEST }))
      ).toEqual({ ok: true, value: { ok: false, error } })
    }
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(
      response.parse(await row.serve(STOP_DWARF, { dwarfId: DWARF, requestId: REQUEST }))
    ).toEqual({ ok: false, error: host.refusal })
    expect(await row.serve('ask:step:set', { dwarfId: DWARF, requestId: REQUEST })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
