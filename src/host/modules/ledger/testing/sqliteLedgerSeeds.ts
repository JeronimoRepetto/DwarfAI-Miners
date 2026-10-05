// Seeding helpers for the ledger's SQLite tests (L3, L5): the rows of other modules that 09 §5.3
// reads (`mines`, `dwarfs`, `install_moment`, `reset_journal`), written as their owners write them
// so every CHECK and foreign key of schema v1 holds. Synthetic, neutral values (17 §1.4). Never
// imported by production code (R14).
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { UsagePath } from '../domain/credit'
import type { LiveMaterial, Material } from '../domain/materials'
import type { StoredEntry } from './ledgerRepository.contract'

const T0 = 1_750_000_000_000
const RESET_ID = '00000000-0000-7000-8000-0000000076e1'

export function sqliteLedgerSeeds(db: SqliteDatabase, runner: TransactionRunner) {
  let mines = 0
  let dwarfs = 0
  return {
    addMine(tier: LiveMaterial | null): MineId {
      mines += 1
      const id = `00000000-0000-7000-8000-${(0x760000 + mines).toString(16).padStart(12, '0')}`
      runner.inTransaction(() =>
        db.run(
          `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
             has_been_measured, measured_at, created_at, last_used_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
          [
            id,
            `/work/mine-${mines}`,
            `mine-${mines}`,
            `mine-${mines}`,
            tier,
            tier === null ? null : 524_288,
            tier === null ? 0 : 1,
            tier === null ? null : T0 + 1,
            T0,
            T0
          ]
        )
      )
      return id as MineId
    },
    /** The tier of a never-measured mine arrives (`MineMeasured`, 08 §2.1). */
    measure(mineId: MineId, tier: LiveMaterial): void {
      runner.inTransaction(() =>
        db.run(
          `UPDATE mines SET tier = ?, source_weight_bytes = 524288, has_been_measured = 1,
             measured_at = ? WHERE id = ?`,
          [tier, T0 + 2, mineId]
        )
      )
    },
    addDwarf(mineId: MineId, usagePath: UsagePath): DwarfId {
      dwarfs += 1
      const id = `00000000-0000-7000-9000-${(0x760000 + dwarfs).toString(16).padStart(12, '0')}`
      runner.inTransaction(() =>
        db.run(
          `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
             process_state, turn_state, arrived_at, last_activity_at, usage_path)
           VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?, ?)`,
          [id, mineId, `session-${dwarfs}`, T0, T0, usagePath]
        )
      )
      return id as DwarfId
    },
    setInstallMoment(at: Instant | null): void {
      runner.inTransaction(() => {
        db.run('DELETE FROM install_moment')
        if (at !== null) {
          db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [at])
        }
      })
    },
    setResetInProgress(inProgress: boolean): void {
      runner.inTransaction(() => {
        db.run('DELETE FROM reset_journal WHERE id = ?', [RESET_ID])
        db.run(
          `INSERT INTO reset_journal (id, epoch, step, started_at, step_at, finished_at)
           VALUES (?, 1, ?, ?, ?, ?)`,
          [RESET_ID, inProgress ? 'db' : 'done', T0, T0, inProgress ? null : T0 + 1]
        )
      })
    },
    entries(mineId: MineId): StoredEntry[] {
      return db
        .all(
          `SELECT unit_key, material, tokens, units, kind FROM ledger_entries
            WHERE mine_id = ? ORDER BY unit_key`,
          [mineId]
        )
        .map((row) => ({
          unitKey: String(row['unit_key']),
          material: row['material'] as Material,
          tokens: Number(row['tokens']),
          units: Number(row['units']),
          kind: row['kind'] as StoredEntry['kind']
        }))
    }
  }
}
