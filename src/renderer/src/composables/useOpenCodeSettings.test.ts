import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPENCODE_SETTINGS } from '../types'
import { useOpenCodeSettings } from './useOpenCodeSettings'

/**
 * Settings' OpenCode section, renderer side (#588 T6).
 *
 * The honesty rule every settings composable here holds: `settings` only ever
 * becomes a value main answered with. For this section that matters twice
 * over — a relay main could not turn on must never be drawn as on, and the
 * password is never part of any value this composable holds.
 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getOpenCodeSettings: vi.fn().mockResolvedValue({ ...DEFAULT_OPENCODE_SETTINGS }),
    setOpenCodePluginEnabled: vi.fn(async (enabled: boolean) => ({
      ...DEFAULT_OPENCODE_SETTINGS,
      pluginEnabled: enabled
    })),
    setOpenCodeServerPassword: vi.fn(async () => ({
      ...DEFAULT_OPENCODE_SETTINGS,
      passwordConfigured: true
    })),
    clearOpenCodeServerPassword: vi.fn(async () => ({ ...DEFAULT_OPENCODE_SETTINGS })),
    ...overrides
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return api
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('useOpenCodeSettings (#588 T6)', () => {
  it('starts off, the true state of an install that never touched it', () => {
    fakeApi()
    expect(useOpenCodeSettings().settings.value).toEqual(DEFAULT_OPENCODE_SETTINGS)
  })

  it('adopts the stored settings on sync, and keeps the last known ones when the bridge fails', async () => {
    fakeApi({
      getOpenCodeSettings: vi
        .fn()
        .mockResolvedValueOnce({ pluginEnabled: true, passwordConfigured: false })
        .mockRejectedValueOnce(new Error('no bridge'))
    })
    const { settings, sync } = useOpenCodeSettings()
    await sync()
    expect(settings.value.pluginEnabled).toBe(true)
    await sync()
    expect(settings.value.pluginEnabled).toBe(true)
  })

  it('draws a refused switch as off, with main’s reason beside it', async () => {
    fakeApi({
      setOpenCodePluginEnabled: vi.fn(async () => ({
        pluginEnabled: false,
        pluginError: 'Port 47821 could not be opened: EADDRINUSE',
        passwordConfigured: false
      }))
    })
    const { settings, setPluginEnabled } = useOpenCodeSettings()
    await setPluginEnabled(true)
    expect(settings.value.pluginEnabled).toBe(false)
    expect(settings.value.pluginError).toMatch(/EADDRINUSE/)
  })

  it('hands the password to the bridge and keeps no copy of it', async () => {
    const api = fakeApi()
    const { settings, savePassword } = useOpenCodeSettings()
    await savePassword('hunter2')
    expect(api.setOpenCodeServerPassword).toHaveBeenCalledWith('hunter2')
    expect(settings.value.passwordConfigured).toBe(true)
    expect(JSON.stringify(settings.value)).not.toContain('hunter2')
  })

  it('clears the password through main', async () => {
    const api = fakeApi({
      getOpenCodeSettings: vi
        .fn()
        .mockResolvedValue({ pluginEnabled: false, passwordConfigured: true })
    })
    const { settings, sync, clearPassword } = useOpenCodeSettings()
    await sync()
    await clearPassword()
    expect(api.clearOpenCodeServerPassword).toHaveBeenCalledOnce()
    expect(settings.value.passwordConfigured).toBe(false)
  })

  it('ignores a second request while one is in flight', async () => {
    let release: () => void = () => undefined
    const api = fakeApi({
      setOpenCodePluginEnabled: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ pluginEnabled: true, passwordConfigured: false })
          })
      )
    })
    const { applying, setPluginEnabled, savePassword } = useOpenCodeSettings()
    const first = setPluginEnabled(true)
    expect(applying.value).toBe(true)
    await setPluginEnabled(false)
    await savePassword('x')
    release()
    await first
    expect(api.setOpenCodePluginEnabled).toHaveBeenCalledOnce()
    expect(api.setOpenCodeServerPassword).not.toHaveBeenCalled()
    expect(applying.value).toBe(false)
  })

  it('re-reads the real state when a write breaks on the way', async () => {
    const api = fakeApi({
      setOpenCodePluginEnabled: vi.fn().mockRejectedValue(new Error('bridge broke'))
    })
    const { setPluginEnabled } = useOpenCodeSettings()
    await setPluginEnabled(true)
    expect(api.getOpenCodeSettings).toHaveBeenCalledOnce()
  })
})
