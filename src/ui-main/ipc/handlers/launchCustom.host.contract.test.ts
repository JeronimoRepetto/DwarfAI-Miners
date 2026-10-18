// layer: L6
// L6 (17 §1.6): A-39 `launchHostedProcess` / `agent:launchHosted` (14 §2.1 CHANGE, `host`, owner launching; §3.4
// `LaunchCustomParams` → `IpcResult<LaunchAccepted>`; ADR-020 item 3; ADR-019 items 7, 8) as its `host` handler serves
// it from step 3d, over a faked HostClient: main validates the renderer's payload against the registry's request (the
// same object as B-M34's params, 14 §1.2) and relays `launching.launchCustom` with exactly the parsed params, the Retry
// path (`retryOf`) included; the Host's `LaunchAccepted` is the value, a call error the error branch. A command the
// parser refuses is not main's to judge: the Host accepts it and settles `launch.failed{could-not-start}` (14 §2.1 A-39
// Notes). Every answer is checked against the registry's response schema.
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
import { createLaunchCustomRow, LAUNCH_CUSTOM } from './launchCustom.host'

const MINE = '01920000-0000-7000-a000-000000000391'
const REQUEST = '01920000-0000-7000-a000-000000000392'
const LAUNCH = '01920000-0000-7000-a000-000000000393'
const FAILED_LAUNCH = '01920000-0000-7000-a000-000000000394'

const CUSTOM_LAUNCH = {
  mineId: MINE,
  command: 'my-agent --once',
  prompt: 'Survey the north seam',
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

describe('A-39 launchHostedProcess, host handler (14 §2.1, §3.4)', () => {
  it('[ADR-019, ADR-020] A-39 validates LaunchCustomParams in main and relays launching.launchCustom unchanged, the Retry path included', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchCustomRow(host)
    const response = CHANNELS[LAUNCH_CUSTOM].response
    const retry = { ...CUSTOM_LAUNCH, retryOf: FAILED_LAUNCH }
    // A shell metacharacter crosses main untouched: the Host's parser refuses it and settles could-not-start.
    const piped = { ...CUSTOM_LAUNCH, command: 'my-agent | tee log' }

    for (const payload of [CUSTOM_LAUNCH, retry, piped]) {
      expect(response.parse(await row.serve(LAUNCH_CUSTOM, payload))).toEqual({
        ok: true,
        value: { launchId: LAUNCH }
      })
    }
    expect(host.calls).toEqual([
      { method: 'launching.launchCustom', params: CUSTOM_LAUNCH },
      { method: 'launching.launchCustom', params: retry },
      { method: 'launching.launchCustom', params: piped }
    ])
  })

  it('[ADR-019] a malformed custom launch is refused INVALID_PARAMS in main and never reaches the Host', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchCustomRow(host)
    const response = CHANNELS[LAUNCH_CUSTOM].response

    // Today's shape (no requestId), an extra key, a non-string command and a malformed retry id: none leaves main.
    for (const payload of [
      { mineId: MINE, command: 'my-agent', prompt: 'x' },
      { ...CUSTOM_LAUNCH, provider: 'other' },
      { ...CUSTOM_LAUNCH, command: ['my-agent'] },
      { ...CUSTOM_LAUNCH, retryOf: 'launch-1' },
      'launch',
      undefined
    ]) {
      expect(
        response.parse(await row.serve(LAUNCH_CUSTOM, payload)),
        JSON.stringify(payload)
      ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    }
    expect(host.calls).toEqual([])
  })

  it('[ADR-020] a Host call error is the error branch, never a throw, and any other channel is refused', async () => {
    const host = new FakeLaunchHost()
    const row = createLaunchCustomRow(host)
    const response = CHANNELS[LAUNCH_CUSTOM].response

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(LAUNCH_CUSTOM, CUSTOM_LAUNCH))).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(await row.serve('agent:launch', CUSTOM_LAUNCH)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(1)
  })
})
