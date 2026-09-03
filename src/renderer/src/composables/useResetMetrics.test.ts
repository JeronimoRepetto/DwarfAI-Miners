// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useResetMetrics } from './useResetMetrics'

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    resetMetrics: vi.fn().mockResolvedValue({ outcome: 'reset' }),
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
    let resolveApi: (value: { outcome: 'reset' }) => void = () => undefined
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
    resolveApi({ outcome: 'reset' })
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
      resetMetrics: vi.fn().mockResolvedValue({ outcome: 'failed', reason: 'Nothing was deleted.' })
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
    let resolveApi: (value: { outcome: 'reset' }) => void = () => undefined
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
    resolveApi({ outcome: 'reset' })
    await first
    await second

    expect(resetMetrics).toHaveBeenCalledOnce()
  })

  it('clears a previous error once a later attempt succeeds', async () => {
    const resetMetrics = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'failed', reason: 'Nothing was deleted.' })
      .mockResolvedValueOnce({ outcome: 'reset' })
    stubApi({ resetMetrics })
    const { error, reset } = useResetMetrics()

    await reset()
    expect(error.value).toBe('Nothing was deleted.')
    await reset()
    expect(error.value).toBeNull()
  })
})
