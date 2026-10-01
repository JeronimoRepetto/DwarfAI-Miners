// The Host's seam-B Dispatcher as main.ts composes it (05 §2.3, 14 §2.3): built once, with the
// transport's own methods registered — `ping` (B-M02) and `host.shutdown` (B-M05). Each module
// method joins it here, in the wiring, with the issue that serves it, so that a composition test
// proves what production serves.
import type { StopAllPort } from '../kernel/ports/stopAll'
import { Dispatcher, type DispatcherDeps } from '../transport/dispatcher'
import type { CleanExit } from '../transport/lifecycle/cleanExit'
import { registerHostShutdown } from '../transport/methods/hostShutdown'
import { registerPing } from '../transport/methods/ping'

export interface HostDispatcherDeps extends DispatcherDeps {
  /** What `host.shutdown {stop-all}` asks to end every owned session (empty-owner until ISSUE-175). */
  stopAll: StopAllPort
  /** The Host's clean exit (composeHostLifecycle). */
  lifecycle: CleanExit
}

/** The production Dispatcher, with every method the Host serves registered. */
export function createHostDispatcher(deps: HostDispatcherDeps): Dispatcher {
  const dispatcher = new Dispatcher(deps)
  registerPing(dispatcher, deps.clock)
  registerHostShutdown(dispatcher, deps)
  return dispatcher
}
