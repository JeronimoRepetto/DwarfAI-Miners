// The Host's end of life, composed (ADR-002 D7; 07 S12.10, S12.17): the clean exit, and the OS
// session end mapped onto it. Nothing here arms a timer: the Host never exits on its own (OQ-63;
// AMENDMENT-5 withdrew the quiescence exit and `when-idle`). The other ends call the returned
// `closeCleanly`: Stop everything and quit (ISSUE-029) and the upgrade drain (ISSUE-032).
import {
  createCleanExit,
  type CleanExit,
  type CleanExitDeps
} from '../transport/lifecycle/cleanExit'
import { closeOnOsSessionEnd, type OsSessionEndSource } from '../transport/lifecycle/osSessionEnd'

export interface HostLifecycleDeps extends CleanExitDeps {
  /** The platform's OS session-end report (host/platform/process/osSessionSignals.ts). */
  sessionEnd: OsSessionEndSource
  /** Unsubscribes the module routes that must not run once the Host is closing (ISSUE-140). */
  stopRoutes?: () => void
}

export function composeHostLifecycle(deps: HostLifecycleDeps): CleanExit {
  const clean = createCleanExit(deps)
  const cleanExit: CleanExit = {
    closeCleanly: (reason) => {
      deps.stopRoutes?.()
      return clean.closeCleanly(reason)
    }
  }
  closeOnOsSessionEnd(deps.sessionEnd, cleanExit)
  return cleanExit
}
