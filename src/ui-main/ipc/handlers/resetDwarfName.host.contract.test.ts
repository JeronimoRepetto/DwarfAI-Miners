// layer: L6
// L6 (17 §1.6): A-N09 `resetDwarfName` (14 §2.2 NEW, `host`, owner crew; §3.4 `ResetDwarfNameParams` →
// `IpcResult<void>`; ADR-019 items 7, 8) as its `host` handler serves it, over a faked HostClient: main validates the
// renderer's payload against the registry's request (the same object as B-M23's params, 14 §1.2) and relays
// `crew.resetName` with exactly `{ dwarfId, requestId }`; B-M23's `{}` is the void value, a call error the error
// branch; every answer is checked against the registry's response schema.
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
import { createResetDwarfNameRow, RESET_DWARF_NAME } from './resetDwarfName.host'

const DWARF = '01920000-0000-7000-a000-000000000191'
const REQUEST = '01920000-0000-7000-a000-000000000192'

/** The HostClient `call` the row uses: records each call and answers `{}`, or refuses. */
class FakeResetHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve({} as HostResult[M])
  }
}

describe('A-N09 resetDwarfName, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-019, US-MSG-006.AC03] A-N09 validates ResetDwarfNameParams in main and relays crew.resetName unchanged', async () => {
    const host = new FakeResetHost()
    const row = createResetDwarfNameRow(host)
    const response = CHANNELS[RESET_DWARF_NAME].response

    const answer = response.parse(
      await row.serve(RESET_DWARF_NAME, { dwarfId: DWARF, requestId: REQUEST })
    )
    expect(answer).toEqual({ ok: true, value: undefined })
    expect(host.calls).toEqual([
      { method: 'crew.resetName', params: { dwarfId: DWARF, requestId: REQUEST } }
    ])

    for (const payload of [
      { dwarfId: DWARF, requestId: REQUEST, name: '' },
      { dwarfId: DWARF },
      { dwarfId: 'dwarf-1', requestId: REQUEST },
      DWARF,
      undefined
    ]) {
      expect(
        response.parse(await row.serve(RESET_DWARF_NAME, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)
  })

  it('[US-MSG-006.AC03] a call error is the error branch, never a throw', async () => {
    const host = new FakeResetHost()
    const row = createResetDwarfNameRow(host)
    const response = CHANNELS[RESET_DWARF_NAME].response
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }

    expect(
      response.parse(await row.serve(RESET_DWARF_NAME, { dwarfId: DWARF, requestId: REQUEST }))
    ).toEqual({ ok: false, error: host.refusal })
    expect(await row.serve('dwarf:rename', { dwarfId: DWARF, requestId: REQUEST })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
