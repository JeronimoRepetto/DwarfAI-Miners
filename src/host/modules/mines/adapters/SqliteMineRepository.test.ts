import { describe } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import type { MapSite } from '../domain/mine'
import { runMineRepositoryContract } from '../testing/mineRepository.contract'
import { runPresentDwarfCountsContract } from '../testing/presentDwarfCounts.contract'
import { SqliteMineRepository } from './SqliteMineRepository'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), so every row meets the real CHECKs, the UNIQUE `canonical_path` and the foreign keys of
// `mines` and `ledger_entries` (09 §4.2, §4.7). Ledger credits are seeded as `ledger_entries` rows,
// whose trigger keeps `material_totals` (ADR-006 item 9).
const SITES: readonly [MapSite, MapSite] = [
  { xPct: 31.14, yPct: 28.28 },
  { xPct: 29.43, yPct: 30.48 }
]

let credits = 0

describe('SqliteMineRepository', () => {
  runMineRepositoryContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    return {
      repository: new SqliteMineRepository({ db, scope: runner, mapSites: SITES, random: () => 0 }),
      mapSites: SITES,
      inTransaction: (work) => runner.inTransaction(work),
      credit: (mineId, material, tokens) => {
        credits += 1
        const id = `00000000-0000-7000-8000-${credits.toString(16).padStart(12, '0')}`
        runner.inTransaction(() =>
          db.run(
            `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind, credited_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
            [
              id,
              `unit-${id}`,
              mineId,
              material,
              tokens,
              material === 'coal' ? 'coal-backfill' : 'live'
            ]
          )
        )
      },
      ledgerRows: (mineId) =>
        Number(
          db.all('SELECT COUNT(*) AS n FROM ledger_entries WHERE mine_id = ?', [mineId])[0]?.['n']
        ),
      dispose: () => undefined
    }
  })
})

// The interim present-dwarf join (until ISSUE-094) over real `dwarfs` rows: the same suite as the
// double's. A departed dwarf is closed with a departure cause (09 §4.2 CHECKs).
const MINES = [
  '00000000-0000-7000-8000-0000000000f1' as MineId,
  '00000000-0000-7000-8000-0000000000f2' as MineId,
  '00000000-0000-7000-8000-0000000000f3' as MineId
] as const

describe('SqliteMineRepository (interim present-dwarf counts)', () => {
  runPresentDwarfCountsContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    runner.inTransaction(() => {
      MINES.forEach((id, n) => {
        db.run(
          `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
           VALUES (?, ?, ?, ?, 'active', 0, 0)`,
          [id, `/work/mine-${n}`, `mine-${n}`, `mine-${n}`]
        )
      })
    })
    let dwarfs = 0
    return {
      counts: new SqliteMineRepository({ db, scope: runner, mapSites: SITES, random: () => 0 }),
      mineIds: MINES,
      seatDwarf: (mineId, present) => {
        dwarfs += 1
        const id = `00000000-0000-7000-8000-${dwarfs.toString(16).padStart(12, '0')}`
        runner.inTransaction(() =>
          db.run(
            `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
               process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
             VALUES (?, ?, 'claude', ?, 'Dwarf', 'foreman', ?, 'none-yet', 0, 0, ?, ?)`,
            [
              id,
              mineId,
              `session-${dwarfs}`,
              present ? 'running' : 'closed',
              present ? null : 1,
              present ? null : 'stopped'
            ]
          )
        )
      },
      dispose: () => undefined
    }
  })
})
