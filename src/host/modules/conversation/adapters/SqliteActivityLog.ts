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
// - `saveOutcome` writes the dwarf's one row of `outcome_lines` (09 §4.4, keyed by `dwarf_id`),
//   replacing every column, so an optional field the new line lacks is cleared; the parts are stored
//   as given in `parts_json` (its CHECK refuses more than three).
// - `outcomeOf` reads that row back by its key (16 §4.6, amendment B); a NULL optional column is an
//   absent field. `storedOutcomeOf` (amendment E) reads the same row outside any transaction, for
//   `ConversationQueries.outcomeOf`.
// - Summaries are one line per step and never tool output (ADR-007 item 4): stored as given.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine, OutcomeLinePart, TurnOutcomeKind } from '../domain/outcomeLine'
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

const SAVE_OUTCOME = `INSERT INTO outcome_lines
    (dwarf_id, kind, step_count, parts_json, detail, closing_words, reliability, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (dwarf_id) DO UPDATE SET
    kind = excluded.kind,
    step_count = excluded.step_count,
    parts_json = excluded.parts_json,
    detail = excluded.detail,
    closing_words = excluded.closing_words,
    reliability = excluded.reliability,
    at = excluded.at`

const OUTCOME_OF = `SELECT dwarf_id, kind, step_count, parts_json, detail, closing_words, reliability, at
  FROM outcome_lines WHERE dwarf_id = ?`

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

  saveOutcome(o: OutcomeLine): void {
    this.inTransaction('saveOutcome')
    this.deps.db.run(SAVE_OUTCOME, [
      o.dwarfId,
      o.kind,
      o.stepCount,
      JSON.stringify(o.parts),
      o.detail ?? null,
      o.closingWords ?? null,
      o.reliability,
      o.at
    ])
  }

  outcomeOf(dwarfId: DwarfId): OutcomeLine | null {
    this.inTransaction('outcomeOf')
    const row = this.deps.db.all(OUTCOME_OF, [dwarfId])[0]
    return row === undefined ? null : outcomeOfRow(row)
  }

  // Amended: 16 §4.6 storedOutcomeOf, the read-side half of owner amendment E (2026-10-06)
  storedOutcomeOf(dwarfId: DwarfId): OutcomeLine | null {
    // The read side (09 §8.1): no transaction is needed or opened for one keyed row.
    const row = this.deps.db.all(OUTCOME_OF, [dwarfId])[0]
    return row === undefined ? null : outcomeOfRow(row)
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

/** One `outcome_lines` row as the aggregate `OutcomeLine`. */
function outcomeOfRow(row: Record<string, unknown>): OutcomeLine {
  const detail = row['detail']
  const closingWords = row['closing_words']
  return {
    dwarfId: String(row['dwarf_id']) as DwarfId,
    kind: String(row['kind']) as TurnOutcomeKind,
    stepCount: Number(row['step_count']),
    parts: JSON.parse(String(row['parts_json'])) as OutcomeLinePart[],
    ...(detail === null || detail === undefined ? {} : { detail: String(detail) }),
    ...(closingWords === null || closingWords === undefined
      ? {}
      : { closingWords: String(closingWords) }),
    reliability: String(row['reliability']) === 'inferred' ? 'inferred' : 'reliable',
    at: Number(row['at'])
  }
}
