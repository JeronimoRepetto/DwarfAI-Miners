// The notifications half of `SettingsMirrorBridge` (21 §3, from cut 1; 14 §5 row "Presence and notifications"): the
// Host decides OS notifications from cut 1, while the "System notifications" toggle is still served by today's
// settings rows A-42 / A-43 until 4a. This half mirrors `systemNotificationsOn` only, and nothing else: no secret
// (ADR-017 item 3), no integration gate (ADR-016 item 5).
//
// - It reads the value through today's A-42 handler (`LegacyRuntimeRoute`), which answers the legacy store's value:
//   the store stays the source of truth, so what is mirrored is what it stored, never what the renderer asked for.
// - `reportNotificationsWrites` wraps the route the router serves the `legacy` rows through: after today's A-43
//   handler answered, it reports the save to the write hub, and the bridge reads the stored value back. It never
//   calls A-43 itself, so nothing is written to the legacy store.
//
// Composed only by `src/ui-main/index.ts` (05 R16). Deleted with the bridge in 4a, when the direction flips.
import { IPC_CHANNELS } from '../../shared/contracts'
import type { LegacyRuntimeRoute } from '../LegacyRuntimeRoute'
import type { LegacySettingsWriteHub } from './legacySettingsWrites'
import type { MirrorHalf } from './mirrorHalf'

/** The part of `LegacyRuntimeRoute` this half reads through: today's handler per wire name. */
export type LegacySettingsRoute = Pick<LegacyRuntimeRoute, 'serve'>

export function createNotificationsMirrorHalf(
  route: LegacySettingsRoute
): MirrorHalf<'systemNotificationsOn'> {
  return {
    keys: ['systemNotificationsOn'],
    readLegacy: async () => {
      const stored = await route.serve(IPC_CHANNELS.getNotificationsEnabled, undefined)
      // A-42 answers a boolean (14 §2.1); anything else is not sent, and the key stays pending.
      if (typeof stored !== 'boolean') throw new Error('A-42 answered no boolean')
      return stored
    }
  }
}

/**
 * `route`, reporting each A-43 save of today's handler to `writes` after the handler answered. `route` is a plain
 * object of closures (`createLegacyRuntimeRoute`), so its other members are carried over as they are.
 */
export function reportNotificationsWrites<R extends LegacySettingsRoute>(
  route: R,
  writes: Pick<LegacySettingsWriteHub, 'saved'>
): R {
  return {
    ...route,
    serve: async (channel: string, payload: unknown): Promise<unknown> => {
      const answer = await route.serve(channel, payload)
      if (channel === IPC_CHANNELS.setNotificationsEnabled) writes.saved('systemNotificationsOn')
      return answer
    }
  }
}
