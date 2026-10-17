// layer: L6
// L6 (17 §1.6): A-N08 `renameDwarf` (14 §2.2 NEW, `host`, owner crew; §3.4 `RenameDwarfParams` →
// `IpcResult<RenameDwarfResult>`; AMENDMENT-2, SC-AR-05; ADR-019 items 7, 8) as its `host` handler serves it, over a
// faked HostClient: main validates the renderer's payload against the registry's request (the same object as B-M22's
// params, 14 §1.2) and relays `crew.rename` with exactly `{ dwarfId, name, requestId }`; the Host's typed outcome is
// the value, a call error the error branch; every answer is checked against the registry's response schema.
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
import { createRenameDwarfRow, RENAME_DWARF } from './renameDwarf.host'

const DWARF = '01920000-0000-7000-a000-000000000181'
const REQUEST = '01920000-0000-7000-a000-000000000182'

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeRenameHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = { ok: true, value: { customName: 'Watcher of seals' } }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-N08 renameDwarf, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-019, US-MSG-005.AC02] A-N08 validates RenameDwarfParams in main and relays crew.rename unchanged', async () => {
    const host = new FakeRenameHost()
    const row = createRenameDwarfRow(host)
    const response = CHANNELS[RENAME_DWARF].response
    const name = '  Watcher   of seals '

    expect(
      response.parse(await row.serve(RENAME_DWARF, { dwarfId: DWARF, name, requestId: REQUEST }))
    ).toEqual({ ok: true, value: { ok: true, value: { customName: 'Watcher of seals' } } })
    // The typed text crosses as typed: its normalization is the Host's (16 §4.2).
    expect(host.calls).toEqual([
      { method: 'crew.rename', params: { dwarfId: DWARF, name, requestId: REQUEST } }
    ])

    for (const payload of [
      { dwarfId: DWARF, name: 'Ori', requestId: REQUEST, baseName: 'Borin' },
      { dwarfId: DWARF, name: 'Ori' },
      { dwarfId: 'dwarf-1', name: 'Ori', requestId: REQUEST },
      { dwarfId: DWARF, name: 7, requestId: REQUEST },
      { dwarfId: DWARF, name: 'x'.repeat(257), requestId: REQUEST },
      'Ori',
      undefined
    ]) {
      expect(
        response.parse(await row.serve(RENAME_DWARF, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toHaveLength(1)
  })

  it('[US-MSG-005.AC04] the empty outcome and a reset to the base name are the value, a call error is the error branch, never a throw', async () => {
    const host = new FakeRenameHost()
    const row = createRenameDwarfRow(host)
    const response = CHANNELS[RENAME_DWARF].response
    const payload = { dwarfId: DWARF, name: 'Borin', requestId: REQUEST }

    for (const answer of [
      { ok: false, error: 'empty' },
      { ok: true, value: { customName: null } }
    ]) {
      host.answer = answer
      expect(response.parse(await row.serve(RENAME_DWARF, payload))).toEqual({
        ok: true,
        value: answer
      })
    }
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(RENAME_DWARF, payload))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('dwarf:name:reset', payload)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
