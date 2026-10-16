// Test seeding for the launching SQLite adapters (17 §1.3; 09 §6.5 template DB): the rows the
// launching tables reference — one mine, dwarfs, a delegation, a settled launch — written with bound
// SQL straight into a template copy. Never imported by production code (R14).
import type { DwarfId, FolderPath, LaunchId, MineId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'

export const T0 = 1_790_000_000_000
export const MINE = '00000000-0000-7000-8000-0000000161f1' as MineId
export const MINE_FOLDER = '/work/mine-one' as FolderPath

export function seedMine(db: SqliteDatabase, runner: TransactionRunner): void {
  runner.inTransaction(() =>
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, ?, 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, MINE_FOLDER, T0, T0]
    )
  )
}

export function seedDwarf(db: SqliteDatabase, runner: TransactionRunner, id: DwarfId): void {
  runner.inTransaction(() =>
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
      [id, MINE, `session-of-${id}`, T0, T0]
    )
  )
}

export function seedDelegation(
  db: SqliteDatabase,
  runner: TransactionRunner,
  id: string,
  parent: DwarfId
): void {
  runner.inTransaction(() =>
    db.run(
      `INSERT INTO delegations (id, parent_dwarf_id, ticket, state, created_at)
       VALUES (?, ?, ?, 'running', ?)`,
      [id, parent, `ticket-${id}`, T0]
    )
  )
}

/**
 * A settled supplier launch for a launch record to reference. Its own `dwarf_id` stays
 * NULL (UNIQUE), so a test can seed a second launch for the same dwarf.
 */
export function seedSucceededLaunch(
  db: SqliteDatabase,
  runner: TransactionRunner,
  launchId: LaunchId,
  launchedWithLetJevChoose: boolean
): void {
  runner.inTransaction(() =>
    db.run(
      `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
         state, delegated, host_epoch, requested_at, spawned_at, settled_at)
       VALUES (?, ?, ?, 'supplier', 'claude', ?, 'succeeded', 0, 'epoch-seed', ?, ?, ?)`,
      [launchId, MINE, MINE_FOLDER, launchedWithLetJevChoose ? 1 : 0, T0, T0, T0]
    )
  )
}
