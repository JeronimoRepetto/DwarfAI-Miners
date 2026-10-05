// The ledger frame of seam B (14 §2.4 B-F20; 14 §3.5, frozen): `ledger.changed {mineId, totals}`,
// for `ui`, projected from `LedgerTotalsChanged` (08 §0; 11 F2 step 4).
//
// - The event is published after its credit's commit (16 §2.3) and handled synchronously, so the
//   frame follows the commit. The frame carries the mine's totals as read through
//   `LedgerQueries.totals` when it is sent, never the event payload, so it always has the shape of
//   the snapshot's `MineWire.totals` it updates: six materials, each its own count, never summed
//   (INV-93; US-MINE-010.AC02).
// - Within one Host tick the outbound queue keeps only the latest waiting `ledger.changed` per
//   `mineId`, at the highest seq (14 §1.8, events/outbound.ts); each frame is the mine's whole
//   totals, so the one that stays is the latest.
// - `ledger.changed` is not a sensitive frame (14 §3.5 SENSITIVE_FRAMES): ids and counts only.
// - Unbound until the ledger is wired into the Host (later: ISSUE-096).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { LedgerEvent, LedgerQueries } from '../../modules/ledger'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const LEDGER_FRAMES: readonly HostFrameName[] = Object.freeze(['ledger.changed'])

/** Where the frames go: the connection registry (connectionRegistry.ts). */
export interface LedgerFramePublisher {
  publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]): void
}

export interface LedgerFramesDeps {
  /** The ledger's events on the Host's bus (16 §2.3). */
  events: Pick<DomainEventBus<LedgerEvent>, 'subscribe'>
  ledger: LedgerQueries
  frames: LedgerFramePublisher
}

/** Routes `LedgerTotalsChanged` to `ledger.changed`; returns the unsubscribe. */
export function publishLedgerFrames(deps: LedgerFramesDeps): () => void {
  return deps.events.subscribe('LedgerTotalsChanged', (event) => {
    const { mineId } = event.payload
    deps.frames.publishFrame('ledger.changed', { mineId, totals: deps.ledger.totals(mineId) })
  })
}
