// layer: L6
// L6 (17 §1.6): A-47 `getJevSettings` / `jev:settings:get` as `JevSettingsShapeAdapter` serves it from 3a (14 §2.1
// "adapter: `HostPreferences` + `SecretStatus('jev-key')` + `SecretBackend` → `JevSettings`; the key never crosses"; 21
// §3.1), over a recording HostClient answering B-M12 `preferences.get` and today's A-47 handler answering today's stored
// Jev preferences. Every answer is checked against the registry's response schema.
//
// TC-217-03 (the A-47 half; A-48/A-49 are in src/ui-main/ipc/handlers/jevApiKey.host.contract.test.ts).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type PreferencesView
} from '@dwarfai/contracts'
import type { HostClient } from '../../ui-main/window/ports/hostClient'
import { createJevSettingsShapeAdapter, GET_JEV_SETTINGS } from './jevSettingsShapeAdapter'

const KEY = 'ts-live-0123456789abcdef'
const STORED_PREFERENCES = {
  profile: 'premium',
  default: { provider: 'claude', model: 'opus' },
  delegation: true
} as const

function view(configured: boolean, backend: PreferencesView['secretBackend']): PreferencesView {
  return {
    preferences: {
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    },
    secrets: [
      { name: 'jev-key', configured },
      { name: 'opencode-password', configured: false }
    ],
    secretBackend: backend,
    integrations: [],
    welcome: { due: false, legacyFound: [], offered: [] }
  }
}

/** The HostClient `call` the adapter uses: records each call and answers the scripted `PreferencesView`. */
class FakePreferencesHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  view: PreferencesView = view(true, 'os-secret-store')

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (method !== 'preferences.get') return Promise.reject(new Error(`unexpected ${method}`))
    return Promise.resolve(this.view) as Promise<HostResult[M]>
  }
}

/** Today's A-47 handler after the migration: today's file is gone, so its key verdict is "not configured". */
const legacy = {
  served: [] as string[],
  serve(channel: string): Promise<unknown> {
    this.served.push(channel)
    return Promise.resolve({ configured: false, preferences: STORED_PREFERENCES })
  }
}

const response = CHANNELS[GET_JEV_SETTINGS].response

describe('A-47 getJevSettings through JevSettingsShapeAdapter (14 §2.1; 21 §3.1)', () => {
  it('[US-SET-007.AC01, US-RES-006.AC01] with a key stored getJevSettings answers configured and never the key', async () => {
    const host = new FakePreferencesHost()
    const adapter = createJevSettingsShapeAdapter({ legacy, client: host })

    const answer = response.parse(await adapter.serve(GET_JEV_SETTINGS, undefined))

    expect(answer).toEqual({ configured: true, preferences: STORED_PREFERENCES })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(host.calls).toEqual([{ method: 'preferences.get', params: {} }])

    // No key in the Host: not configured; no usable OS secret store: not configured, and why.
    host.view = view(false, 'os-secret-store')
    expect(response.parse(await adapter.serve(GET_JEV_SETTINGS, undefined))).toEqual({
      configured: false,
      preferences: STORED_PREFERENCES
    })
    host.view = view(false, 'unavailable')
    expect(response.parse(await adapter.serve(GET_JEV_SETTINGS, undefined))).toEqual({
      configured: false,
      unavailableReason: 'encryption-unavailable',
      preferences: STORED_PREFERENCES
    })
  })

  it('[US-SET-007.AC07] a key TypeSafe would reject still answers configured with no validity flag', async () => {
    // The Host stores whatever key was saved; whether TypeSafe accepts it is only learnt at launch (US-RES-006).
    const host = new FakePreferencesHost()
    const adapter = createJevSettingsShapeAdapter({ legacy, client: host })

    const answer = response.parse(await adapter.read())

    expect(answer).toEqual({ configured: true, preferences: STORED_PREFERENCES })
    expect(Object.keys(answer).sort()).toEqual(['configured', 'preferences'])
    // B-M10 / B-M11 answers build the same shape: the configured flag only.
    expect(
      await adapter.fromStatus({ ok: true, value: { name: 'jev-key', configured: true } })
    ).toEqual({ configured: true, preferences: STORED_PREFERENCES })
    expect(
      await adapter.fromStatus({ ok: true, value: { name: 'jev-key', configured: false } })
    ).toEqual({ configured: false, preferences: STORED_PREFERENCES })
    expect(await adapter.fromStatus({ ok: false, error: 'backend-unavailable' })).toEqual({
      configured: false,
      unavailableReason: 'encryption-unavailable',
      preferences: STORED_PREFERENCES
    })
  })

  it('[ADR-019] a Host call error is not hidden as not configured, and another channel is refused', async () => {
    const adapter = createJevSettingsShapeAdapter({
      legacy,
      client: { call: () => Promise.reject(new Error('HOST_NOT_READY')) }
    })
    await expect(adapter.serve(GET_JEV_SETTINGS, undefined)).rejects.toThrow('HOST_NOT_READY')
    await expect(adapter.serve('jev:apiKey:set', 'k')).rejects.toThrow(
      'JevSettingsShapeAdapter does not serve jev:apiKey:set'
    )
  })
})
