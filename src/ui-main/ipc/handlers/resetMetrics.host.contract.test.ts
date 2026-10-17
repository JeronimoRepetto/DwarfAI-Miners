// layer: L6
// L6 (17 §1.6): A-33 `resetMetrics` / `metrics:reset` (14 §2.1 row A-33, `host` + `target` from 4a;
// §3.4 `ResetMetricsParams` → `IpcResult<MetricsResetResult>`; ADR-019; ADR-023 items 4–5) as its
// `host` handler serves it, over a faked HostClient: main validates the renderer's payload with the
// registry's strict schema, relays `preferences.resetMetrics` (B-M15) unchanged on the `ui`
// connection with the renderer's `requestId`, and answers the Host saga's result unchanged; no
// legacy reset runs beside it (21 §3: `ResetFanout` ends in 4a). Every answer is checked against
// the registry's response schema.
//
// TC-233-01 (the A-33 half).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type MetricsResetResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createResetMetricsRow, RESET_METRICS, RESET_METRICS_ROWS } from './resetMetrics.host'

const REQUEST = '01920000-0000-7000-a000-000000000233'

/** The HostClient member the row uses: records each call on the `ui` connection, or refuses. */
class FakeResetHost implements Pick<HostClient, 'withUiConnection'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  result: MetricsResetResult = { outcome: 'reset', epoch: 3 }
  refusal: IpcError | null = null

  withUiConnection<T>(work: (c: Pick<HostClient, 'call' | 'snapshot'>) => Promise<T>): Promise<T> {
    return work({
      call: <M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> => {
        this.calls.push({ method, params })
        if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
        return Promise.resolve(this.result) as Promise<HostResult[M]>
      },
      snapshot: () => Promise.reject(new Error('the reset row reads no snapshot'))
    })
  }
}

describe('A-33 resetMetrics, host handler (14 §2.1, §3.4)', () => {
  it('[US-SET-010.AC05, ADR-023] a confirmed reset is relayed to preferences.resetMetrics with its requestId and the saga result comes back unchanged', async () => {
    const host = new FakeResetHost()
    const row = createResetMetricsRow(host)
    const response = CHANNELS[RESET_METRICS].response
    const payload = { confirmed: 'yes', requestId: REQUEST }

    const answer = response.parse(await row.serve(RESET_METRICS, payload))

    expect(RESET_METRICS_ROWS).toStrictEqual(['metrics:reset'])
    expect(answer).toStrictEqual({ ok: true, value: { outcome: 'reset', epoch: 3 } })
    expect(host.calls).toStrictEqual([{ method: 'preferences.resetMetrics', params: payload }])

    // A failed step is an outcome, never a toast and never a call error (ADR-023 item 5).
    host.result = { outcome: 'failed', reason: 'config-revert-locked', resumesOnNextStart: true }
    expect(response.parse(await row.serve(RESET_METRICS, payload))).toStrictEqual({
      ok: true,
      value: { outcome: 'failed', reason: 'config-revert-locked', resumesOnNextStart: true }
    })
  })

  it('[ADR-019, ADR-023] an unconfirmed or malformed payload never reaches the Host; a Host refusal is the result error branch; another channel is refused', async () => {
    const host = new FakeResetHost()
    const row = createResetMetricsRow(host)
    const response = CHANNELS[RESET_METRICS].response

    for (const payload of [
      undefined,
      { requestId: REQUEST },
      { confirmed: 'no', requestId: REQUEST },
      { confirmed: 'yes' },
      { confirmed: 'yes', requestId: REQUEST, scope: 'all' }
    ]) {
      expect(response.parse(await row.serve(RESET_METRICS, payload))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toStrictEqual([])

    host.refusal = { code: 'HOST_NOT_READY', message: 'migrating', retryable: true }
    expect(
      response.parse(await row.serve(RESET_METRICS, { confirmed: 'yes', requestId: REQUEST }))
    ).toStrictEqual({
      ok: false,
      error: { code: 'HOST_NOT_READY', message: 'migrating', retryable: true }
    })

    expect(await row.serve('projects:query', {})).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
