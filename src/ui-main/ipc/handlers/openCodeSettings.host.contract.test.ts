// layer: L6
// L6 (17 §1.6): A-52 `getOpenCodeSettings` and A-53 `setOpenCodePluginEnabled` (14 §2.1 CHANGE rows, `host`, owner
// preferences; §3.4 `SetOpenCodePermissionsParams` → `IpcResult<SetOpenCodePermissionsResult>`; §3.8
// `OpenCodeSettingsView`; ADR-011 item 7; ADR-016 items 5–7; ADR-019 items 7, 8) as their `host` handler serves them,
// over a faked HostClient: A-52 builds the view from B-M12 `preferences.get`, A-53 validates the renderer's payload
// against the registry's request (the same object as B-M14's params, 14 §1.2), mints nothing and relays
// `preferences.setOpenCodePermissions` unchanged; every answer is checked against the registry's response schema.
//
// TC-228-01 and TC-228-02, their seam-A half.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type PreferencesView,
  type SetOpenCodePermissionsResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import {
  createOpenCodeSettingsRows,
  GET_OPENCODE_SETTINGS,
  SET_OPENCODE_PLUGIN
} from './openCodeSettings.host'

const REQUEST = '01920000-0000-7000-a000-000000000228'
const T0 = 1_760_000_000_000

/** A fresh install's `PreferencesView` (14 §3.6): both integrations off, nothing stored. */
const FRESH: PreferencesView = {
  preferences: {
    subagentDelegationOn: false,
    routingProfile: 'balanced',
    systemNotificationsOn: true
  },
  secrets: [
    { name: 'jev-key', configured: false },
    { name: 'opencode-password', configured: false }
  ],
  secretBackend: 'os-secret-store',
  integrations: [
    { id: 'claude-hooks', state: 'off', changedAt: T0 },
    { id: 'opencode-permissions', state: 'off', changedAt: T0 }
  ],
  welcome: { due: false, legacyFound: [], offered: [] }
}

/** The HostClient `call` the rows use: records each call and answers the scripted result, or refuses. */
class FakeOpenCodeHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  view: PreferencesView = FRESH
  result: SetOpenCodePermissionsResult = { ok: true, value: { state: 'on-verified' } }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    const answer = method === 'preferences.get' ? this.view : this.result
    return Promise.resolve(answer) as Promise<HostResult[M]>
  }
}

describe('A-52 getOpenCodeSettings and A-53 setOpenCodePluginEnabled, host handler (14 §2.1, §3.4, §3.8)', () => {
  it('[US-SET-009.AC07, INV-106] getOpenCodeSettings reads off with no consent origin on a fresh install, then the stored state, origin, password flag and secret backend', async () => {
    const host = new FakeOpenCodeHost()
    const rows = createOpenCodeSettingsRows(host)
    const response = CHANNELS[GET_OPENCODE_SETTINGS].response

    expect(response.parse(await rows.serve(GET_OPENCODE_SETTINGS, undefined))).toEqual({
      ok: true,
      value: { permissions: 'off', passwordConfigured: false, secretBackend: 'os-secret-store' }
    })
    expect(host.calls).toEqual([{ method: 'preferences.get', params: {} }])

    host.view = {
      ...FRESH,
      secrets: [{ name: 'opencode-password', configured: true }],
      integrations: [
        { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings', changedAt: T0 },
        {
          id: 'opencode-permissions',
          state: 'on-verified',
          consentOrigin: 'add-panel',
          changedAt: T0
        }
      ]
    }
    expect(response.parse(await rows.serve(GET_OPENCODE_SETTINGS, undefined))).toEqual({
      ok: true,
      value: {
        permissions: 'on-verified',
        consentOrigin: 'add-panel',
        passwordConfigured: true,
        secretBackend: 'os-secret-store'
      }
    })
  })

  it('[ADR-011] setOpenCodePluginEnabled with origin settings or add-panel relays B-M14 and answers IpcResult of the new state; first-run is refused', async () => {
    const host = new FakeOpenCodeHost()
    const rows = createOpenCodeSettingsRows(host)
    const response = CHANNELS[SET_OPENCODE_PLUGIN].response

    for (const origin of ['settings', 'add-panel'] as const) {
      const payload = { on: true, origin, requestId: REQUEST }
      expect(response.parse(await rows.serve(SET_OPENCODE_PLUGIN, payload))).toEqual({
        ok: true,
        value: { ok: true, value: { state: 'on-verified' } }
      })
      expect(host.calls.at(-1)).toEqual({
        method: 'preferences.setOpenCodePermissions',
        params: payload
      })
    }

    // A locked turn-off: an outcome of the result, the option still on (16 §7.4).
    host.result = { ok: false, error: 'config-revert-failed' }
    expect(
      response.parse(
        await rows.serve(SET_OPENCODE_PLUGIN, { on: false, origin: 'settings', requestId: REQUEST })
      )
    ).toEqual({ ok: true, value: { ok: false, error: 'config-revert-failed' } })

    // first-run is B-M40's only (AMENDMENT-7): refused before anything reaches the Host.
    const sent = host.calls.length
    const refused = response.parse(
      await rows.serve(SET_OPENCODE_PLUGIN, { on: true, origin: 'first-run', requestId: REQUEST })
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    for (const payload of [
      true,
      { on: true, requestId: REQUEST },
      { on: true, origin: 'settings' }
    ]) {
      expect(await rows.serve(SET_OPENCODE_PLUGIN, payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toHaveLength(sent)
  })

  it('[ADR-019] a Host refusal is the result error branch, never a throw; another channel is refused, never guessed', async () => {
    const host = new FakeOpenCodeHost()
    const rows = createOpenCodeSettingsRows(host)
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }

    expect(
      CHANNELS[SET_OPENCODE_PLUGIN].response.parse(
        await rows.serve(SET_OPENCODE_PLUGIN, { on: true, origin: 'settings', requestId: REQUEST })
      )
    ).toEqual({ ok: false, error: host.refusal })
    expect(
      CHANNELS[GET_OPENCODE_SETTINGS].response.parse(
        await rows.serve(GET_OPENCODE_SETTINGS, undefined)
      )
    ).toEqual({ ok: false, error: host.refusal })
    expect(await rows.serve('opencode:password:set', 'secret')).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
