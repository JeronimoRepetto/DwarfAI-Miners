// layer: L6
// L6 (17 §1.6): A-54 `setOpenCodeServerPassword` and A-55 `clearOpenCodeServerPassword` (14 §2.1 CHANGE, `host` from
// 4a; §3.8 `OpenCodeSettingsView`; ADR-017 items 3–5; ADR-019 items 7, 8; UC-029, the password half) as their `host`
// handler serves them, over a recording Host holding the password in an in-memory secret store (B-M10 / B-M11 answer
// the configured flag, never the value; B-M12 `preferences.get` answers the `preferences` section). Every answer is
// checked against the registry's response schema.
//
// TC-231-02.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type PreferencesView,
  type SecretBackend,
  type SecretSetParams,
  type SecretStatusResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import {
  CLEAR_OPENCODE_PASSWORD,
  createOpenCodePasswordRows,
  SET_OPENCODE_PASSWORD
} from './openCodePassword.host'

const PASSWORD = ' s3cret pass phrase '
const MINTED = '01920000-0000-7000-a000-000000000231'

/**
 * The Host's B-M10 / B-M11 / B-M12 over an in-memory secret store (`FakeSecretStore` semantics, 16 §4.12.1): records
 * each call; with no usable backend `set` stores nothing and answers `backend-unavailable` (ADR-017 item 5).
 */
class RecordingSecretHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  password: string | undefined
  backend: SecretBackend = 'os-secret-store'
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    if (method === 'settings.secret.set') {
      let result: SecretStatusResult = { ok: false, error: 'backend-unavailable' }
      if (this.backend === 'os-secret-store') {
        this.password = (params as SecretSetParams).value
        result = { ok: true, value: { name: 'opencode-password', configured: true } }
      }
      return Promise.resolve(result) as Promise<HostResult[M]>
    }
    if (method === 'settings.secret.clear') {
      this.password = undefined
      const result: SecretStatusResult = {
        ok: true,
        value: { name: 'opencode-password', configured: false }
      }
      return Promise.resolve(result) as Promise<HostResult[M]>
    }
    if (method === 'preferences.get') {
      return Promise.resolve(this.view()) as Promise<HostResult[M]>
    }
    return Promise.reject(new Error(`unexpected ${method}`))
  }

  /** The `preferences` section as the Host answers it: configured flags only, OpenCode permissions on. */
  view(): PreferencesView {
    return {
      preferences: {} as PreferencesView['preferences'],
      secrets: [
        { name: 'jev-key', configured: false },
        { name: 'opencode-password', configured: this.password !== undefined }
      ],
      secretBackend: this.backend,
      integrations: [
        {
          id: 'opencode-permissions',
          state: 'on-verified',
          consentOrigin: 'settings',
          changedAt: '2026-10-17T09:00:00.000Z' as never
        }
      ],
      welcome: { due: false, legacyFound: [], offered: [] }
    }
  }
}

function rowsOver(host: RecordingSecretHost) {
  return createOpenCodePasswordRows({ client: host, mintId: () => MINTED })
}

const setResponse = CHANNELS[SET_OPENCODE_PASSWORD].response
const clearResponse = CHANNELS[CLEAR_OPENCODE_PASSWORD].response

describe('A-54 setOpenCodeServerPassword and A-55 clearOpenCodeServerPassword, host handler (14 §2.1)', () => {
  it('[US-SET-009.AC03] setOpenCodeServerPassword stores the value and answers passwordConfigured true with no field holding the password, the signal for "OpenCode password saved"', async () => {
    const host = new RecordingSecretHost()
    const rows = rowsOver(host)

    const answer = setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, PASSWORD))

    expect(answer).toEqual({
      ok: true,
      value: {
        permissions: 'on-verified',
        consentOrigin: 'settings',
        passwordConfigured: true,
        secretBackend: 'os-secret-store'
      }
    })
    expect(JSON.stringify(answer)).not.toContain(PASSWORD.trim())
    // Relayed once as B-M10, the value unaltered (spaces are part of a password).
    expect(host.calls.filter(({ method }) => method.startsWith('settings.secret.'))).toEqual([
      {
        method: 'settings.secret.set',
        params: {
          name: 'opencode-password',
          value: PASSWORD,
          requestId: MINTED,
          origin: 'settings'
        }
      }
    ])
    expect(host.password).toBe(PASSWORD)
  })

  it('[US-SET-009.AC04] clearOpenCodeServerPassword answers passwordConfigured false, the signal for "OpenCode password cleared"', async () => {
    const host = new RecordingSecretHost()
    host.password = PASSWORD
    const rows = rowsOver(host)

    const answer = clearResponse.parse(await rows.serve(CLEAR_OPENCODE_PASSWORD, undefined))

    expect(answer).toEqual({
      ok: true,
      value: {
        permissions: 'on-verified',
        consentOrigin: 'settings',
        passwordConfigured: false,
        secretBackend: 'os-secret-store'
      }
    })
    expect(host.calls.filter(({ method }) => method.startsWith('settings.secret.'))).toEqual([
      {
        method: 'settings.secret.clear',
        params: { name: 'opencode-password', requestId: MINTED }
      }
    ])
    expect(host.password).toBeUndefined()
  })

  it('[US-SET-009.AC05] after a stored password a new set replaces it and answers the same stored state', async () => {
    const host = new RecordingSecretHost()
    host.password = PASSWORD
    const rows = rowsOver(host)

    const answer = setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, 'replacement'))

    expect(answer).toMatchObject({ ok: true, value: { passwordConfigured: true } })
    expect(JSON.stringify(answer)).not.toContain('replacement')
    expect(host.password).toBe('replacement')
    expect(host.calls.filter(({ method }) => method === 'settings.secret.set')).toHaveLength(1)
  })

  it('[FM-115] an unavailable secret service answers the backend-unavailable outcome and stores nothing', async () => {
    const host = new RecordingSecretHost()
    host.backend = 'unavailable'
    const rows = rowsOver(host)

    const answer = setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, PASSWORD))

    expect(answer).toEqual({
      ok: true,
      value: {
        permissions: 'on-verified',
        consentOrigin: 'settings',
        passwordConfigured: false,
        secretBackend: 'unavailable'
      }
    })
    expect(host.password).toBeUndefined()
  })

  it('[ADR-019] an empty, non-string or over-cap value is refused in main with INVALID_PARAMS and never crosses', async () => {
    const host = new RecordingSecretHost()
    const rows = rowsOver(host)

    for (const payload of ['', 42, undefined, null, { password: PASSWORD }, 'a'.repeat(1025)]) {
      expect(setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, payload))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toEqual([])

    // The cap itself is a password.
    expect(
      setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, 'a'.repeat(1024)))
    ).toMatchObject({ ok: true, value: { passwordConfigured: true } })
  })

  it('[ADR-017] a Host call error is the result error branch, never a throw, and no other channel is served', async () => {
    const host = new RecordingSecretHost()
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    const rows = rowsOver(host)

    expect(setResponse.parse(await rows.serve(SET_OPENCODE_PASSWORD, PASSWORD))).toEqual({
      ok: false,
      error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    })
    expect(clearResponse.parse(await rows.serve(CLEAR_OPENCODE_PASSWORD, undefined))).toEqual({
      ok: false,
      error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    })
    expect(await rows.serve('opencode:settings:get', undefined)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
