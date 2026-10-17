// `JevSettingsShapeAdapter` (21 §3.1, A-47, steps 3a–4a; 14 §2.1 rows A-47…A-49): from 3a the Jev key lives only in
// the Host's `SecretStore` (ADR-017 items 3, 4), while the Jev preferences are still today's (written through today's
// A-51 handler until 4a). This adapter answers today's `JevSettings` from both:
//
// - `configured` is the Host's `SecretStatus('jev-key')` (B-M12 `preferences.get`, `PreferencesView.secrets`), never
//   today's file, which `SecretMigrationBridge` deleted; with no usable OS secret store (`secretBackend:
//   'unavailable'`, ADR-017 item 5) the key is not configured and the reason is today's `encryption-unavailable`;
// - `preferences` are today's stored Jev preferences, read through today's A-47 handler (`LegacyRuntimeRoute`), as
//   `SettingsMirrorBridge`'s Jev half reads them; its key verdict is dropped;
// - nothing else: never the key (it never leaves the Host), never a validity flag (US-SET-007.AC07, US-RES-006: a
//   rejected key is discovered at launch, never in Settings), never `preferencesError` (only A-51 answers one).
//
// A-48 and A-49 (`src/ui-main/ipc/handlers/jevApiKey.host.ts`) answer through `fromStatus`, so their answer is built
// from the B-M10 / B-M11 result the same way. A Host call error is not hidden: the read rejects (14 §1.5).
//
// Composed only by `src/ui-main/index.ts` (05 R16) where a route of the table names it; deleted after 4a, when the
// Host serves A-47 (later: ISSUE-230, ISSUE-236).
//
// Candidate decision (21 §6): no candidate exists; new code (today's `withJevPreferences` merge in `src/main/index.ts`
// reads the key verdict from today's file, which no longer exists from 3a).
import type { SecretStatusResult } from '@dwarfai/contracts'
import {
  IPC_CHANNELS,
  parseJevPreferences,
  type JevPreferences,
  type JevSettings
} from '../../shared/contracts'
import type { HostClient } from '../../ui-main/window/ports/hostClient'

/** The name the route table lists and A-47's route names (21 §3.1). */
export const JEV_SETTINGS_SHAPE_ADAPTER = 'JevSettingsShapeAdapter'

/** A-47 (invoke), by its registry key. */
export const GET_JEV_SETTINGS = 'jev:settings:get'

/** Where today's Jev preferences are read: today's runtime, served through `LegacyRuntimeRoute`. */
export interface LegacyJevRoute {
  serve(channel: string, payload: unknown): Promise<unknown>
}

export interface JevSettingsShapeAdapter {
  /** A-47 as a route target. */
  serve(channel: string, payload: unknown): Promise<unknown>
  /** The `JevSettings` in force now. */
  read(): Promise<JevSettings>
  /** The `JevSettings` after a B-M10 / B-M11 answer. */
  fromStatus(result: SecretStatusResult): Promise<JevSettings>
}

/** Today's stored Jev preferences, as today's A-47 handler answers them (shape tolerance only, as Settings reads them). */
async function legacyPreferences(legacy: LegacyJevRoute): Promise<JevPreferences> {
  const settings = await legacy.serve(IPC_CHANNELS.getJevSettings, undefined)
  if (typeof settings !== 'object' || settings === null || !('preferences' in settings)) {
    throw new Error('A-47 answered no JevSettings')
  }
  return parseJevPreferences(settings.preferences)
}

/** The key verdict: configured or not, and today's reason when no OS secret store can hold it (ADR-017 item 5). */
type KeyVerdict = Pick<JevSettings, 'configured' | 'unavailableReason'>
const UNAVAILABLE: KeyVerdict = { configured: false, unavailableReason: 'encryption-unavailable' }

export function createJevSettingsShapeAdapter(deps: {
  legacy: LegacyJevRoute
  client: Pick<HostClient, 'call'>
}): JevSettingsShapeAdapter {
  const { legacy, client } = deps

  const withPreferences = async (verdict: KeyVerdict): Promise<JevSettings> => ({
    ...verdict,
    preferences: await legacyPreferences(legacy)
  })

  const read = async (): Promise<JevSettings> => {
    const view = await client.call('preferences.get', {})
    if (view.secretBackend === 'unavailable') return withPreferences(UNAVAILABLE)
    const key = view.secrets.find((secret) => secret.name === 'jev-key')
    return withPreferences({ configured: key?.configured === true })
  }

  return {
    serve: (channel) =>
      channel === GET_JEV_SETTINGS
        ? read()
        : Promise.reject(new Error(`${JEV_SETTINGS_SHAPE_ADAPTER} does not serve ${channel}`)),
    read,
    fromStatus: (result) =>
      withPreferences(result.ok ? { configured: result.value.configured } : UNAVAILABLE)
  }
}
