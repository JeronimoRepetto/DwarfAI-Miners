// The Host's seam-B Dispatcher as main.ts composes it (05 §2.3, 14 §2.3): built once, with the
// transport's own methods registered — `ping` (B-M02) today. Each module method joins it here, in
// the wiring, with the issue that serves it, so that a composition test proves what production
// serves.
import { Dispatcher, type DispatcherDeps } from '../transport/dispatcher'
import { registerPing } from '../transport/methods/ping'

/** The production Dispatcher, with every method the Host serves registered. */
export function createHostDispatcher(deps: DispatcherDeps): Dispatcher {
  const dispatcher = new Dispatcher(deps)
  registerPing(dispatcher, deps.clock)
  return dispatcher
}
