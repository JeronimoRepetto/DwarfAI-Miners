// The kernel `LifecycleFactLog` over `dwarf_lifecycle_facts` (16 §3; 09 §4.2, §5.6; ADR-006
// item 1). The one writer of that table (16 §11), shared by crew and conversation.
//
// - `record` runs inside the caller's open transaction (16 §2.2), so the fact commits or rolls
//   back with the state change it proves; outside one it throws `HostInvariantError`.
// - The insert is `ON CONFLICT DO NOTHING` over every natural key of the table: the UNIQUE
//   `source_key` (`lifecycleFactKey`: identity, `turn:<dwarfId>:<turnKey>` or the provider key)
//   and `dwarf_lifecycle_facts_one_departure`. `'new'` iff a row was inserted; a repeat writes
//   nothing and answers `'duplicate'`.
// - A CHECK or foreign-key violation is not a duplicate: it throws `SqliteInfrastructureError`
//   and aborts the caller's command (16 §2.1).
// - A new `TurnEnded` row trims that dwarf's `TurnEnded` rows to the newest 50, by insert order,
//   in the same transaction (09 §5.6, §7.1): the row just inserted is always kept.
import { HostInvariantError } from '../../kernel/domain/errors'
import { lifecycleFactKey } from '../../kernel/domain/lifecycleFact'
import type { Clock } from '../../kernel/ports/clock'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFact, LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../kernel/ports/transactionScope'

/** `TurnEnded` rows kept per dwarf (09 §5.6, §7.1). */
const TURN_ENDS_KEPT = 50

const INSERT_FACT = `INSERT INTO dwarf_lifecycle_facts
  (id, dwarf_id, type, source_key, cause, exit_code, occurred_at, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING`

const TRIM_TURN_ENDS = `DELETE FROM dwarf_lifecycle_facts
  WHERE type = 'TurnEnded' AND dwarf_id = ?1 AND rowid NOT IN (
    SELECT rowid FROM dwarf_lifecycle_facts
    WHERE type = 'TurnEnded' AND dwarf_id = ?1
    ORDER BY rowid DESC
    LIMIT ?2
  )`

export interface SqliteLifecycleFactLogDeps {
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  ids: IdGenerator
  clock: Clock
}

export class SqliteLifecycleFactLog implements LifecycleFactLog {
  constructor(private readonly deps: SqliteLifecycleFactLogDeps) {}

  record(fact: LifecycleFact): 'new' | 'duplicate' {
    const { db, scope, ids, clock } = this.deps
    if (!scope.isInTransaction()) {
      throw new HostInvariantError(
        'LifecycleFactLog.record runs inside the caller transaction (16 §2.2)'
      )
    }
    const { changes } = db.run(INSERT_FACT, [
      ids.uuidv7(),
      fact.dwarfId,
      fact.type,
      lifecycleFactKey(fact),
      fact.type === 'DwarfDeparted' ? fact.cause : null,
      fact.type === 'DriverSessionExited' ? fact.exitCode : null,
      fact.occurredAt,
      clock.now()
    ])
    if (changes === 0) return 'duplicate'
    if (fact.type === 'TurnEnded') db.run(TRIM_TURN_ENDS, [fact.dwarfId, TURN_ENDS_KEPT])
    return 'new'
  }
}
