// The observation module's step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; ADR-023 items
// 1, 3, 4; ADR-029 §B; 09 §7.2 rows `source_cursors`, `observed_session_streams`,
// `observed_sessions`, `ended_agents`). It joins the saga's one `db` transaction (16 §2.2): called
// outside one it throws `HostInvariantError` and writes nothing.
//
// Everything observation owns is kept, so the step writes nothing:
// - the observed sessions and stream links of present dwarfs stay (ADR-023 item 3, ADR-006 item
//   9); those of the dwarfs the mines and crew steps delete go with them by cascade;
// - every `ended_agents` row stays (INV-36): wiping it would let ended subagents re-appear as
//   ghosts (ADR-029 §B);
// - every `source_cursors` row stays. 09 §7.2 keeps those of present dwarfs and states no deletion
//   for the others (package gap, resolved here): a cursor holds a read position, no content, and
//   dropping one would re-read a departed session's file from the start, re-importing what the
//   reset wiped (the `message_keys` rule: nothing older than the reset is re-imported, OQ-32 A).
//
// It is still a registered step: the saga's `db` step names every board module's table set (16
// §4.12), and the guard keeps a call outside the transaction a loud defect. It satisfies
// `ResetDbStep` structurally: observation has no edge to `preferences` (05 §1.3, R4).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'

export interface ObservationResetStepDeps {
  /** The Host's one writer (09 §8.1); the step writes nothing through it. */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

export class ObservationResetStep {
  readonly name = 'observation'

  constructor(private readonly deps: ObservationResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the observation ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    // Nothing to delete: see the header. Joined so the step is part of the one transaction.
    tx.inTransaction(() => undefined)
  }
}
