// A-42 `getNotificationsEnabled` / `notifications:enabled:get` and A-43 `setNotificationsEnabled` /
// `notifications:enabled:set` served by their `host` handler from step 4a (14 §2.1 KEEP rows, `host`, owner
// preferences; 21 §2 cut 4a "New core serves"; ADR-024 D1; ADR-018 D2): the Host's `HostPreferences.systemNotificationsOn`
// is the switch, read and written through B-M12 `preferences.get` and B-M13 `preferences.set`.
//
// - A-42 answers the stored value; a Host call error rejects (14 §1.5: the preload's `invokeOrReject` carries it).
// - A-43 relays a boolean as one `preferences.set {key:'systemNotificationsOn'}` with a `requestId` main mints (today's
//   payload has none, 14 §1.6), and answers what the Host STORED (INV-105). As today's handler, a malformed payload
//   changes nothing and answers the switch in force; today's row has no error branch, so a Host call error answers the
//   stored value too (14 §2.1 A-43 eM "as the unchanged value"), and only when that read fails as well does the call
//   reject.
// - KEEP rows: the step-4a switch (ISSUE-235) routes them `host`, and the root composes this part only where the table
//   routes them so (22 §5); a call of any other channel is refused, never guessed (14 §1.5).
//
// Candidate decision (21 §6): today's handlers in `src/main/index.ts` keep the switch in a userData file
// (`notificationPreference.ts`), a second writer from 4a (21 §1 item 4); replaced by this relay. Today's rule for a
// malformed payload is kept.
import type { ChannelKey } from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-42 and A-43 (invoke), by their registry keys. */
export const GET_NOTIFICATIONS_ENABLED = 'notifications:enabled:get' satisfies ChannelKey
export const SET_NOTIFICATIONS_ENABLED = 'notifications:enabled:set' satisfies ChannelKey
/** The invoke rows this target serves. */
export const SYSTEM_NOTIFICATIONS_ROWS = [
  GET_NOTIFICATIONS_ENABLED,
  SET_NOTIFICATIONS_ENABLED
] as const

export function createSystemNotificationsRows(deps: {
  client: Pick<HostClient, 'call'>
  mintId: () => string
}): RouteTarget {
  const { client, mintId } = deps

  /** The switch the Host stores now. */
  const stored = (): Promise<boolean> =>
    client.call('preferences.get', {}).then((view) => view.preferences.systemNotificationsOn)

  return {
    serve(channel, payload): Promise<unknown> {
      if (channel === GET_NOTIFICATIONS_ENABLED) return stored()
      if (channel === SET_NOTIFICATIONS_ENABLED) {
        if (typeof payload !== 'boolean') return stored()
        return client
          .call('preferences.set', {
            key: 'systemNotificationsOn',
            value: payload,
            requestId: mintId()
          })
          .then(
            (preferences) => preferences.systemNotificationsOn,
            () => stored()
          )
      }
      return Promise.resolve({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: `no route for ${channel}`, retryable: false }
      })
    }
  }
}
