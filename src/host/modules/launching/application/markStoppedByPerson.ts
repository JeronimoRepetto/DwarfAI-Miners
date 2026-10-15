// `LaunchCommands.markStoppedByPerson` (05 §3.5; 16 §4.5 row `markStoppedByPerson`, §2.3; 07 S4.05,
// S15.01; PO #62; AR-24; ISSUE-171): the route target of crew's `DwarfStopRequested` with
// `why ≠ 'host-recovery'` (wiring/routes/launching.ts `routeStops`), subscribed as the bus's one
// required handler.
//
// It commits `launch_records.stopped_by_person = 1` on the dwarf's live record in its own
// transaction, synchronously inside the publish, so the person's stop is persisted before
// `SessionTerminator.end` runs and the exit never raises the "stopped unexpectedly" toast (FM-060;
// application/sessionExited.ts reads it). A dwarf with no live record (an observed one) is left
// alone, and a repeat is idempotent (`LaunchRecordStore`). A write that fails throws, the bus
// rethrows it to the publishing crew command, and that command ends nothing (16 §2.3).
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { LaunchRecordStore } from '../ports/launchRecordStore'

export interface MarkStoppedByPersonDeps {
  records: Pick<LaunchRecordStore, 'markStoppedByPerson'>
  transactions: TransactionRunner
}

export class MarkStoppedByPerson {
  constructor(private readonly deps: MarkStoppedByPersonDeps) {}

  mark(dwarfId: DwarfId): void {
    const { records, transactions } = this.deps
    transactions.inTransaction(() => records.markStoppedByPerson(dwarfId))
  }
}
