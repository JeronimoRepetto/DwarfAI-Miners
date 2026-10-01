// B-M02 `ping` (14 §2.3, §3.4; ADR-003 item 9, frozen): the transport's own protocol method. Every role
// of the UI endpoint may call it (`ui`, `notifier`, `viewer`, roles.ts), it is served while the Host
// is `starting` or `migrating` too (the protocol set, 14 §3.3), and it answers the Host's time,
// read from the injected Clock. The UI pings every 5 s while idle; any frame it sends, a ping
// included, keeps its connection alive (liveness.ts).
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { Clock } from '../../kernel/ports/clock'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

/** Serves `ping` on `dispatcher`. */
export function registerPing(dispatcher: Dispatcher, clock: Clock): void {
  dispatcher.register(
    'ping',
    HOST_METHOD_SCHEMAS.ping.params,
    METHOD_ROLES['ping'] ?? [],
    (): HostMethods['ping']['result'] => ({ at: clock.now() })
  )
}
