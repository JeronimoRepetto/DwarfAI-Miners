// layer: L6
// L6 (17 §1.6): A-35 `launchAgent` / `agent:launch` (14 §2.1 CHANGE, `host`, owner launching; §3.4 `LaunchParams` →
// `IpcResult<LaunchAccepted>`; ADR-020; ADR-019 items 7, 8) as its `host` handler serves it, over a faked HostClient:
// main validates the renderer's payload against the registry's request (the same object as B-M33's params, 14 §1.2)
// and relays `launching.launch` with exactly the parsed params, the Retry path (`retryOf`) included; the Host's
// `LaunchAccepted` is the value, a call error the error branch; every answer is checked against the registry's response
// schema.
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
import { createLaunchAgentRow, LAUNCH_AGENT } from './launchAgent.host'

const MINE = '01920000-0000-7000-a000-000000000351'
const REQUEST = '01920000-0000-7000-a000-000000000352'
const LAUNCH = '01920000-0000-7000-a000-000000000353'
const FAILED_LAUNCH = '01920000-0000-7000-a000-000000000354'

const SUPPLIER_LAUNCH = {
  mineId: MINE,
  way: { kind: 'supplier', providerId: CATALOG_PROVIDER_IDS[0] },
  model: 'opus',
  prompt: 'Survey the north seam',
  jevOn: false,
  jevAutoAccept: false,
  requestId: REQUEST
}

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeLaunchHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = { launchId: LAUNCH }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-35 launchAgent, host handler (14 §2.1, §3.4)', () => {
  it('[ADR-019, ADR-020] A-35 validates LaunchParams in main and relays launching.launch unchanged, the Retry path included', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchAgentRow(host)
    const response = CHANNELS[LAUNCH_AGENT].response
    const retry = { ...SUPPLIER_LAUNCH, retryOf: FAILED_LAUNCH }
    const jevParams = {
      mineId: MINE,
      way: { kind: 'jev' },
      prompt: 'Survey the north seam',
      jevOn: true,
      jevAutoAccept: false,
      requestId: REQUEST
    }

    for (const payload of [SUPPLIER_LAUNCH, retry, jevParams]) {
      expect(response.parse(await row.serve(LAUNCH_AGENT, payload))).toEqual({
        ok: true,
        value: { launchId: LAUNCH }
      })
    }
    expect(host.calls).toEqual([
      { method: 'launching.launch', params: SUPPLIER_LAUNCH },
      { method: 'launching.launch', params: retry },
      { method: 'launching.launch', params: jevParams }
    ])
  })

  it('[ADR-019] a malformed launch is refused INVALID_PARAMS in main and never reaches the Host', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchAgentRow(host)
    const response = CHANNELS[LAUNCH_AGENT].response

    // Today's launch shape, an extra key, a missing requestId, an unknown way and a malformed retry id: none leaves main.
    for (const payload of [
      { projectId: 'p-1', provider: CATALOG_PROVIDER_IDS[0], prompt: 'x' },
      { ...SUPPLIER_LAUNCH, pressEnter: true },
      { ...SUPPLIER_LAUNCH, requestId: undefined },
      { ...SUPPLIER_LAUNCH, way: { kind: 'held' } },
      { ...SUPPLIER_LAUNCH, retryOf: 'launch-1' },
      'launch',
      undefined
    ]) {
      expect(
        response.parse(await row.serve(LAUNCH_AGENT, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toEqual([])
  })

  it('[ADR-020] a Host call error is the error branch, never a throw, and any other channel is refused', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchAgentRow(host)
    const response = CHANNELS[LAUNCH_AGENT].response

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(LAUNCH_AGENT, SUPPLIER_LAUNCH))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('dwarf:stop', SUPPLIER_LAUNCH)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(1)
  })
})
