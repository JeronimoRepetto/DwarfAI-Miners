import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { reactive } from 'vue'
import { DEFAULT_JEV_SETTINGS, type JevPreferences, type JevSettings } from '../types'
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
    // AMENDED for ISSUE-001 (was: today's A-36 `{ providers }` and A-37 `{ catalogs }`): from 3a A-36 answers every
    // provider's `SupplierEntryView` with its models; A-37 is retired and never asked.
    listAgentProviders: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    // AMENDED for ISSUE-249 (was: also mocks of the RETIRE rows' members): A-14, A-16, A-17, A-18, A-P5, A-37 and
    // A-38 left the facade at cut 5 (`MEMBER_REMOVED`), and the fake refuses a member the registry does not have.
    setJevPreferences: vi.fn(async () => ({ configured: true })),
    ...overrides
  }
  // AMENDED for ISSUE-250 (was: this hand-built object as `window.api`): installed through the generated fake (ADR-033
  // item 7), which refuses any member the channel registry lacks. Cast: the test data is typed looser than the contract.
  ;(globalThis as { window?: unknown }).window = {
    api: createFakeWindowApi(api as unknown as Partial<Window['api']>)
  }
  return api
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

/** One A-36 entry (14 §3.6 `SupplierEntryView`): installed, launchable, one model. */
function entry(providerId: string) {
  return {
    providerId,
    label: providerId,
    models: [{ value: 'opus', efforts: ['high'] }],
    permissionModes: [],
    offeredModes: [],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available'
  }
}

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
    // AMENDED for ISSUE-249 (was: A-37 `listAgentModels` never called): the member left the facade at cut 5.
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
      listAgentProviders: vi.fn().mockResolvedValue({ ok: true, value: [entry('claude')] })
    })
    const { providers, catalogs, sync } = useJevSettings()
    await sync()
    expect(api.listAgentProviders).toHaveBeenCalledWith({})
    // AMENDED for ISSUE-001: the catalogue rides on the provider's own entry (A-37 is never asked).
    // AMENDED for ISSUE-249 (was: A-37 `listAgentModels` never called): the member left the facade at cut 5.
    expect(providers.value).toEqual([{ provider: 'claude', installed: true, launchable: true }])
    expect(catalogs.value).toEqual([
      {
        provider: 'claude',
        models: [{ value: 'opus', effortLevels: ['high'] }],
        efforts: ['high'],
        source: 'provider'
      }
    ])
  })

  it('never asks for either when sync answers unconfigured', async () => {
    const api = fakeApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: false }) })
    const { sync } = useJevSettings()
    await sync()
    expect(api.listAgentProviders).not.toHaveBeenCalled()
    // AMENDED for ISSUE-249 (was: A-37 `listAgentModels` never called): the member left the facade at cut 5.
  })

  it('loads providers and catalogues once a save turns the section configured', async () => {
    const api = fakeApi({
      setJevApiKey: vi.fn().mockResolvedValue({ configured: true }),
      listAgentProviders: vi.fn().mockResolvedValue({ ok: true, value: [entry('codex')] })
    })
    const { providers, save } = useJevSettings()
    await save('sk-typesafe-abc123')
    expect(api.listAgentProviders).toHaveBeenCalled()
    expect(providers.value).toEqual([{ provider: 'codex', installed: true, launchable: true }])
  })

  it('degrades to empty lists rather than throwing when the bridge cannot answer', async () => {
    fakeApi({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      listAgentProviders: vi.fn().mockRejectedValue(new Error('no bridge'))
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
    const preferences = {
      profile: 'premium' as const,
      default: { provider: 'claude' as const },
      delegation: false
    }
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
    const first = setPreferences({ profile: 'balanced', default: {}, delegation: false })
    await setPreferences({ profile: 'premium', default: {}, delegation: false })
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
    await setPreferences({ profile: 'balanced', default: {}, delegation: false })
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
    const pending = setPreferences({ profile: 'balanced', default: {}, delegation: false })
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

    await setPreferences({ profile: 'economy', default: {}, delegation: false })

    expect(settings.value.preferencesError).toContain('no handler registered')
  })

  it('lets go of the control even when the write failed', async () => {
    // The defect behind "I click again and nothing happens at all": `saving`
    // gates the next attempt, so one swallowed failure disabled the control
    // for as long as the recovery took.
    fakeApi({ setJevPreferences: vi.fn().mockRejectedValue(new Error('boom')) })
    const { saving, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {}, delegation: false })

    expect(saving.value).toBe(false)
  })

  it('does not re-query the launch catalogue on the way out of a failure', async () => {
    // That query spawns a provider CLI. Doing it inside the failure path is
    // what made a failed click look like a loading click.
    const api = fakeApi({ setJevPreferences: vi.fn().mockRejectedValue(new Error('boom')) })
    const { setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {}, delegation: false })

    // AMENDED for ISSUE-249 (was: A-37 `listAgentModels` never called): the member left the facade at cut 5, and the
    // catalogue rides on A-36 `listAgentProviders` since 3a, so that is the query this failure path must not repeat.
    expect(api.listAgentProviders).not.toHaveBeenCalled()
  })

  it('carries a refusal main reported, the same way it carries a rejection', async () => {
    // Main answers with what is STORED plus why the request did not take, so
    // a refusal is an ordinary answer rather than an exception.
    fakeApi({
      setJevPreferences: vi.fn().mockResolvedValue({
        configured: true,
        preferences: { profile: 'balanced', default: {}, delegation: false },
        preferencesError: 'That default names a provider this build cannot launch.'
      })
    })
    const { settings, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {}, delegation: false })

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
          preferences: { profile: 'economy', default: {}, delegation: false }
        }))
        .mockRejectedValueOnce(new Error('boom'))
    })
    const { settings, setPreferences } = useJevSettings()

    await setPreferences({ profile: 'economy', default: {}, delegation: false })
    expect(settings.value.preferencesError).toBeTruthy()

    await setPreferences({ profile: 'economy', default: {}, delegation: false })
    expect(settings.value.preferencesError).toBeUndefined()
  })
})

/*
 * The actual defect behind "clicking Economy does nothing" (2026-09-21).
 *
 * `window.api` is a contextBridge function, so every argument is structured-
 * CLONED on its way across. A Vue reactive Proxy cannot be cloned, and the
 * bridge throws before the preload's own parser — which does build a plain
 * document — ever runs. The parser can never help: the value has to survive
 * the crossing to reach it.
 *
 * JevSettings emits `{ ...preferences.value, profile }`, and that spread is
 * SHALLOW: `profile` is replaced with a primitive, while `default` stays the
 * very Proxy it came from in the props. Hence the one clue that cracked it —
 * changing the default provider worked, because that handler builds a fresh
 * `{ provider }` object, while changing the profile reused the Proxy.
 *
 * So the plain-ing happens HERE, at the one point the renderer hands anything
 * to the bridge, rather than in each caller that could forget.
 */
describe('useJevSettings crossing the context bridge', () => {
  it('hands the bridge a document structuredClone accepts, given a reactive one', async () => {
    const sent = vi.fn(async (_preferences: JevPreferences): Promise<JevSettings> => ({
      configured: true,
      preferences: { profile: 'balanced', default: {}, delegation: false }
    }))
    fakeApi({ setJevPreferences: sent })
    const stored = reactive<JevPreferences>({
      profile: 'balanced',
      default: { provider: 'opencode' },
      delegation: false
    })
    const { setPreferences } = useJevSettings()

    // Exactly what the section emits: a shallow spread over reactive props.
    await setPreferences({ ...stored, profile: 'economy' })

    expect(() => structuredClone(sent.mock.calls[0]![0])).not.toThrow()
  })

  it('sends the values asked for, not merely something clonable', () => {
    // Plain-ing must not quietly drop a field on the way past.
    const sent = vi.fn(async (_preferences: JevPreferences): Promise<JevSettings> => ({
      configured: true,
      preferences: { profile: 'balanced', default: {}, delegation: false }
    }))
    fakeApi({ setJevPreferences: sent })
    const stored = reactive<JevPreferences>({
      profile: 'balanced',
      default: { provider: 'opencode', model: 'opencode/big-pickle', effort: 'high' },
      delegation: false
    })
    const { setPreferences } = useJevSettings()

    void setPreferences({ ...stored, profile: 'premium' })

    expect(sent.mock.calls[0]![0]).toEqual({
      profile: 'premium',
      default: { provider: 'opencode', model: 'opencode/big-pickle', effort: 'high' },
      delegation: false
    })
  })

  /* --- MCP subtask delegation: the gate preference (#511) — one block, appended --- */
  it('carries the delegation checkbox across the bridge, plain rather than a Proxy', () => {
    const sent = vi.fn(async (_preferences: JevPreferences): Promise<JevSettings> => ({
      configured: true,
      preferences: { profile: 'balanced', default: {}, delegation: true }
    }))
    fakeApi({ setJevPreferences: sent })
    const stored = reactive<JevPreferences>({
      profile: 'balanced',
      default: {},
      delegation: false
    })
    const { setPreferences } = useJevSettings()

    void setPreferences({ ...stored, delegation: true })

    expect(sent.mock.calls[0]![0]).toEqual({
      profile: 'balanced',
      default: {},
      delegation: true
    })
  })
  /* --- end of the #511 block ---------------------------------------------------- */
})

/* --- ISSUE-234: the Host-fed read model (14 §6.4 row `useJevSettings`) — one block, appended --- */
// From the step-4a switch (ISSUE-235) A-47…A-51 are served from the Host's preferences, so the section also follows the
// `preferences` snapshot section and the `preferences.changed` frames above its seq (ADR-033 items 2–3): a change made
// elsewhere (another window, a Reset) shows here. The key is never part of any value it holds (INV-107).
describe('useJevSettings as a read model of the Host (ISSUE-234)', () => {
  const EPOCH = 'epoch-0234'
  const KEY = 'ts-live-0234-0123456789abcdef'

  function preferencesView(configured: boolean, routingProfile = 'balanced') {
    return {
      preferences: {
        subagentDelegationOn: false,
        routingProfile,
        systemNotificationsOn: true,
        openCodePermissionsOn: false,
        defaultProvider: 'claude'
      },
      secrets: [{ name: 'jev-key', configured }],
      secretBackend: 'os-secret-store',
      integrations: [],
      welcome: { due: false, legacyFound: [], offered: [] }
    }
  }

  function hostApi(overrides: Record<string, unknown> = {}) {
    let listener: ((frames: unknown[]) => void) | null = null
    const api = fakeApi({
      getHostSnapshot: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            snapshotId: 'snap-10',
            seq: 10,
            epoch: EPOCH,
            chunks: [{ section: 'preferences', data: preferencesView(false) }]
          }
        })
      ),
      onHostEvent: vi.fn((follow: (frames: unknown[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }),
      ...overrides
    })
    return {
      api,
      push(seq: number, data: unknown) {
        listener?.([{ type: 'evt', seq, epoch: EPOCH, name: 'preferences.changed', data }])
      }
    }
  }

  it('[US-SET-007.AC01, NFR-SEC-04] useJevSettings exposes configured and never a key', async () => {
    const host = hostApi({
      setJevApiKey: vi.fn(async () => ({
        configured: true,
        preferences: {
          profile: 'balanced',
          default: { provider: 'claude' },
          delegation: false
        }
      }))
    })
    const jev = useJevSettings()
    expect(await jev.start()).toBe(true)
    expect(jev.settings.value.configured).toBe(false)
    await jev.save(KEY)
    expect(host.api.setJevApiKey).toHaveBeenCalledWith(KEY)
    expect(jev.settings.value.configured).toBe(true)
    // Another window saved a profile: the Host's whole view arrives, the key's status only, never the key.
    host.push(11, preferencesView(true, 'premium'))
    expect(jev.settings.value).toEqual({
      configured: true,
      preferences: { profile: 'premium', default: { provider: 'claude' }, delegation: false }
    })
    // An older frame than the last one applied changes nothing (ADR-033 item 3).
    host.push(11, preferencesView(false))
    expect(jev.settings.value.configured).toBe(true)
    expect(JSON.stringify(jev.settings.value)).not.toContain(KEY)
    jev.stop()
  })
})
/* --- end of the ISSUE-234 block ----------------------------------------------- */
