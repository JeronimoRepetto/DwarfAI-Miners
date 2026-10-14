// The Host's end of life, composed (ADR-002 D7; 07 S12.10, S12.17): the clean exit, and the OS
// session end mapped onto it. Nothing here arms a timer: the Host never exits on its own (OQ-63;
// AMENDMENT-5 withdrew the quiescence exit and `when-idle`). The other ends call the returned
// `closeCleanly`: Stop everything and quit (ISSUE-029) and the upgrade drain (ISSUE-032). Every
// way in first stops the module routes and closes the hook ingress listener (ISSUE-140), so no
// event or hook request reaches a closing Host, then runs the clean exit.
import {
  createCleanExit,
  type CleanExit,
  type CleanExitDeps
} from '../transport/lifecycle/cleanExit'
import { closeOnOsSessionEnd, type OsSessionEndSource } from '../transport/lifecycle/osSessionEnd'
import { errorCode } from './boot'

export interface HostLifecycleDeps extends CleanExitDeps {
  /** The platform's OS session-end report (host/platform/process/osSessionSignals.ts). */
  sessionEnd: OsSessionEndSource
  /** Unsubscribes the module routes that must not run once the Host is closing (ISSUE-140). */
  stopRoutes?: () => void
  /** Closes the hook ingress listener (16 §8.2 step 6; ISSUE-140). */
  closeIngress?: () => Promise<void>
}

export function composeHostLifecycle(deps: HostLifecycleDeps): CleanExit {
  const clean = createCleanExit(deps)
  const cleanExit: CleanExit = {
    closeCleanly: (reason) => {
      deps.stopRoutes?.()
      const { closeIngress } = deps
      // Without an ingress the clean exit starts on this tick, as before ISSUE-140.
      if (closeIngress === undefined) return clean.closeCleanly(reason)
      // No hook request reaches a closing Host. A close that fails must not hold the exit: the
      // process ending releases the port anyway.
      return closeIngress()
        .catch((error: unknown) =>
          deps.log.record({
            level: 'error',
            event: 'uncaught',
            subsystem: 'transport',
            errCode: errorCode(error)
          })
        )
        .then(() => clean.closeCleanly(reason))
    }
  }
  closeOnOsSessionEnd(deps.sessionEnd, cleanExit)
  return cleanExit
}
