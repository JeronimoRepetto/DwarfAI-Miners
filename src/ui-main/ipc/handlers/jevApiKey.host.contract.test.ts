// layer: L6
// L6 (17 §1.6): A-48 `setJevApiKey` and A-49 `clearJevApiKey` (14 §2.1 KEEP, `host` from 3a; ADR-017 items 3–5;
// ADR-019 items 7, 8) as their `host` handler serves them, over a recording HostClient holding the Jev key in memory
// (B-M10 / B-M11 answer the configured flag, never the value) and an inline `JevSettingsSource` standing in for
// `JevSettingsShapeAdapter` (src/legacy-bridge, which this file may not import, 05 R16; its own A-47 cases are in
// src/legacy-bridge/secrets/jevSettingsShapeAdapter.test.ts). Every answer is checked against the registry's response
// schema.
//
// TC-217-03 (the A-48/A-49 half), TC-217-04.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type SecretSetParams,
  type SecretStatusResult
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import {
  CLEAR_JEV_API_KEY,
  createJevApiKeyRows,
  SET_JEV_API_KEY,
  type JevSettingsAnswer,
  type JevSettingsSource
} from './jevApiKey.host'

const KEY = 'ts-live-0123456789abcdef'
const MINTED = '01920000-0000-7000-a000-000000000217'
const PREFERENCES = { profile: 'balanced', default: {}, delegation: false } as const

/** The Host's B-M10 / B-M11 over an in-memory Jev key: records each call, answers the configured flag. */
class RecordingSecretHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  key: string | undefined
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    let result: SecretStatusResult
    if (method === 'settings.secret.set') {
      this.key = (params as SecretSetParams).value
      result = { ok: true, value: { name: 'jev-key', configured: true } }
    } else if (method === 'settings.secret.clear') {
      this.key = undefined
      result = { ok: true, value: { name: 'jev-key', configured: false } }
    } else {
      return Promise.reject(new Error(`unexpected ${method}`))
    }
    return Promise.resolve(result) as Promise<HostResult[M]>
  }
}

/** `JevSettingsShapeAdapter` as the rows see it: the Host's key status plus today's preferences. */
function settingsOver(host: RecordingSecretHost): JevSettingsSource & { reads: number } {
  const source = {
    reads: 0,
    read: (): Promise<JevSettingsAnswer> => {
      source.reads += 1
      return Promise.resolve({ configured: host.key !== undefined, preferences: PREFERENCES })
    },
    fromStatus: (result: SecretStatusResult): Promise<JevSettingsAnswer> =>
      Promise.resolve(
        result.ok
          ? { configured: result.value.configured, preferences: PREFERENCES }
          : {
              configured: false,
              unavailableReason: 'encryption-unavailable',
              preferences: PREFERENCES
            }
      )
  }
  return source
}

function rowsOver(host: RecordingSecretHost) {
  const settings = settingsOver(host)
  return { settings, rows: createJevApiKeyRows({ client: host, settings, mintId: () => MINTED }) }
}

const setResponse = CHANNELS[SET_JEV_API_KEY].response
const clearResponse = CHANNELS[CLEAR_JEV_API_KEY].response

describe('A-48 setJevApiKey and A-49 clearJevApiKey, host handler (14 §2.1)', () => {
  it('[US-SET-007.AC02] setJevApiKey relays settings.secret.set once and answers JevSettings configured, the signal the renderer shows "Jev key saved" on', async () => {
    const host = new RecordingSecretHost()
    const { rows } = rowsOver(host)

    const answer = setResponse.parse(await rows.serve(SET_JEV_API_KEY, `  ${KEY}\n`))

    expect(answer).toEqual({ configured: true, preferences: PREFERENCES })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(host.calls).toEqual([
      {
        method: 'settings.secret.set',
        params: { name: 'jev-key', value: KEY, requestId: MINTED, origin: 'settings' }
      }
    ])
    expect(host.key).toBe(KEY)

    // Replace: a second save sends the new key, once.
    setResponse.parse(await rows.serve(SET_JEV_API_KEY, 'ts-replacement'))
    expect(host.calls).toHaveLength(2)
    expect(host.key).toBe('ts-replacement')
  })

  it('[US-SET-007.AC03] clearJevApiKey relays settings.secret.clear and answers JevSettings not configured, the signal for "Jev key cleared"', async () => {
    const host = new RecordingSecretHost()
    host.key = KEY
    const { rows } = rowsOver(host)

    const answer = clearResponse.parse(await rows.serve(CLEAR_JEV_API_KEY, undefined))

    expect(answer).toEqual({ configured: false, preferences: PREFERENCES })
    expect(host.calls).toEqual([
      { method: 'settings.secret.clear', params: { name: 'jev-key', requestId: MINTED } }
    ])
    expect(host.key).toBeUndefined()
  })

  it('[ADR-019] an empty, non-string or over-cap value is refused in main with the legacy failure shape and never crosses', async () => {
    const host = new RecordingSecretHost()
    host.key = KEY
    const { rows, settings } = rowsOver(host)

    const malformed: unknown[] = [
      '',
      '   ',
      42,
      undefined,
      null,
      { key: KEY },
      'a'.repeat(513),
      'two words',
      'ts-\u0000-control',
      'ts-“smart”'
    ]
    for (const payload of malformed) {
      // The legacy failure shape: the JevSettings in force, unchanged.
      expect(setResponse.parse(await rows.serve(SET_JEV_API_KEY, payload))).toEqual({
        configured: true,
        preferences: PREFERENCES
      })
    }
    expect(host.calls).toEqual([])
    expect(settings.reads).toBe(malformed.length)
    expect(host.key).toBe(KEY)

    // The cap itself is a key.
    setResponse.parse(await rows.serve(SET_JEV_API_KEY, 'a'.repeat(512)))
    expect(host.calls).toHaveLength(1)
  })

  it('[ADR-017] a Host refusal or a store with no OS secret service answers the state in force, never a thrown call', async () => {
    const host = new RecordingSecretHost()
    const { rows } = rowsOver(host)

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(setResponse.parse(await rows.serve(SET_JEV_API_KEY, KEY))).toEqual({
      configured: false,
      preferences: PREFERENCES
    })
    expect(clearResponse.parse(await rows.serve(CLEAR_JEV_API_KEY, undefined))).toEqual({
      configured: false,
      preferences: PREFERENCES
    })

    // `backend-unavailable` is the B-M10 outcome: not configured, and why (ADR-017 item 5, no plain-text fallback).
    const unavailable: Pick<HostClient, 'call'> = {
      call: <M extends HostMethod>(): Promise<HostResult[M]> =>
        Promise.resolve({ ok: false, error: 'backend-unavailable' }) as Promise<HostResult[M]>
    }
    const settings = settingsOver(host)
    const bare = createJevApiKeyRows({ client: unavailable, settings, mintId: () => MINTED })
    expect(setResponse.parse(await bare.serve(SET_JEV_API_KEY, KEY))).toEqual({
      configured: false,
      unavailableReason: 'encryption-unavailable',
      preferences: PREFERENCES
    })

    expect(await rows.serve('jev:settings:get', undefined)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
  })
})
