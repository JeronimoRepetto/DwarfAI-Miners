// The UI preference map rows (14 §2.2 A-N20 `getUiPreferences`, A-N21 `setUiPreference`: NEW, `ui-local`, owner
// `window` (UiPreferences); 14 §3.9 `UiPreferencesMap`, `UiPreferenceWrite`; ADR-024 items 1, 9): a route target of
// the router (ADR-001 item 3), so every call has passed the seam A gate first, sender and payload (`validate.ts`,
// ADR-019 items 7, 8): a write of `lastMode` or `resetEpochApplied`, of a key not built, or with an extra field never
// reaches it, it is answered `INVALID_PARAMS`.
//
// - A-N20 answers the stored value of each asked key that is built, nothing for any other.
// - A-N21 answers what was stored (14 §1.4): for `startWithSystem` the verified login-entry state, which may differ from
//   the request (AMENDMENT-6); the window that asked shows the one message when it does (07 S40.06). A write of a key
//   this build does not serve (`startWithSystem` while S-027-4 has not passed on this OS) is `NOT_SUPPORTED`.
//
// The rows are born `ui-local` in cut 1 and listed in `unrouted.ts` until the cut-1 switch (ISSUE-123) routes them; in
// a table without their routes the router refuses them like a channel with no route. A call of any other channel is
// refused, never guessed (14 §1.5).
import type { ChannelKey, IpcError, UiPreferenceKey, UiPreferenceWrite } from '@dwarfai/contracts'
import type { UiPreferenceMap } from '../../window/application/uiPreferenceMap'
import type { RouteTarget } from '../router'

/** A-N20 (invoke). */
export const UI_PREFERENCES_GET = 'ui:preferences:get' satisfies ChannelKey
/** A-N21 (invoke). */
export const UI_PREFERENCES_SET = 'ui:preferences:set' satisfies ChannelKey
/** The rows this target serves. */
export const UI_PREFERENCE_MAP_ROWS = [UI_PREFERENCES_GET, UI_PREFERENCES_SET] as const

function refused(code: IpcError['code'], message: string): { ok: false; error: IpcError } {
  return { ok: false, error: { code, message, retryable: false } }
}

export function createUiPreferenceMapRows(map: UiPreferenceMap): RouteTarget {
  return {
    serve(channel, payload) {
      if (channel === UI_PREFERENCES_GET) {
        return Promise.resolve(map.get((payload as { keys: UiPreferenceKey[] }).keys))
      }
      if (channel === UI_PREFERENCES_SET) {
        const write = payload as UiPreferenceWrite
        const stored = map.set(write)
        if (stored.ok) return Promise.resolve(stored.value)
        return Promise.resolve(
          stored.error === 'ui-main-only'
            ? refused('INVALID_PARAMS', `${write.key} is written by UI main only`)
            : refused('NOT_SUPPORTED', `${write.key} is not served by this build`)
        )
      }
      return Promise.resolve(refused('METHOD_NOT_FOUND', `no ui-local handler for ${channel}`))
    }
  }
}
