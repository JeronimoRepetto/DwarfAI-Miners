// `SqliteActivityLog` (16 §4.6 `ActivityLog`; 05 §3.6): a dwarf's activity runs over
// `activity_disclosures` (09 §4.4), in bound SQL only, through the kernel `SqliteDatabase` port
// (R11). Every call runs inside the caller's transaction (16 §2.2; outside one it throws
// `HostInvariantError`).
//
// - `saveDisclosure` inserts the run, or updates it in place under its id (`open`, `step_count`,
//   `summaries_json`, `closed_at`; the dwarf, the key and the opening instant never change). The
//   partial UNIQUE index `activity_disclosures_one_open` refuses a second open run of a dwarf
//   (INV-66): the statement throws and the caller's transaction rolls back. Then 09 §5.2 step 4,
//   verbatim: the dwarf's newest `ACTIVITY_RUNS_PER_DWARF` runs stay, the open one ranked first so
//   it is never trimmed.
// - `openRun` reads the dwarf's open run through `activity_disclosures_one_open` (16 §4.6, amendment A).
// - Summaries are one line per step and never tool output (ADR-007 item 4): stored as given.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ActivityDisclosure } from '../domain/activityRun'
import { ACTIVITY_RUNS_PER_DWARF } from '../domain/retention'
import type { ActivityLog } from '../ports/activityLog'

export interface SqliteActivityLogDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const SAVE = `INSERT INTO activity_disclosures
    (id, dwarf_id, turn_key, open, step_count, summaries_json, opened_at, closed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    open = excluded.open,
    step_count = excluded.step_count,
    summaries_json = excluded.summaries_json,
    closed_at = excluded.closed_at`

// 09 §5.2 step 4, with the cap bound rather than written in.
const TRIM = `DELETE FROM activity_disclosures
 WHERE dwarf_id = ? AND open = 0
   AND id NOT IN (SELECT id FROM activity_disclosures WHERE dwarf_id = ?
                  ORDER BY open DESC, opened_at DESC, id DESC LIMIT ?)`

const OPEN_RUN = `SELECT id, dwarf_id, turn_key, open, step_count, summaries_json, opened_at, closed_at
  FROM activity_disclosures WHERE dwarf_id = ? AND open = 1`

export class SqliteActivityLog implements ActivityLog {
  constructor(private readonly deps: SqliteActivityLogDeps) {}

  saveDisclosure(d: ActivityDisclosure): void {
    this.inTransaction('saveDisclosure')
    const { db } = this.deps
    db.run(SAVE, [
      d.id,
      d.dwarfId,
      d.turnKey,
      d.open ? 1 : 0,
      d.stepCount,
      JSON.stringify(d.summaries),
      d.openedAt,
      d.closedAt ?? null
    ])
    db.run(TRIM, [d.dwarfId, d.dwarfId, ACTIVITY_RUNS_PER_DWARF])
  }

  openRun(dwarfId: DwarfId): ActivityDisclosure | null {
    this.inTransaction('openRun')
    const row = this.deps.db.all(OPEN_RUN, [dwarfId])[0]
    return row === undefined ? null : disclosureOf(row)
  }

  private inTransaction(member: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `ActivityLog.${member} runs inside the caller transaction (16 §2.2)`
      )
    }
  }
}

/** One `activity_disclosures` row as the aggregate `ActivityDisclosure`. */
function disclosureOf(row: Record<string, unknown>): ActivityDisclosure {
  const closedAt = row['closed_at']
  return {
    id: String(row['id']),
    dwarfId: String(row['dwarf_id']) as DwarfId,
    turnKey: String(row['turn_key']),
    open: Number(row['open']) === 1,
    stepCount: Number(row['step_count']),
    summaries: JSON.parse(String(row['summaries_json'])) as string[],
    openedAt: Number(row['opened_at']),
    ...(closedAt === null || closedAt === undefined ? {} : { closedAt: Number(closedAt) })
  }
}
