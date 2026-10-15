// The Host's DrainGate binding (ADR-002 D8 items 2–3; 07 S12.14, S12.15; lead decision 2026-09-30 in ISSUE-032;
// #1290). The upgrade drain (transport/lifecycle/drain.ts) is built with the dispatcher, before boot step 4 wires the
// modules whose facts hold it, so host/main.ts hands it this gate and each module's gate is bound here once wired:
// the asking module's live asks (`createAskDrainGate`, #1290), and the launching module's open turns, in-flight
// launches and non-resumable sessions (later: EPIC-10). It reports every bound gate's blockers, read at each ask, so
// nothing holds the drain before any is bound (cut 0: the drain goes at once). It only reads.
//
// `routeDrainRechecks`: an ask that closes asks the drain again at once (ISSUE-032: "re-checked on each relevant
// event"), instead of waiting for the drain's own tick. The unsubscribe goes with the module routes at the clean exit.
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { DrainBlocker, DrainGate } from '../kernel/ports/drainGate'
import type { AskClosed } from '../modules/asking'
import type { UpgradeDrain } from '../transport/lifecycle/drain'

export interface HostDrainGate extends DrainGate {
  /** Adds a module's gate (boot step 4); it holds the drain from the next read on. */
  bind(gate: DrainGate): void
}

export function createHostDrainGate(): HostDrainGate {
  const bound: DrainGate[] = []
  return {
    bind: (gate) => {
      bound.push(gate)
    },
    blockers: (): readonly DrainBlocker[] => bound.flatMap((gate) => gate.blockers())
  }
}

/** Re-checks the drain on each `AskClosed`; returns the unsubscribe. */
export function routeDrainRechecks(deps: {
  events: Pick<DomainEventBus<AskClosed>, 'subscribe'>
  drain: Pick<UpgradeDrain, 'recheck'>
}): () => void {
  return deps.events.subscribe('AskClosed', () => deps.drain.recheck())
}
