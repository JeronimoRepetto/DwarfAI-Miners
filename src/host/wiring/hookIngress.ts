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
//
// 07 S14.10 (#1289): once bound, the step has the Host's own Claude hook entry follow the bound
// port (bridges/hostConfigWriter.ts `claudeHookEntryFollower`, the config writer engine's
// `followIngressPort`), awaited inside step 6, so before observation and `ready`. Package gaps,
// recorded in the PR: (1) the trigger is every bind, not only the ingress's `onPortChanged`: the
// engine writes only an entry that names another port than the bound one, so the port change is
// the case that writes, and a rewrite a full disk refused or a crash interrupted is made at the
// next boot instead of leaving the entry on a dead port; (2) the rewrite is not a consent and not
// an enable (16 §7.5's no-op is the enable's): it is a boot operation of the engine, as the S14.11
// settlement is, so no frozen port gains a member; (3) the change is logged twice: `ingress.port`
// `port-taken` by the ingress, and `config.write` with `causeClass` `ingress-port-changed` by the
// engine.
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
    // 07 S14.10's rewrite runs after every bind (startHookIngressAtBoot's `followPort`), which the
    // port change is one case of; nothing more is done at the moment of the change.
    onPortChanged: () => undefined
  })
}

/**
 * Boot step 6's hook-ingress half: starts the listener, then has the Host's own Claude hook entry
 * follow the bound port (07 S14.10, bridges/hostConfigWriter.ts `claudeHookEntryFollower`); a
 * failure of either is logged, never thrown.
 */
export async function startHookIngressAtBoot(
  ingress: Pick<HttpIngress, 'start'>,
  log: DiagnosticsLog,
  followPort: () => Promise<void> = () => Promise.resolve()
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
    return
  }
  try {
    await followPort()
  } catch (error) {
    // 19 §9.5 `config.write`: the cause class only, never the error's text (ADR-026).
    log.record({
      level: 'warn',
      event: 'config.write',
      subsystem: 'claude-hooks',
      outcome: 'failed',
      errCode: errorCode(error)
    })
  }
}
