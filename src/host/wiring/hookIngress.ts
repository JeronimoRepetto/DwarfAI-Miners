// The hook ingress as the Host composes it (16 §8.2 step 6; ADR-016 items 2–3; 13 FM-038;
// ISSUE-140): the loopback HTTP listener of transport/ingress/httpIngress.ts (ISSUE-133) serving
// the `/hooks/claude/*` route boot step 4 wires (routes/askingRoutes.ts), on the stable port in
// `app_meta.ingress_port` (bridges/ingressPort.ts). Boot step 6 starts it after recovery and before
// observation and `ready`; the Host's composed end of life closes it (hostLifecycle.ts). The
// delegation MCP endpoint, step 6's other half, is not here (later: ISSUE-209).
//
// Package gap (ISSUE-140, recorded in the PR): ADR-016 item 3 has the port "chosen when the first
// HTTP integration is enabled", while 16 §8.2 step 6 starts the ingress at every boot. The ingress
// starts at every boot, so the port is chosen and persisted at the first boot, before any
// integration is on: the enable writes the hook entry with that port (wiring/bridges/
// hostConfigWriter.ts refuses an enable while none is persisted), and with every integration off
// the listener answers every request 401 (ADR-012 item 6). What the port is chosen for is the
// same; only the moment is earlier.
//
// A start that fails (no port can be bound on 127.0.0.1) is logged and never fails the boot: the
// Host never exits on its own (ADR-002 D1, D7), and observation still sees every change by polling
// (13 FM-038: a hook event is only a nudge). A persisted port that is taken is replaced inside the
// ingress (transport/ingress/ingressPort.ts, 07 S14.10) and logged there (`ingress.port`,
// `port-taken`).
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import {
  createHttpIngress,
  type HttpIngress,
  type IngressRoute
} from '../transport/ingress/httpIngress'
import type { IngressPortRecord } from '../transport/ingress/ingressPort'
import { errorCode } from './boot'

export interface HostHookIngressDeps {
  /** The ingress routes boot step 4 wired: `/hooks/claude/*` (WiredAsking.hookRoutes). */
  routes: readonly IngressRoute[]
  /** `app_meta.ingress_port` (bridges/ingressPort.ts). */
  portRecord: IngressPortRecord
  clock: Clock
  log: DiagnosticsLog
}

export function createHostHookIngress(deps: HostHookIngressDeps): HttpIngress {
  return createHttpIngress({
    routes: deps.routes,
    clock: deps.clock,
    log: deps.log,
    portRecord: deps.portRecord,
    // 07 S14.10's rewrite of the owned hook entry onto the new port has no preferences use case
    // yet (an `on-verified` enable whose entry still verifies is a no-op, 16 §7.5): the change is
    // logged by the ingress, and the entry keeps the old port until the integration is turned off
    // and on again; observation polls meanwhile (13 FM-038). Package gap, recorded in the PR.
    onPortChanged: () => undefined
  })
}

/** Boot step 6's hook-ingress half: starts the listener; a failure is logged, never thrown. */
export async function startHookIngressAtBoot(
  ingress: Pick<HttpIngress, 'start'>,
  log: DiagnosticsLog
): Promise<void> {
  try {
    await ingress.start()
  } catch (error) {
    // 19 §9.2 `ingress.port`: the port could not be bound; never the error's text (ADR-026).
    log.record({
      level: 'warn',
      event: 'ingress.port',
      subsystem: 'transport',
      outcome: 'failed',
      errCode: errorCode(error)
    })
  }
}
