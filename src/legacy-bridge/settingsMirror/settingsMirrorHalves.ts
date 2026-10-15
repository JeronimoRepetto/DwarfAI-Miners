// Registers the halves of `SettingsMirrorBridge` per release step (21 §3): kept outside the bridge core, which the
// halves' write hub imports, so the import graph has no cycle (05 R5).
//
// Composed only by `src/ui-main/index.ts` (05 R16). Deleted with the bridge in 4a, when the direction flips.
import { STEP_ORDER, type StepId } from '@dwarfai/contracts'
import { JEV_MIRROR_STEPS, createJevMirrorHalf, reportJevWrites } from './jevMirror'
import type { LegacySettingsWriteHub } from './legacySettingsWrites'
import type { MirrorHalf } from './mirrorHalf'
import {
  createNotificationsMirrorHalf,
  reportNotificationsWrites,
  type LegacySettingsRoute
} from './notificationsHalf'

/** Whether the Jev half is registered in `release` (`JEV_MIRROR_STEPS`, in `STEP_ORDER`). */
function jevHalfIn(release: StepId): boolean {
  const [first, last] = JEV_MIRROR_STEPS
  const at = STEP_ORDER.indexOf(release)
  return at >= STEP_ORDER.indexOf(first) && at <= STEP_ORDER.indexOf(last)
}

/**
 * The halves `src/ui-main/index.ts` registers for `release`, each reading through `route`: the notifications half
 * (ISSUE-116, from cut 1) and the Jev half (ISSUE-194, from 3a until the bridge ends after 3e).
 */
export function settingsMirrorHalves(release: StepId, route: LegacySettingsRoute): MirrorHalf[] {
  return [
    createNotificationsMirrorHalf(route),
    ...(jevHalfIn(release) ? [createJevMirrorHalf(route)] : [])
  ]
}

/** `route`, reporting to `writes` the legacy saves of the keys `settingsMirrorHalves(release)` mirrors. */
export function reportSettingsMirrorWrites<R extends LegacySettingsRoute>(
  release: StepId,
  route: R,
  writes: Pick<LegacySettingsWriteHub, 'saved'>
): R {
  const notifications = reportNotificationsWrites(route, writes)
  return jevHalfIn(release) ? reportJevWrites(notifications, writes) : notifications
}
