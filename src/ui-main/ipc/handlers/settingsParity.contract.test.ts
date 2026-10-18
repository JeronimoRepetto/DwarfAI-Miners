// layer: L6
// L6 settings parity (17 §1.6; 21 §2 4a exit "Settings parity"): A-42 / A-43 (system notifications) and A-47 / A-51
// (the Jev settings) as their `host` handlers serve them from step 4a answer the recorded legacy shape for the same
// inputs (`__fixtures__/settings-parity.legacy.json`, today's answers written by hand from today's handlers), and A-51
// stores one `preferences.set` per changed key (14 §2.1 A-51 adapter).
//
// The Host is a recording double holding `HostPreferences` in memory: it refuses `preferences.set` params with the
// contract's own schema (`HOST_METHOD_SCHEMAS`, as the Host's transport does, INVALID_PARAMS) and applies the 09 §4.8
// rule the preferences module applies (a model or effort only with a provider). The real preferences module cannot be
// composed here (05 R10: the UI trees never import the Host); its own suite proves that rule
// (src/host/modules/preferences/application/preferencesService.test.ts, INV-105).
//
// TC-230-01, TC-230-02, TC-230-03.
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_IDS,
  CHANNELS,
  HOST_METHOD_SCHEMAS,
  type ChannelKey,
  type HostMethod,
  type HostParams,
  type HostPreferences,
  type HostResult,
  type IpcError,
  type PreferencesView
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { composeRouteTargets } from '../composeRouteTargets'
import LEGACY from './__fixtures__/settings-parity.legacy.json'
import {
  createHostJevSettings,
  createJevSettingsRows,
  GET_JEV_SETTINGS,
  JEV_SETTINGS_ROWS,
  SET_JEV_PREFERENCES
} from './jevSettings.host'
import {
  createSystemNotificationsRows,
  GET_NOTIFICATIONS_ENABLED,
  SET_NOTIFICATIONS_ENABLED,
  SYSTEM_NOTIFICATIONS_ROWS
} from './systemNotifications.host'

const MINTED = '01920000-0000-7000-a000-000000000230'

/** Migration 1's seed row (09 §4.9): delegation off, routing balanced, notifications on, no default provider. */
const SEED: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

type KeyState = 'unset' | 'set' | 'unavailable'

/** The Host's B-M12 / B-M13 over in-memory preferences, recording each call. */
class PreferencesHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  preferences: HostPreferences = { ...SEED }
  refusal: IpcError | null = null

  constructor(private readonly key: KeyState = 'unset') {}

  sets(): unknown[] {
    return this.calls.filter((c) => c.method === 'preferences.set').map((c) => c.params)
  }

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    if (method === 'preferences.get') {
      const view: PreferencesView = {
        preferences: this.preferences,
        secrets: [
          { name: 'jev-key', configured: this.key === 'set' },
          { name: 'opencode-password', configured: false }
        ],
        secretBackend: this.key === 'unavailable' ? 'unavailable' : 'os-secret-store',
        integrations: [],
        welcome: { due: false, legacyFound: [], offered: [] }
      }
      return Promise.resolve(view) as Promise<HostResult[M]>
    }
    if (method === 'preferences.set') {
      const parsed = HOST_METHOD_SCHEMAS['preferences.set'].params.safeParse(params)
      if (!parsed.success) {
        return Promise.reject(
          new HostCallError({ code: 'INVALID_PARAMS', message: 'refused', retryable: false })
        )
      }
      const next: Record<string, unknown> = {
        ...this.preferences,
        [parsed.data.key]: parsed.data.value
      }
      // 09 §4.8: without a default provider there is no default model or effort.
      if (next.defaultProvider === undefined) {
        next.defaultModel = undefined
        next.defaultEffort = undefined
      }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      this.preferences = next as unknown as HostPreferences
      return Promise.resolve(this.preferences) as Promise<HostResult[M]>
    }
    return Promise.reject(new Error(`unexpected ${method}`))
  }
}

/** From now on `host` refuses every `preferences.set` (recorded) with a TIMEOUT; its reads still answer. */
function refuseSets(host: PreferencesHost): void {
  const call = host.call.bind(host)
  host.call = (<M extends HostMethod>(method: M, params: HostParams[M]) => {
    if (method !== 'preferences.set') return call(method, params)
    host.calls.push({ method, params })
    return Promise.reject(new HostCallError({ code: 'TIMEOUT', message: 'late', retryable: true }))
  }) as typeof host.call
}

/** The four rows over `host`, as the root composes them where the 4a table routes them `host`. */
function rowsOver(host: PreferencesHost) {
  const mintId = () => MINTED
  const target = composeRouteTargets([
    {
      channels: SYSTEM_NOTIFICATIONS_ROWS,
      target: createSystemNotificationsRows({ client: host, mintId })
    },
    {
      channels: JEV_SETTINGS_ROWS,
      target: createJevSettingsRows({
        client: host,
        settings: createHostJevSettings(host),
        mintId
      })
    }
  ])
  return (channel: ChannelKey, payload?: unknown): Promise<unknown> =>
    target.serve(channel, payload).then((answer) => {
      // Every answer keeps today's shape (14 §2.1 KEEP).
      CHANNELS[channel].response.parse(answer)
      return answer
    })
}

const jev = (
  profile: 'economy' | 'balanced' | 'premium',
  launchDefault: { provider?: string; model?: string; effort?: string },
  delegation: boolean
) => ({ profile, default: launchDefault, delegation })

describe('Settings rows served by the Host (14 §2.1 A-42, A-43, A-47, A-51; 21 §2 4a)', () => {
  it('[ADR-001] for the same inputs A-42, A-43, A-47 and A-51 served by the Host answer the recorded legacy shape', async () => {
    for (const scenario of LEGACY.scenarios) {
      const host = new PreferencesHost(scenario.key as KeyState)
      const serve = rowsOver(host)
      for (const step of scenario.steps) {
        const payload = 'payload' in step ? step.payload : undefined
        expect(
          await serve(step.channel as ChannelKey, payload),
          `${scenario.name}: ${step.row}`
        ).toEqual(step.answer)
      }
    }
  })

  it('[ADR-001] a malformed A-43 value or a Host call error answers the switch in force and stores nothing', async () => {
    const host = new PreferencesHost()
    const serve = rowsOver(host)
    expect(await serve(SET_NOTIFICATIONS_ENABLED, 'yes')).toBe(true)
    expect(host.sets()).toEqual([])
    expect(await serve(SET_NOTIFICATIONS_ENABLED, false)).toBe(false)
    expect(host.sets()).toEqual([{ key: 'systemNotificationsOn', value: false, requestId: MINTED }])
    // A refused write answers what is stored (today's row has no error branch); a refused read rejects (14 §1.5).
    refuseSets(host)
    expect(await serve(SET_NOTIFICATIONS_ENABLED, true)).toBe(false)
    host.refusal = { code: 'HOST_UNAVAILABLE', message: 'down', retryable: true }
    await expect(serve(SET_NOTIFICATIONS_ENABLED, true)).rejects.toThrow('HOST_UNAVAILABLE')
    await expect(serve(GET_NOTIFICATIONS_ENABLED)).rejects.toThrow('HOST_UNAVAILABLE')
  })

  it('[US-SET-007.AC04] a routing profile set through A-51 is stored as the sole value and a fresh install reads balanced', async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    expect(await serve(GET_JEV_SETTINGS)).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
    for (const profile of ['premium', 'economy'] as const) {
      expect(await serve(SET_JEV_PREFERENCES, jev(profile, {}, false))).toEqual({
        configured: true,
        preferences: jev(profile, {}, false)
      })
      expect(host.preferences.routingProfile).toBe(profile)
    }
    // Exactly that key, once per change (TC-230-02).
    expect(host.sets()).toEqual([
      { key: 'routingProfile', value: 'premium', requestId: MINTED },
      { key: 'routingProfile', value: 'economy', requestId: MINTED }
    ])
  })

  it('[US-SET-007.AC06] the delegation toggle set through A-51 is stored and read back through A-47', async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    await serve(SET_JEV_PREFERENCES, jev('balanced', {}, true))
    expect(host.preferences.subagentDelegationOn).toBe(true)
    expect(await serve(GET_JEV_SETTINGS)).toEqual({
      configured: true,
      preferences: jev('balanced', {}, true)
    })
    await serve(SET_JEV_PREFERENCES, jev('balanced', {}, false))
    expect(await serve(GET_JEV_SETTINGS)).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
    expect(host.sets()).toEqual([
      { key: 'subagentDelegationOn', value: true, requestId: MINTED },
      { key: 'subagentDelegationOn', value: false, requestId: MINTED }
    ])
  })

  it('[US-SET-008.AC01] Default provider None stores no model and no effort', async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    await serve(
      SET_JEV_PREFERENCES,
      jev('balanced', { provider: 'claude', model: 'opus', effort: 'high' }, false)
    )
    const before = host.sets().length
    expect(await serve(SET_JEV_PREFERENCES, jev('balanced', {}, false))).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
    expect(host.preferences).toEqual(SEED)
    // "None" is the one write: the Host clears the model and effort with it (09 §4.8).
    expect(host.sets().slice(before)).toEqual([
      { key: 'defaultProvider', value: undefined, requestId: MINTED }
    ])
    // A model or effort with no provider is never stored: nothing is written, the state in force answers.
    const after = host.sets().length
    expect(await serve(SET_JEV_PREFERENCES, jev('balanced', { model: 'opus' }, false))).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
    expect(host.sets().slice(after)).toEqual([])
  })

  it("[US-SET-008.AC02] a real Default provider keeps its model and effort, drawn from that provider's catalog models", async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    const codex = { provider: 'codex', model: 'gpt-5-codex', effort: 'high' }
    expect(await serve(SET_JEV_PREFERENCES, jev('balanced', codex, false))).toEqual({
      configured: true,
      preferences: jev('balanced', codex, false)
    })
    // The provider first, so its model and effort are kept with it (09 §4.8).
    expect(host.sets()).toEqual([
      { key: 'defaultProvider', value: 'codex', requestId: MINTED },
      { key: 'defaultModel', value: 'gpt-5-codex', requestId: MINTED },
      { key: 'defaultEffort', value: 'high', requestId: MINTED }
    ])
    // Another provider with that provider's own model: the effort left at "CLI default" is cleared.
    const claude = { provider: 'claude', model: 'opus' }
    expect(await serve(SET_JEV_PREFERENCES, jev('balanced', claude, false))).toEqual({
      configured: true,
      preferences: jev('balanced', claude, false)
    })
    expect(host.sets().slice(3)).toEqual([
      { key: 'defaultProvider', value: 'claude', requestId: MINTED },
      { key: 'defaultModel', value: 'opus', requestId: MINTED },
      { key: 'defaultEffort', value: undefined, requestId: MINTED }
    ])
  })

  it('[US-SET-008.AC04, R12] the Default provider values accepted are exactly the catalog ids plus None', async () => {
    const request = CHANNELS[SET_JEV_PREFERENCES].request
    const carried = CATALOG_PROVIDER_IDS.filter(
      (id) => request.safeParse(jev('balanced', { provider: id }, false)).success
    )
    // A-51 carries the catalog's ids (today's row leaves out only the development-only simulated provider).
    expect(carried.length).toBeGreaterThanOrEqual(CATALOG_PROVIDER_IDS.length - 1)
    for (const id of carried) {
      const host = new PreferencesHost('set')
      const serve = rowsOver(host)
      expect(await serve(SET_JEV_PREFERENCES, jev('balanced', { provider: id }, false))).toEqual({
        configured: true,
        preferences: jev('balanced', { provider: id }, false)
      })
      expect(host.preferences.defaultProvider).toBe(id)
      await serve(SET_JEV_PREFERENCES, jev('balanced', {}, false))
      expect(host.preferences.defaultProvider).toBeUndefined()
    }
    // A provider stored by a development build that today's row cannot carry reads as None, as today's parser
    // degrades it, never as an answer outside today's shape.
    const dev = new PreferencesHost('set')
    dev.preferences = { ...SEED, defaultProvider: 'simulated', defaultModel: 'demo' }
    expect(await rowsOver(dev)(GET_JEV_SETTINGS)).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
  })

  it('[US-SET-008.AC05] Other is refused as a Default provider however many custom commands were used', async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    await serve(SET_JEV_PREFERENCES, jev('balanced', { provider: 'claude' }, false))
    const before = host.sets().length
    for (const other of ['other', 'Other…', 'aider', 'my-agent --flag']) {
      expect(await serve(SET_JEV_PREFERENCES, jev('balanced', { provider: other }, false))).toEqual(
        {
          configured: true,
          preferences: jev('balanced', { provider: 'claude' }, false)
        }
      )
    }
    expect(host.sets().slice(before)).toEqual([])
    expect(host.preferences.defaultProvider).toBe('claude')
  })

  it('[US-SET-008.AC07, ADR-001] a fresh install reads Default provider None and Default model and effort CLI default, whatever providers are installed', async () => {
    // OQ-72 A: "Default provider" starts at "None" on a fresh install; the Host's seed row has no provider, and nothing
    // the installed providers say changes it (the A-47 answer reads the stored preferences only).
    for (const key of ['unset', 'set', 'unavailable'] as const) {
      const answer = (await rowsOver(new PreferencesHost(key))(GET_JEV_SETTINGS)) as {
        preferences: unknown
      }
      expect(answer.preferences).toEqual(jev('balanced', {}, false))
    }
  })

  it('[ADR-001] a Host call error on A-51 answers the Jev settings in force', async () => {
    const host = new PreferencesHost('set')
    const serve = rowsOver(host)
    refuseSets(host)
    expect(await serve(SET_JEV_PREFERENCES, jev('premium', {}, true))).toEqual({
      configured: true,
      preferences: jev('balanced', {}, false)
    })
    // The first refused write ends the request: no later key is sent.
    expect(host.sets()).toEqual([{ key: 'routingProfile', value: 'premium', requestId: MINTED }])
  })
})
