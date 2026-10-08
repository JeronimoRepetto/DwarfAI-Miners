// Test helpers over a template-database copy for asking's SQLite tests (17 §1.5): one mine and two
// dwarfs seeded in bound SQL (the rows `asks` references, 09 §4.5), and read-backs of the
// `asks` / `ask_answers` columns the port does not expose. Never imported by production code (R14).
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { SqliteAskRepository } from '../adapters/SqliteAskRepository'

export const ASK_T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000127f1'
export const ASK_DWARFS = [
  '00000000-0000-7000-8000-0000000127d1' as DwarfId,
  '00000000-0000-7000-8000-0000000127d2' as DwarfId
] as const

/**
 * A template copy seeded with one mine and two dwarfs; `open` builds a repository on the writer.
 * `path` is the copy's file, for a test that opens a second connection as a restarted Host does.
 */
export function seededAskDb() {
  const { db, path } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, ASK_T0, ASK_T0]
    )
    ASK_DWARFS.forEach((id, n) => {
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
        [id, MINE, `session-${n}`, ASK_T0, ASK_T0]
      )
    })
  })
  const clock = new FakeClock(ASK_T0)
  const open = (on: SqliteDatabase = db): SqliteAskRepository =>
    new SqliteAskRepository({ db: on, scope: runner, clock })
  return { db, path, runner, clock, open, dwarfs: ASK_DWARFS }
}

/** The `ask_answers` rows, as stored. */
export function answerRows(db: SqliteDatabase) {
  return db
    .all(
      `SELECT request_id, ask_id, outcome, refusal_reason, message_id, at, settled_at
       FROM ask_answers ORDER BY request_id`
    )
    .map((row) => ({ ...row }))
}
