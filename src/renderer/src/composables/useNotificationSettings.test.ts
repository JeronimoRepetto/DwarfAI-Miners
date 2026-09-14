import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFICATIONS_ENABLED } from '../types'
import { useNotificationSettings } from './useNotificationSettings'

/**
 * Settings' notifications switch, renderer side (#316).
 *
 * The one honesty rule it exists to enforce is the one `usePinnedWindow` holds
 * for the pin: `enabled` only ever becomes a value main answered with, because
 * a press that main refused or could not store must not be drawn as the state
 * in force.
 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getNotificationsEnabled: vi.fn().mockResolvedValue(true),
    setNotificationsEnabled: vi.fn(async (enabled: boolean) => enabled),
    ...overrides
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return api
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('useNotificationSettings', () => {
  it('starts on main’s documented default, so the first paint is almost always right', () => {
    fakeApi()
    expect(useNotificationSettings().enabled.value).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
  })

  it('adopts the stored switch on sync', async () => {
    fakeApi({ getNotificationsEnabled: vi.fn().mockResolvedValue(false) })
    const { enabled, sync } = useNotificationSettings()
    await sync()
    expect(enabled.value).toBe(false)
  })

  it('keeps the last known state when the bridge is unreachable', async () => {
    fakeApi({ getNotificationsEnabled: vi.fn().mockRejectedValue(new Error('no bridge')) })
    const { enabled, sync } = useNotificationSettings()
    await sync()
    expect(enabled.value).toBe(DEFAULT_NOTIFICATIONS_ENABLED)
  })

  it('renders what main STORED, never what the press asked for', async () => {
    // A write main refused, or one it clamped: the switch has to show the
    // state that is really in force.
    const api = fakeApi({ setNotificationsEnabled: vi.fn().mockResolvedValue(true) })
    const { enabled, set } = useNotificationSettings()
    await set(false)
    expect(api.setNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(enabled.value).toBe(true)
  })

  it('re-reads the real state when a change breaks mid-flight', async () => {
    const api = fakeApi({
      setNotificationsEnabled: vi.fn().mockRejectedValue(new Error('no bridge')),
      getNotificationsEnabled: vi.fn().mockResolvedValue(false)
    })
    const { enabled, set } = useNotificationSettings()
    await set(false)
    expect(api.getNotificationsEnabled).toHaveBeenCalled()
    expect(enabled.value).toBe(false)
  })

  it('ignores a second press while one is still in flight', async () => {
    let release: (value: boolean) => void = () => undefined
    const api = fakeApi({
      setNotificationsEnabled: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve
          })
      )
    })
    const { set } = useNotificationSettings()
    const first = set(false)
    await set(true)
    expect(api.setNotificationsEnabled).toHaveBeenCalledTimes(1)
    release(false)
    await first
  })
})
