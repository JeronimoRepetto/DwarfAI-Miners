// layer: L6
// L6 (17 §1.6): A-36 `listAgentProviders` / `agent:providers` (14 §2.1 CHANGE, `host`, owner suppliers; §3.6
// `{ refresh?: boolean }` → `IpcResult<SupplierEntryView[]>`; ADR-009 D5, D6; ADR-019 items 7, 8) as its `host` handler
// serves it from step 4b, over a faked HostClient: with every catalog provider moved there is no provider left for
// `CatalogMergeAdapter` (21 §2 cut 4b; §3.1), so the renderer's one catalog call is relayed as `suppliers.launchable`
// (B-M37) with exactly the parsed params and answered with the Host's entries unchanged; a call error is the error
// branch; every answer is checked against the registry's response schema.
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createListAgentProvidersRow, LIST_AGENT_PROVIDERS } from './listAgentProviders.host'

const entry = (providerId: string, answerChannel: 'available' | 'gated-off' = 'available') => ({
  providerId,
  label: providerId,
  models: [{ value: 'default', efforts: ['high'] }],
  permissionModes: ['default'],
  offeredModes: ['default'],
  installed: true,
  publicLaunch: 'enabled',
  answerChannel
})

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeSuppliersHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = CATALOG_PROVIDER_IDS.map((id) => entry(id))
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-36 listAgentProviders, host handler (14 §2.1, §3.6; 21 §2 cut 4b)', () => {
  it('[ADR-009, ADR-019] A-36 relays suppliers.launchable with the parsed params and answers the Host entries unchanged', async () => {
    const host = new FakeSuppliersHost()
    // The Host's own entry of a provider whose answer channel is gated off (ADR-011 item 7): passed through as is.
    host.answer = [
      entry(CATALOG_PROVIDER_IDS[0] ?? ''),
      entry(CATALOG_PROVIDER_IDS[3] ?? '', 'gated-off')
    ]
    const row = createListAgentProvidersRow(host)
    const response = CHANNELS[LIST_AGENT_PROVIDERS].response

    const listed = await row.serve(LIST_AGENT_PROVIDERS, { refresh: true })
    expect(response.parse(listed)).toEqual({ ok: true, value: host.answer })
    const plain = await row.serve(LIST_AGENT_PROVIDERS, {})
    expect(response.parse(plain)).toEqual({ ok: true, value: host.answer })
    expect(host.calls).toEqual([
      { method: 'suppliers.launchable', params: { refresh: true } },
      { method: 'suppliers.launchable', params: {} }
    ])
  })

  it('[ADR-019] an invalid A-36 payload never reaches the Host, and another channel is refused', async () => {
    const host = new FakeSuppliersHost()
    const row = createListAgentProvidersRow(host)
    const response = CHANNELS[LIST_AGENT_PROVIDERS].response
    const invalid = await row.serve(LIST_AGENT_PROVIDERS, { refresh: 'yes' })
    expect(response.parse(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    const other = await row.serve('agent:launch', {})
    expect(other).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_FOUND' } })
    expect(host.calls).toEqual([])
  })

  it('[ADR-019] a Host call error is the result error branch, never a throw', async () => {
    const host = new FakeSuppliersHost()
    host.refusal = { code: 'HOST_UNAVAILABLE', message: 'no Host', retryable: true }
    const row = createListAgentProvidersRow(host)
    const answer = await row.serve(LIST_AGENT_PROVIDERS, {})
    expect(CHANNELS[LIST_AGENT_PROVIDERS].response.parse(answer)).toEqual({
      ok: false,
      error: { code: 'HOST_UNAVAILABLE', message: 'no Host', retryable: true }
    })
  })
})
