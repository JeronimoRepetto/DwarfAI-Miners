// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useResetMetrics } from './useResetMetrics'

// AMENDED for ISSUE-123 (was: today's `{outcome}` answers): the cut-1 switch routes A-33 with its target shape through
// `ResetFanout`, so main answers `IpcResult<MetricsResetResult>` (14 §2.1 A-33, §3.4).
const RESET = { ok: true, value: { outcome: 'reset', epoch: 2 } } as const
const REFUSED = {
  ok: true,
  value: { outcome: 'failed', reason: 'Nothing was deleted.', resumesOnNextStart: false }
} as const

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    resetMetrics: vi.fn().mockResolvedValue(RESET),
    ...overrides
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

/**
 * Settings' "Reset metrics" action (#138). App owns this composable — and
 * therefore the IPC — for the same reason it owns every other settings
 * surface: the modal that triggers it stays presentational, and the "render
 * only what main verified" rule lives in exactly one place.
 */
describe('useResetMetrics', () => {
  it('starts idle with no error', () => {
    stubApi()
    const { resetting, error } = useResetMetrics()
    expect(resetting.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('marks resetting while the request is in flight', async () => {
    let resolveApi: (value: typeof RESET) => void = () => undefined
    const resetMetrics = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveApi = resolve
        })
    )
    stubApi({ resetMetrics })
    const { resetting, reset } = useResetMetrics()

    const pending = reset()
    expect(resetting.value).toBe(true)
    resolveApi(RESET)
    await pending
    expect(resetting.value).toBe(false)
  })

  it('resolves true and carries no error on a successful reset', async () => {
    stubApi()
    const { error, reset } = useResetMetrics()
    await expect(reset()).resolves.toBe(true)
    expect(error.value).toBeNull()
  })

  it('resolves false and carries the reason on a refusal', async () => {
    stubApi({
      resetMetrics: vi.fn().mockResolvedValue(REFUSED)
    })
    const { error, reset } = useResetMetrics()
    await expect(reset()).resolves.toBe(false)
    expect(error.value).toBe('Nothing was deleted.')
  })

  it('resolves false with a stated error when the bridge itself is unreachable', async () => {
    stubApi({ resetMetrics: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { error, reset } = useResetMetrics()
    await expect(reset()).resolves.toBe(false)
    expect(error.value).toBeTruthy()
  })

  it('ignores a second call while one is already in flight', async () => {
    let resolveApi: (value: typeof RESET) => void = () => undefined
    const resetMetrics = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveApi = resolve
        })
    )
    stubApi({ resetMetrics })
    const { reset } = useResetMetrics()

    const first = reset()
    const second = reset()
    resolveApi(RESET)
    await first
    await second

    expect(resetMetrics).toHaveBeenCalledOnce()
  })

  it('clears a previous error once a later attempt succeeds', async () => {
    const resetMetrics = vi.fn().mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(RESET)
    stubApi({ resetMetrics })
    const { error, reset } = useResetMetrics()

    await reset()
    expect(error.value).toBe('Nothing was deleted.')
    await reset()
    expect(error.value).toBeNull()
  })

  // AMENDED for ISSUE-123 (appended): A-33's target request and its error branch.
  it('[ADR-023] asks A-33 with the typed confirmation and one request id per intent', async () => {
    const api = stubApi()
    const ids = ['01890a5d-ac96-774b-bcce-b302099a8001', '01890a5d-ac96-774b-bcce-b302099a8002']
    const { reset } = useResetMetrics({ newRequestId: () => ids.shift() ?? 'none' })
    await reset()
    await reset()
    expect(api.resetMetrics.mock.calls).toEqual([
      [{ confirmed: 'yes', requestId: '01890a5d-ac96-774b-bcce-b302099a8001' }],
      [{ confirmed: 'yes', requestId: '01890a5d-ac96-774b-bcce-b302099a8002' }]
    ])
  })

  it('[ADR-023] an error answer resolves false and carries a stated error, never a reset', async () => {
    stubApi({
      resetMetrics: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'HOST_NOT_READY', message: 'not ready', retryable: true }
      })
    })
    const { error, reset } = useResetMetrics()
    await expect(reset()).resolves.toBe(false)
    expect(error.value).toBeTruthy()
  })
})
