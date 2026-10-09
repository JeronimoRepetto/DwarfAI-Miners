// layer: L6
// L6 (17 §1.6): A-N31 `setClaudeHooksEnabled` (14 §2.2 NEW, `host`; §3.4 `SetClaudeHooksParams` →
// `IpcResult<SetClaudeHooksResult>`; §3.8; AMENDMENT-7; ADR-016 items 5–7; ADR-019 items 7, 8) as its
// `host` handler serves it, over a faked HostClient: main validates the renderer's payload against
// the registry's request (the same object as B-M39's params, 14 §1.2), mints nothing, and relays
// `preferences.setClaudeHooks` unchanged with the renderer's `requestId`; the two failures arrive as
// outcomes; every answer is checked against the registry's response schema.
//
// TC-221-04 (the A-N31 half).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type SetClaudeHooksResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createSetClaudeHooksRow, SET_CLAUDE_HOOKS } from './setClaudeHooks.host'

const REQUEST = '01920000-0000-7000-a000-000000000221'

/** The HostClient `call` the row uses: records each call and answers the scripted result, or refuses. */
class FakeHooksHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  result: SetClaudeHooksResult = { ok: true, value: { state: 'on-verified' } }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.result as HostResult[M])
  }
}

describe('A-N31 setClaudeHooksEnabled, host handler (14 §2.2, §3.4)', () => {
  it('[ADR-016] setClaudeHooksEnabled round-trips like A-53: the payload is relayed to preferences.setClaudeHooks unchanged and the stored state comes back', async () => {
    const host = new FakeHooksHost()
    const row = createSetClaudeHooksRow(host)
    const response = CHANNELS[SET_CLAUDE_HOOKS].response
    const payload = { on: true, requestId: REQUEST }

    const answer = response.parse(await row.serve(SET_CLAUDE_HOOKS, payload))

    expect(answer).toEqual({ ok: true, value: { ok: true, value: { state: 'on-verified' } } })
    expect(host.calls).toEqual([{ method: 'preferences.setClaudeHooks', params: payload }])

    host.result = { ok: false, error: 'config-revert-failed' }
    expect(
      response.parse(await row.serve(SET_CLAUDE_HOOKS, { on: false, requestId: REQUEST }))
    ).toEqual({ ok: true, value: { ok: false, error: 'config-revert-failed' } })
  })

  it('[ADR-019, ADR-016] an invalid payload, an origin included, never reaches the Host; a Host refusal is the result error branch', async () => {
    const host = new FakeHooksHost()
    const row = createSetClaudeHooksRow(host)
    const response = CHANNELS[SET_CLAUDE_HOOKS].response

    for (const payload of [
      { on: true },
      { on: 'yes', requestId: REQUEST },
      { on: true, origin: 'first-run', requestId: REQUEST },
      true,
      undefined
    ]) {
      expect(response.parse(await row.serve(SET_CLAUDE_HOOKS, payload))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toEqual([])

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(
      response.parse(await row.serve(SET_CLAUDE_HOOKS, { on: true, requestId: REQUEST }))
    ).toEqual({ ok: false, error: host.refusal })
    expect(await row.serve('opencode:plugin:set', { on: true, requestId: REQUEST })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
