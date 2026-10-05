// layer: L2
// `ResetFanout` (21 §3, §3.1; ADR-023 items 4–5; BR-18): today's legacy reset first, then the Host saga, one answer.
// Doubles: a scripted legacy reset (the `metrics:reset` handler of `LegacyRuntimeRoute`, today's answer shape) and a
// recording HostClient whose `ui` connection answers a scripted `MetricsResetResult`.
import { describe, expect, it } from 'vitest'
import type {
  HostMethod,
  HostParams,
  HostResult,
  IpcError,
  IpcResult,
  MetricsResetResult,
  ResetMetricsParams
} from '@dwarfai/contracts'
import type { RouteTarget } from '../../ui-main/ipc/router'
import type { HostClient } from '../../ui-main/window/ports/hostClient'
import {
  createResetFanout,
  REQUEST_MEMORY_MS,
  RESET_METRICS,
  type ResetFanoutHostClient
} from './resetFanout'

const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8001'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8002'
const LEGACY_FAILED = 'The metrics could not be reset. Nothing was deleted.'

/** Today's `metrics:reset` handler as `LegacyRuntimeRoute` serves it: today's `MetricsResetResult`. */
class ScriptedLegacyReset implements RouteTarget {
  readonly served: Array<[string, unknown]> = []
  answer: unknown = { outcome: 'reset' }

  serve(channel: string, payload: unknown): Promise<unknown> {
    this.served.push([channel, payload])
    return Promise.resolve(this.answer)
  }
}

/** Throws what the real HostClient throws for a call error: an object carrying its seam-B error (14 §3.3). */
class CallError extends Error {
  constructor(readonly error: IpcError) {
    super(error.message)
  }
}

/** Records every call made on its `ui` connection; `preferences.resetMetrics` answers `next()`. */
class RecordingHostClient implements ResetFanoutHostClient {
  readonly calls: Array<{ method: string; params: unknown }> = []
  next: () => Promise<MetricsResetResult> = () => Promise.resolve({ outcome: 'reset', epoch: 4 })

  withUiConnection<T>(work: (c: Pick<HostClient, 'call' | 'snapshot'>) => Promise<T>): Promise<T> {
    const connection: Pick<HostClient, 'call' | 'snapshot'> = {
      call: <M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> => {
        this.calls.push({ method, params })
        if (method !== 'preferences.resetMetrics') {
          return Promise.reject(new Error(`unexpected ${method}`))
        }
        return this.next() as Promise<HostResult[M]>
      },
      snapshot: () => Promise.reject(new Error('no snapshot is read'))
    }
    return work(connection)
  }
}

function world() {
  const legacy = new ScriptedLegacyReset()
  const host = new RecordingHostClient()
  const clock = { now: 1_000_000 }
  const fanout = createResetFanout({ legacy, hostClient: host, now: () => clock.now })
  const reset = (requestId = RID_1): Promise<IpcResult<MetricsResetResult>> =>
    fanout.serve(RESET_METRICS, {
      confirmed: 'yes',
      requestId
    } satisfies ResetMetricsParams) as Promise<IpcResult<MetricsResetResult>>
  return { legacy, host, clock, reset }
}

describe('ResetFanout: the legacy reset, then the Host saga (21 §3; ADR-023 items 4–5)', () => {
  it('[ADR-023] with both resets succeeding the answer is reset with the Host epoch', async () => {
    const { legacy, host, reset } = world()
    host.next = () => Promise.resolve({ outcome: 'reset', epoch: 7 })

    await expect(reset()).resolves.toStrictEqual({
      ok: true,
      value: { outcome: 'reset', epoch: 7 }
    })
    expect(legacy.served).toStrictEqual([[RESET_METRICS, undefined]])
    expect(host.calls).toStrictEqual([
      { method: 'preferences.resetMetrics', params: { confirmed: 'yes', requestId: RID_1 } }
    ])
  })

  it('[ADR-023] a failed legacy reset answers failed and never starts the Host saga', async () => {
    const { legacy, host, reset } = world()
    legacy.answer = { outcome: 'failed', reason: LEGACY_FAILED }

    await expect(reset()).resolves.toStrictEqual({
      ok: true,
      value: { outcome: 'failed', reason: LEGACY_FAILED, resumesOnNextStart: false }
    })
    expect(host.calls).toStrictEqual([])
  })

  it("[ADR-023] a failed Host saga after a successful legacy reset answers the Host's failed result with resumesOnNextStart", async () => {
    const { legacy, host, reset } = world()
    const sagaFailed: MetricsResetResult = {
      outcome: 'failed',
      reason: 'external-config: the file is locked',
      resumesOnNextStart: true
    }
    host.next = () => Promise.resolve(sagaFailed)

    await expect(reset()).resolves.toStrictEqual({ ok: true, value: sagaFailed })
    expect(legacy.served).toHaveLength(1)
    expect(host.calls).toHaveLength(1)
  })

  it('[ADR-023] a retried call with the same requestId reaches the Host once', async () => {
    const { legacy, host, clock, reset } = world()
    let settle: (result: MetricsResetResult) => void = () => {}
    host.next = () =>
      new Promise<MetricsResetResult>((resolve) => {
        settle = resolve
      })

    // A repeat while the first is in flight joins it (14 §1.6).
    const first = reset(RID_1)
    const joined = reset(RID_1)
    await Promise.resolve()
    await Promise.resolve()
    settle({ outcome: 'reset', epoch: 2 })
    const expected = { ok: true, value: { outcome: 'reset', epoch: 2 } }
    await expect(first).resolves.toStrictEqual(expected)
    await expect(joined).resolves.toStrictEqual(expected)

    // A repeat after it settled, inside the window, answers the first result verbatim.
    clock.now += REQUEST_MEMORY_MS - 1
    await expect(reset(RID_1)).resolves.toStrictEqual(expected)

    expect(legacy.served).toHaveLength(1)
    expect(host.calls).toStrictEqual([
      { method: 'preferences.resetMetrics', params: { confirmed: 'yes', requestId: RID_1 } }
    ])

    // A new intent carries a new requestId and is a new reset.
    host.next = () => Promise.resolve({ outcome: 'reset', epoch: 3 })
    await expect(reset(RID_2)).resolves.toStrictEqual({
      ok: true,
      value: { outcome: 'reset', epoch: 3 }
    })
    expect(legacy.served).toHaveLength(2)
    expect(host.calls).toHaveLength(2)
  })

  it('[ADR-023] a Host call error answers the error branch, and a repeat relays the same requestId again', async () => {
    const { legacy, host, reset } = world()
    const unavailable: IpcError = {
      code: 'HOST_UNAVAILABLE',
      message: 'the connection was lost',
      retryable: true
    }
    host.next = () => Promise.reject(new CallError(unavailable))

    await expect(reset(RID_1)).resolves.toStrictEqual({ ok: false, error: unavailable })

    // The legacy reset already ran for this intent; only the Host is asked again, with the same requestId.
    host.next = () => Promise.resolve({ outcome: 'reset', epoch: 5 })
    await expect(reset(RID_1)).resolves.toStrictEqual({
      ok: true,
      value: { outcome: 'reset', epoch: 5 }
    })
    expect(legacy.served).toHaveLength(1)
    expect(host.calls.map((c) => c.params)).toStrictEqual([
      { confirmed: 'yes', requestId: RID_1 },
      { confirmed: 'yes', requestId: RID_1 }
    ])
  })

  it('[ADR-023] a requestId is remembered only for the Host de-duplication window', async () => {
    const { legacy, host, clock, reset } = world()
    await reset(RID_1)

    clock.now += REQUEST_MEMORY_MS
    await reset(RID_2)
    // RID_1 was forgotten when the window passed, as the Host forgets it (14 §1.6).
    await reset(RID_1)

    expect(legacy.served).toHaveLength(3)
    expect(host.calls).toHaveLength(3)
  })

  it('[ADR-023] a legacy reset that throws answers failed and never starts the Host saga', async () => {
    const { host } = world()
    const legacy: RouteTarget = { serve: () => Promise.reject(new Error('runtime gone')) }
    const fanout = createResetFanout({ legacy, hostClient: host, now: () => 0 })

    const answer = (await fanout.serve(RESET_METRICS, {
      confirmed: 'yes',
      requestId: RID_1
    })) as IpcResult<MetricsResetResult>
    expect(answer).toStrictEqual({
      ok: true,
      value: { outcome: 'failed', reason: LEGACY_FAILED, resumesOnNextStart: false }
    })
    expect(host.calls).toStrictEqual([])
  })
})
