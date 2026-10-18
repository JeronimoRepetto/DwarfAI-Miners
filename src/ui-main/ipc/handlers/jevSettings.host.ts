// A-47 `getJevSettings` / `jev:settings:get` and A-51 `setJevPreferences` / `jev:preferences:set` served by their `host`
// handler from step 4a (14 §2.1 KEEP rows with adapters, `host`, owner preferences; 21 §2 cut 4a "New core serves";
// UC-038; ADR-017 item 3). The Host is the source of truth of the Jev preferences from here: today's `JevSettings` is
// built from B-M12 `preferences.get`, and the mirror direction of `SettingsMirrorBridge` ends (21 §3).
//
// - A-47 (adapter: `HostPreferences` + `SecretStatus('jev-key')` + `SecretBackend` → `JevSettings`): `configured` is
//   the Jev key's own status, never another secret's; with no usable OS secret store (`secretBackend: 'unavailable'`,
//   ADR-017 item 5) the key is not configured and the reason is today's `encryption-unavailable`. The preferences map
//   one to one: `routingProfile` → `profile`, `defaultProvider/Model/Effort` → `default` (absent = "None" / "CLI
//   default", 09 §4.9; OQ-72 A), `subagentDelegationOn` → `delegation`. Never the key (it never leaves the Host), never
//   a validity flag (US-SET-007.AC07), never `preferencesError` (only a refused legacy write answered one).
// - A-51 (adapter: one `preferences.set` per changed key): the request is checked with the registry's request schema
//   (today's providers: the catalog, never "Other…", 06 §14.2, PO #36); a request it refuses, or a model or effort with
//   no provider (09 §4.8: never stored), writes nothing. Otherwise each key that differs from what the Host stores is
//   sent once, in the order routing profile, default provider, model, effort, delegation, each with a `requestId` main
//   mints (14 §1.6), and compared with what the previous write STORED (INV-105): the provider goes first, so "None"
//   clears the model and effort in that one write and a real provider keeps the model and effort that follow it. The
//   answer is the `JevSettings` stored after the writes. Today's row has no error branch: a Host call error ends the
//   request and answers the `JevSettings` in force; only when that read fails too does the call reject (14 §1.4, §1.5).
// - KEEP rows: the step-4a switch (ISSUE-235) routes them `host`, and the root composes this part only where the table
//   routes them so (22 §5); a call of any other channel is refused, never guessed (14 §1.5).
//
// `createHostJevSettings` is also the `JevSettingsSource` of A-48 / A-49 (`jevApiKey.host.ts`) once A-47 is served by
// the Host, in place of `JevSettingsShapeAdapter`, which read today's preferences until 4a (21 §3.1).
//
// Candidate decision (21 §6): today's `jevPreferences.ts` store (and its tests) keeps the preferences in a userData file
// and re-validates a default against today's launch gate; from 4a the Host's `PreferencesStore` is the one writer
// (16 §4.12; 21 §1 item 4), so it is replaced by this relay. The Host's `PreferencesService.set` is kept unchanged: it
// already applies the 09 §4.8 rule in the write (evidence: preferencesService.test.ts "[INV-105] clearing the default
// provider clears its default model and effort", passing).
import type {
  ChannelKey,
  HostPreferenceKey,
  HostPreferences,
  PreferencesView,
  SecretStatusResult
} from '@dwarfai/contracts'
import { CHANNELS } from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'
import type { JevSettingsAnswer, JevSettingsSource } from './jevApiKey.host'

/** A-47 and A-51 (invoke), by their registry keys. */
export const GET_JEV_SETTINGS = 'jev:settings:get' satisfies ChannelKey
export const SET_JEV_PREFERENCES = 'jev:preferences:set' satisfies ChannelKey
/** The invoke rows this target serves. */
export const JEV_SETTINGS_ROWS = [GET_JEV_SETTINGS, SET_JEV_PREFERENCES] as const

type JevPreferencesAnswer = JevSettingsAnswer['preferences']
type LaunchDefault = JevPreferencesAnswer['default']

/** A-51's request schema (today's `JevPreferences`), and its provider: the providers today's rows carry. */
const REQUEST = CHANNELS[SET_JEV_PREFERENCES].request
const TODAY_PROVIDER = REQUEST.shape.default.shape.provider

/** The key verdict: configured or not, and today's reason when no OS secret store can hold it (ADR-017 item 5). */
type KeyVerdict = Pick<JevSettingsAnswer, 'configured' | 'unavailableReason'>
const UNAVAILABLE: KeyVerdict = { configured: false, unavailableReason: 'encryption-unavailable' }

/**
 * The default launch as today's row carries it. A stored provider today's rows cannot carry (only the
 * development-only simulated provider) reads as "None", as today's parser degrades an unknown provider.
 */
function launchDefaultOf(preferences: HostPreferences): LaunchDefault {
  const provider = TODAY_PROVIDER.safeParse(preferences.defaultProvider)
  if (!provider.success || provider.data === undefined) return {}
  return {
    provider: provider.data,
    ...(preferences.defaultModel === undefined ? {} : { model: preferences.defaultModel }),
    ...(preferences.defaultEffort === undefined ? {} : { effort: preferences.defaultEffort })
  }
}

function jevPreferencesOf(preferences: HostPreferences): JevPreferencesAnswer {
  return {
    profile: preferences.routingProfile,
    default: launchDefaultOf(preferences),
    delegation: preferences.subagentDelegationOn
  }
}

/** A-47's adapter: today's `JevSettings` from the Host's preferences view. */
export function jevSettingsOf(
  view: Pick<PreferencesView, 'preferences' | 'secrets' | 'secretBackend'>
): JevSettingsAnswer {
  const key = view.secrets.find((secret) => secret.name === 'jev-key')
  const verdict: KeyVerdict =
    view.secretBackend === 'unavailable' ? UNAVAILABLE : { configured: key?.configured === true }
  return { ...verdict, preferences: jevPreferencesOf(view.preferences) }
}

/** The `JevSettings` the Host holds, for A-47 and, from 4a, for A-48 / A-49's answers. */
export function createHostJevSettings(client: Pick<HostClient, 'call'>): JevSettingsSource {
  const view = () => client.call('preferences.get', {})
  return {
    read: () => view().then(jevSettingsOf),
    fromStatus: (result: SecretStatusResult) =>
      view().then((current) => ({
        ...(result.ok ? { configured: result.value.configured } : UNAVAILABLE),
        preferences: jevPreferencesOf(current.preferences)
      }))
  }
}

/** One write of B-M13 without its `requestId`. */
type Change = { [K in HostPreferenceKey]: { key: K; value: HostPreferences[K] } }[HostPreferenceKey]

/** A-51's request as the Host's keys, in write order (the provider before its model and effort, 09 §4.8). */
function changesOf(request: JevPreferencesAnswer): Change[] {
  return [
    { key: 'routingProfile', value: request.profile },
    { key: 'defaultProvider', value: request.default.provider },
    { key: 'defaultModel', value: request.default.model },
    { key: 'defaultEffort', value: request.default.effort },
    { key: 'subagentDelegationOn', value: request.delegation }
  ]
}

export function createJevSettingsRows(deps: {
  client: Pick<HostClient, 'call'>
  settings: JevSettingsSource
  mintId: () => string
}): RouteTarget {
  const { client, settings, mintId } = deps

  /** One `preferences.set` per key that differs from what the previous write stored; then the stored answer. */
  const store = async (request: JevPreferencesAnswer): Promise<JevSettingsAnswer> => {
    let stored: HostPreferences = (await client.call('preferences.get', {})).preferences
    for (const change of changesOf(request)) {
      if (stored[change.key] === change.value) continue
      try {
        stored = await client.call('preferences.set', { ...change, requestId: mintId() })
      } catch {
        break
      }
    }
    return settings.read()
  }

  return {
    serve(channel, payload): Promise<unknown> {
      if (channel === GET_JEV_SETTINGS) return settings.read()
      if (channel === SET_JEV_PREFERENCES) {
        const request = REQUEST.safeParse(payload)
        if (!request.success) return settings.read()
        const { provider, model, effort } = request.data.default
        if (provider === undefined && (model !== undefined || effort !== undefined)) {
          return settings.read()
        }
        return store(request.data)
      }
      return Promise.resolve({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: `no route for ${channel}`, retryable: false }
      })
    }
  }
}
