// The Jev half of `SettingsMirrorBridge` (21 §3, from 3a; 21 §2 seam-B row 3a: B-M13 extended to the Jev preferences):
// from 3a the Host routes launches and delegations through Jev, while Settings still writes the Jev preferences
// through today's A-51 handler until 4a. This half mirrors the routing profile, the default provider / model / effort
// and the delegation toggle (14 §3.4 `HostPreferenceKey`), and nothing else: never the Jev key, which moves once
// through `SecretMigrationBridge` (ADR-017 item 3), and never an integration gate (ADR-016 item 5; 18 C-21).
//
// - It reads the values through today's A-47 handler (`LegacyRuntimeRoute`), which answers what the legacy store
//   holds: the store stays the source of truth, so what is mirrored is what it stored, never what the renderer asked.
// - `reportJevWrites` wraps the route the router serves the `legacy` rows through: around today's A-51 handler it
//   reads the stored preferences before and after, and reports each Jev key the save changed to the write hub. It
//   never calls A-51 itself, so nothing is written to the legacy store.
//
// Composed only by `src/ui-main/index.ts` (05 R16), through `settingsMirrorHalves` / `reportSettingsMirrorWrites`.
// Deleted with the bridge in 4a, when the direction flips (ISSUE-230, ISSUE-236).
import type { HostPreferences, StepId } from '@dwarfai/contracts'
import { IPC_CHANNELS, parseJevPreferences, type JevPreferences } from '../../shared/contracts'
import type { LegacySettingsWriteHub } from './legacySettingsWrites'
import type { MirrorHalf } from './mirrorHalf'
import type { LegacySettingsRoute } from './notificationsHalf'

/** The Host-read Jev preferences (14 §3.4); a secret name or an integration id is not one. */
export type JevMirrorKey =
  'routingProfile' | 'defaultProvider' | 'defaultModel' | 'defaultEffort' | 'subagentDelegationOn'

/** Each Jev key from the legacy `JevPreferences` it is stored in (14 §2.1 A-51 adapter row). */
const FROM_LEGACY: { readonly [K in JevMirrorKey]: (p: JevPreferences) => HostPreferences[K] } = {
  routingProfile: (p) => p.profile,
  defaultProvider: (p) => p.default.provider,
  defaultModel: (p) => p.default.model,
  defaultEffort: (p) => p.default.effort,
  subagentDelegationOn: (p) => p.delegation
}

/** The keys the Jev half mirrors, as data (the C-21 denylist test reads this list). */
export const JEV_MIRROR_KEYS: readonly JevMirrorKey[] = Object.freeze(
  Object.keys(FROM_LEGACY) as JevMirrorKey[]
)

/** The first and last steps the Jev half is registered in: from 3a, until the bridge ends after 3e (21 §3). */
export const JEV_MIRROR_STEPS: readonly [first: StepId, last: StepId] = ['cut-3a', 'cut-3e']

/** The stored Jev preferences A-47 answers; throws on an answer that is not a `JevSettings` (14 §2.1). */
async function readStored(route: LegacySettingsRoute): Promise<JevPreferences> {
  const settings = await route.serve(IPC_CHANNELS.getJevSettings, undefined)
  if (typeof settings !== 'object' || settings === null || !('preferences' in settings)) {
    throw new Error('A-47 answered no JevSettings')
  }
  // Today's own reading of a stored document (shape tolerance only), as Settings reads it.
  return parseJevPreferences(settings.preferences)
}

export function createJevMirrorHalf(route: LegacySettingsRoute): MirrorHalf<JevMirrorKey> {
  return {
    keys: JEV_MIRROR_KEYS,
    // A failed read is not sent: the key stays pending for the next attach.
    readLegacy: async (key) => FROM_LEGACY[key](await readStored(route)) as never
  }
}

/** The Jev keys whose value differs between `before` and `after`; every key when either is unknown. */
function changedKeys(before?: JevPreferences, after?: JevPreferences): JevMirrorKey[] {
  if (before === undefined || after === undefined) return [...JEV_MIRROR_KEYS]
  return JEV_MIRROR_KEYS.filter(
    (key) => !Object.is(FROM_LEGACY[key](before), FROM_LEGACY[key](after))
  )
}

/**
 * `route`, reporting to `writes` each Jev key an A-51 save of today's handler changed, after the handler answered.
 * `route` is a plain object of closures (`createLegacyRuntimeRoute`), so its other members are carried over as they are.
 */
export function reportJevWrites<R extends LegacySettingsRoute>(
  route: R,
  writes: Pick<LegacySettingsWriteHub, 'saved'>
): R {
  const stored = (): Promise<JevPreferences | undefined> => readStored(route).catch(() => undefined)
  return {
    ...route,
    serve: async (channel: string, payload: unknown): Promise<unknown> => {
      if (channel !== IPC_CHANNELS.setJevPreferences) return route.serve(channel, payload)
      const before = await stored()
      const answer = await route.serve(channel, payload)
      for (const key of changedKeys(before, await stored())) writes.saved(key)
      return answer
    }
  }
}
