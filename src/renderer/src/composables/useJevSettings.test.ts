import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_SETTINGS } from '../types'
import { useJevSettings } from './useJevSettings'

/**
 * Settings' Jev API-key control, renderer side (#509).
 *
 * The one honesty rule it exists to enforce is the one `useNotificationSettings`
 * and `usePinnedWindow` hold: `settings` only ever becomes a value main
 * answered with, because a save or a clear main refused must not be drawn as
 * the state in force — and the key itself is never part of that value at all.
 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getJevSettings: vi.fn().mockResolvedValue({ configured: false }),
    setJevApiKey: vi.fn(async () => ({ configured: true })),
    clearJevApiKey: vi.fn(async () => ({ configured: false })),
    ...overrides
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return api
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('useJevSettings', () => {
  it('starts on the documented default, so the first paint is almost always right', () => {
    fakeApi()
    expect(useJevSettings().settings.value).toEqual(DEFAULT_JEV_SETTINGS)
  })

  it('adopts the stored settings on sync', async () => {
    fakeApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
    const { settings, sync } = useJevSettings()
    await sync()
    expect(settings.value).toEqual({ configured: true })
  })

  it('keeps the last known state when the bridge is unreachable', async () => {
    fakeApi({ getJevSettings: vi.fn().mockRejectedValue(new Error('no bridge')) })
    const { settings, sync } = useJevSettings()
    await sync()
    expect(settings.value).toEqual(DEFAULT_JEV_SETTINGS)
  })

  it('asks main to save, and renders what main STORED', async () => {
    const api = fakeApi({
      setJevApiKey: vi.fn(async (key: string) => ({ configured: key !== '' }))
    })
    const { settings, save } = useJevSettings()
    await save('sk-typesafe-abc123')
    expect(api.setJevApiKey).toHaveBeenCalledWith('sk-typesafe-abc123')
    expect(settings.value).toEqual({ configured: true })
  })

  it('renders a refusal main gave, including its reason, rather than assuming success', async () => {
    const refused = { configured: false, unavailableReason: 'encryption-unavailable' as const }
    fakeApi({ setJevApiKey: vi.fn().mockResolvedValue(refused) })
    const { settings, save } = useJevSettings()
    await save('sk-typesafe-abc123')
    expect(settings.value).toEqual(refused)
  })

  it('sets saving true only while a save is actually in flight', async () => {
    let release: (value: { configured: boolean }) => void = () => undefined
    fakeApi({
      setJevApiKey: vi.fn(
        () =>
          new Promise<{ configured: boolean }>((resolve) => {
            release = resolve
          })
      )
    })
    const { saving, save } = useJevSettings()
    expect(saving.value).toBe(false)
    const pending = save('sk-typesafe-abc123')
    expect(saving.value).toBe(true)
    release({ configured: true })
    await pending
    expect(saving.value).toBe(false)
  })

  it('ignores a second save while one is still in flight', async () => {
    let release: (value: { configured: boolean }) => void = () => undefined
    const api = fakeApi({
      setJevApiKey: vi.fn(
        () =>
          new Promise<{ configured: boolean }>((resolve) => {
            release = resolve
          })
      )
    })
    const { save } = useJevSettings()
    const first = save('sk-typesafe-abc123')
    await save('sk-typesafe-xyz789')
    expect(api.setJevApiKey).toHaveBeenCalledTimes(1)
    release({ configured: true })
    await first
  })

  it('re-reads the real state when a save breaks mid-flight', async () => {
    const api = fakeApi({
      setJevApiKey: vi.fn().mockRejectedValue(new Error('no bridge')),
      getJevSettings: vi.fn().mockResolvedValue({ configured: false })
    })
    const { settings, save } = useJevSettings()
    await save('sk-typesafe-abc123')
    expect(api.getJevSettings).toHaveBeenCalled()
    expect(settings.value).toEqual({ configured: false })
  })

  it('asks main to clear, and renders what main STORED', async () => {
    const api = fakeApi({ clearJevApiKey: vi.fn().mockResolvedValue({ configured: false }) })
    const { settings, clear } = useJevSettings()
    await clear()
    expect(api.clearJevApiKey).toHaveBeenCalled()
    expect(settings.value).toEqual({ configured: false })
  })

  it('re-reads the real state when a clear breaks mid-flight', async () => {
    const api = fakeApi({
      clearJevApiKey: vi.fn().mockRejectedValue(new Error('no bridge')),
      getJevSettings: vi.fn().mockResolvedValue({ configured: true })
    })
    const { settings, clear } = useJevSettings()
    await clear()
    expect(api.getJevSettings).toHaveBeenCalled()
    expect(settings.value).toEqual({ configured: true })
  })
})
