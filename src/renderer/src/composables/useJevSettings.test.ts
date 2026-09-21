import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_SETTINGS, type JevSettings } from '../types'
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
    // AMENDED for the #509 follow-up: the composable asks these two once the
    // section is configured, so both members have to exist even in tests
    // that never touch the default-launch pickers. Answered empty by
    // default, the same "only the tests that care see any effect" idiom
    // every other stub in this suite holds.
    listAgentProviders: vi.fn().mockResolvedValue({ providers: [] }),
    listAgentModels: vi.fn().mockResolvedValue({ catalogs: [] }),
    setJevPreferences: vi.fn(async () => ({ configured: true })),
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

/*
 * Jev routing profiles: profile and defaults (#509 follow-up) — APPENDED,
 * nothing above changed.
 *
 * The default-launch pickers need real providers and model catalogues to
 * offer, so this composable asks for them the same way `useAgentLaunch`
 * does — but only once the section is actually configured, since Settings
 * draws neither picker before then.
 */
describe('useJevSettings — loading the default-launch sources', () => {
  it('asks for no providers or catalogues before anything has synced', () => {
    const api = fakeApi()
    useJevSettings()
    expect(api.listAgentProviders).not.toHaveBeenCalled()
    expect(api.listAgentModels).not.toHaveBeenCalled()
  })

  it('starts both empty, so the pickers have nothing to offer before a sync', () => {
    fakeApi()
    const { providers, catalogs } = useJevSettings()
    expect(providers.value).toEqual([])
    expect(catalogs.value).toEqual([])
  })

  it('loads providers and catalogues on sync once the section is configured', async () => {
    const api = fakeApi({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      listAgentProviders: vi.fn().mockResolvedValue({
        providers: [{ provider: 'claude', installed: true, launchable: true }]
      }),
      listAgentModels: vi.fn().mockResolvedValue({
        catalogs: [{ provider: 'claude', models: [], efforts: [], source: 'provider' }]
      })
    })
    const { providers, catalogs, sync } = useJevSettings()
    await sync()
    expect(api.listAgentProviders).toHaveBeenCalled()
    expect(api.listAgentModels).toHaveBeenCalled()
    expect(providers.value).toEqual([{ provider: 'claude', installed: true, launchable: true }])
    expect(catalogs.value).toEqual([
      { provider: 'claude', models: [], efforts: [], source: 'provider' }
    ])
  })

  it('never asks for either when sync answers unconfigured', async () => {
    const api = fakeApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: false }) })
    const { sync } = useJevSettings()
    await sync()
    expect(api.listAgentProviders).not.toHaveBeenCalled()
    expect(api.listAgentModels).not.toHaveBeenCalled()
  })

  it('loads providers and catalogues once a save turns the section configured', async () => {
    const api = fakeApi({
      setJevApiKey: vi.fn().mockResolvedValue({ configured: true }),
      listAgentProviders: vi.fn().mockResolvedValue({
        providers: [{ provider: 'codex', installed: true, launchable: true }]
      })
    })
    const { providers, save } = useJevSettings()
    await save('sk-typesafe-abc123')
    expect(api.listAgentProviders).toHaveBeenCalled()
    expect(providers.value).toEqual([{ provider: 'codex', installed: true, launchable: true }])
  })

  it('degrades to empty lists rather than throwing when the bridge cannot answer', async () => {
    fakeApi({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      listAgentProviders: vi.fn().mockRejectedValue(new Error('no bridge')),
      listAgentModels: vi.fn().mockRejectedValue(new Error('no bridge'))
    })
    const { providers, catalogs, sync } = useJevSettings()
    await expect(sync()).resolves.toBeUndefined()
    expect(providers.value).toEqual([])
    expect(catalogs.value).toEqual([])
  })
})

describe('useJevSettings — setPreferences', () => {
  it('asks main to save, and renders what main STORED', async () => {
    const api = fakeApi({
      setJevPreferences: vi.fn(async (preferences: unknown) => ({
        configured: true,
        preferences
      }))
    })
    const { settings, setPreferences } = useJevSettings()
    const preferences = { profile: 'premium' as const, default: { provider: 'claude' as const } }
    await setPreferences(preferences)
    expect(api.setJevPreferences).toHaveBeenCalledWith(preferences)
    expect(settings.value).toEqual({ configured: true, preferences })
  })

  it('ignores a second call while one is still in flight', async () => {
    let release: (value: { configured: boolean }) => void = () => undefined
    const api = fakeApi({
      setJevPreferences: vi.fn(
        () =>
          new Promise<{ configured: boolean }>((resolve) => {
            release = resolve
          })
      )
    })
    const { setPreferences } = useJevSettings()
    const first = setPreferences({ profile: 'balanced', default: {} })
    await setPreferences({ profile: 'premium', default: {} })
    expect(api.setJevPreferences).toHaveBeenCalledTimes(1)
    release({ configured: true })
    await first
  })

  /*
   * AMENDED 2026-09-21. This case used to assert the opposite: that a broken
   * preferences save calls `getJevSettings` to re-read the real state. That
   * recovery is what the reported defect turned out to be.
   *
   * `sync()` does not only re-read — when the section is configured it also
   * re-queries the launch catalogue, which spawns a provider CLI, and it ran
   * with `saving` still held. So a failed click on a routing profile paused
   * visibly, changed nothing, released nothing in time for the next click,
   * and said nothing anywhere the person could see. The state it re-read was
   * correct and entirely beside the point.
   *
   * The last known value is just as honest when the call never landed, and
   * the reason now rides on it. The API-key `save`/`clear` above keep their
   * own `sync()` recovery untouched: neither is a per-click control, and
   * neither had this failure.
   */
  it('keeps the last known state and the reason when a save breaks mid-flight', async () => {
    const api = fakeApi({
      setJevPreferences: vi.fn().mockRejectedValue(new Error('no bridge')),
      getJevSettings: vi.fn().mockResolvedValue({ configured: true })
    })
    const { settings, setPreferences } = useJevSettings()
    await setPreferences({ profile: 'balanced', default: {} })
    expect(api.getJevSettings).not.toHaveBeenCalled()
    expect(settings.value.preferencesError).toContain('no bridge')
  })

  it('sets saving true only while a preferences save is actually in flight', async () => {
    let release: (value: { configured: boolean }) => void = () => undefined
    fakeApi({
      setJevPreferences: vi.fn(
        () =>
          new Promise<{ configured: boolean }>((resolve) => {
            release = resolve
          })
      )
    })
    const { saving, setPreferences } = useJevSettings()
    expect(saving.value).toBe(false)
    const pending = setPreferences({ profile: 'balanced', default: {} })
    expect(saving.value).toBe(true)
    release({ configured: true })
    await pending
    expect(saving.value).toBe(false)
  })
})

/*
 * A preference write that did not happen has to SAY so.
 *
 * Reported 2026-09-21: clicking Economy or Premium "loads something and then
 * nothing is selected". The load was the tell. `setPreferences` caught its
 * own failure and called `sync()`, which re-queries the launch catalogue —
 * spawning a provider CLI — and it did all of that while still holding
 * `saving`, so the control stayed disabled and every further click was eaten
 * by the in-flight guard. The person saw a spinner-shaped pause, no change,
 * and nothing anywhere to read: the only account of the failure was a
 * console.warn in the MAIN process, which reaches a terminal, not a user.
 */
describe('useJevSettings reporting a preference write that did not happen', () => {
  it('keeps the failure on the settings it renders, rather than only in a log', async () => {
    fakeApi({
      setJevPreferences: vi.fn().mockRejectedValue(new Error('no handler registered'))
    })
    const { settings, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {} })

    expect(settings.value.preferencesError).toContain('no handler registered')
  })

  it('lets go of the control even when the write failed', async () => {
    // The defect behind "I click again and nothing happens at all": `saving`
    // gates the next attempt, so one swallowed failure disabled the control
    // for as long as the recovery took.
    fakeApi({ setJevPreferences: vi.fn().mockRejectedValue(new Error('boom')) })
    const { saving, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {} })

    expect(saving.value).toBe(false)
  })

  it('does not re-query the launch catalogue on the way out of a failure', async () => {
    // That query spawns a provider CLI. Doing it inside the failure path is
    // what made a failed click look like a loading click.
    const api = fakeApi({ setJevPreferences: vi.fn().mockRejectedValue(new Error('boom')) })
    const { setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {} })

    expect(api.listAgentModels).not.toHaveBeenCalled()
  })

  it('carries a refusal main reported, the same way it carries a rejection', async () => {
    // Main answers with what is STORED plus why the request did not take, so
    // a refusal is an ordinary answer rather than an exception.
    fakeApi({
      setJevPreferences: vi.fn().mockResolvedValue({
        configured: true,
        preferences: { profile: 'balanced', default: {} },
        preferencesError: 'That default names a provider this build cannot launch.'
      })
    })
    const { settings, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {} })

    expect(settings.value.preferences.profile).toBe('balanced')
    expect(settings.value.preferencesError).toContain('cannot launch')
  })

  it('clears a stale failure once a write goes through', async () => {
    // Fails once, then behaves: the second answer carries no error, and the
    // field must go with it rather than sticking to a resolved complaint.
    fakeApi({
      setJevPreferences: vi
        .fn(async (): Promise<JevSettings> => ({
          configured: true,
          preferences: { profile: 'economy', default: {} }
        }))
        .mockRejectedValueOnce(new Error('boom'))
    })
    const { settings, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {} })
    expect(settings.value.preferencesError).toBeTruthy()

    await setPreferences({ profile: 'economy', default: {} })
    expect(settings.value.preferencesError).toBeUndefined()
  })
})
