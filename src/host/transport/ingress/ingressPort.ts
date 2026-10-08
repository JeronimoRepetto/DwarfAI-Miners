// The stable ingress port (ADR-016 item 3; 07 S14.10; 13 FM-038; 19 §9.2 `ingress.port`).
//
// The port is chosen the first time the ingress starts (the wiring starts it when the first HTTP
// integration is enabled), persisted in `app_meta.ingress_port`, and reused at every boot. When the
// persisted port is taken, the OS picks a new one, it is persisted, the change is logged, and
// `onPortChanged` reports it: the owned entries are rewritten through the config writer
// (`ExternalConfigWriter`, ISSUE-218) by whoever the wiring binds there, never by the ingress.
//
// `app_meta` has no module port (16 §13 O-16-08: written by platform/transport); `IngressPortRecord`
// is the transport's own injected seam onto that column, bound by the wiring.
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'

/** `app_meta.ingress_port`: `null` until the first start. */
export interface IngressPortRecord {
  read(): number | null
  write(port: number): void
}

/** A bind on 127.0.0.1: the bound port, or `'taken'` when the port is in use. */
export type ListenOutcome = { bound: number } | 'taken'

export interface IngressPortDeps {
  record: IngressPortRecord
  /** Binds the listener on `port`; 0 asks the OS for a free one. */
  listen(port: number): Promise<ListenOutcome>
  /** The persisted port was taken and replaced by `port`. */
  onPortChanged(port: number): void
  log: DiagnosticsLog
}

/** The range `app_meta.ingress_port` accepts (migration 1 CHECK). */
const MIN_PORT = 1024
const MAX_PORT = 65_535

/** Binds the ingress on its persisted port, or on a new one that is then persisted. */
export async function openIngressPort(deps: IngressPortDeps): Promise<number> {
  const persisted = deps.record.read()
  const usable = persisted !== null && isStorablePort(persisted) ? persisted : null
  if (usable !== null) {
    const outcome = await deps.listen(usable)
    if (outcome !== 'taken') return outcome.bound
  }
  const fresh = await deps.listen(0)
  if (fresh === 'taken' || !isStorablePort(fresh.bound)) {
    throw new Error('the ingress port could not be bound on 127.0.0.1')
  }
  deps.record.write(fresh.bound)
  if (usable === null) {
    deps.log.record({ level: 'info', event: 'ingress.port', subsystem: 'transport', outcome: 'ok' })
  } else {
    deps.log.record({
      level: 'info',
      event: 'ingress.port',
      subsystem: 'transport',
      outcome: 'degraded',
      causeClass: 'port-taken'
    })
    deps.onPortChanged(fresh.bound)
  }
  return fresh.bound
}

function isStorablePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}
