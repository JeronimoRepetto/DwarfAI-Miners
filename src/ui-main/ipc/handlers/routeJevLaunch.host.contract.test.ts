// layer: L6
// L6 (17 §1.6): A-50 `routeJevLaunch` (14 §2.2 CHANGE, `host`, owner jev; §3.4 `JevSuggestParams`,
// `JevSuggestResult`) as its `host` handler serves it, over a faked HostClient: main validates the
// renderer's `JevSuggestParams` against the registry's request and relays `jev.suggest` (B-M38)
// unchanged; every answer is checked against the registry's response schema (14 §1.4).
//
// TC-192-01 (the A-50 half: the card the Host answered reaches the renderer unchanged).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type JevSuggestResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createRouteJevLaunchRow, ROUTE_JEV_LAUNCH } from './routeJevLaunch.host'

const MINE = '01920000-0000-7000-9000-0000000000f1'
const SUGGESTION: JevSuggestResult = {
  ok: true,
  value: {
    providerId: 'claude',
    model: 'sonnet',
    effort: 'high',
    tier: 'balanced',
    confidence: { providerId: 0.91, tier: 0.88 },
    truncated: false,
    parts: { providerId: 'answered', model: 'answered', effort: 'answered', tier: 'answered' }
  }
}

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeJevHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: JevSuggestResult = SUGGESTION
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-50 routeJevLaunch, host handler (14 §2.2, §3.4)', () => {
  it('[US-LAUNCH-003.AC02] routeJevLaunch relays jev.suggest and returns its result unchanged in an IpcResult', async () => {
    const host = new FakeJevHost()
    const row = createRouteJevLaunchRow(host)
    const response = CHANNELS[ROUTE_JEV_LAUNCH].response
    const request = { prompt: 'add a field to this form', mineId: MINE }

    const answer = await row.serve(ROUTE_JEV_LAUNCH, request)
    expect(host.calls).toEqual([{ method: 'jev.suggest', params: request }])
    expect(response.parse(answer)).toEqual({ ok: true, value: SUGGESTION })

    // A Jev outcome that is not a suggestion is relayed unchanged too: it is the result, not an error.
    host.answer = { ok: false, error: 'jev-could-not-choose' }
    expect(response.parse(await row.serve(ROUTE_JEV_LAUNCH, request))).toEqual({
      ok: true,
      value: { ok: false, error: 'jev-could-not-choose' }
    })
  })

  it('[ADR-019] invalid params are refused in main and never reach the Host; a Host call error is the error branch', async () => {
    const host = new FakeJevHost()
    const row = createRouteJevLaunchRow(host)
    const response = CHANNELS[ROUTE_JEV_LAUNCH].response

    for (const invalid of [
      { prompt: 'which model' },
      { prompt: 7, mineId: MINE },
      { prompt: 'which model', mineId: MINE, extra: 1 },
      'which model',
      null,
      undefined
    ]) {
      const refused = await row.serve(ROUTE_JEV_LAUNCH, invalid)
      expect(response.parse(refused), JSON.stringify(invalid)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toEqual([])

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(
      response.parse(await row.serve(ROUTE_JEV_LAUNCH, { prompt: 'which model', mineId: MINE }))
    ).toEqual({ ok: false, error: host.refusal })

    // Any other channel is refused, never guessed (14 §1.5).
    expect(await row.serve('mine:history', MINE)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
