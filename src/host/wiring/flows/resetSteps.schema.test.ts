// layer: L5
// L5 (17 §1.5): the 09 §6.5 "Reset scope" probe for the board modules' Reset steps (16 §4.12
// `ResetDbStep`; ADR-023 item 4; 09 §7.2) over a copy of the template database. The seed holds the
// foreign keys a reset must not break: a departed dwarf's launch record, delegation, messages and
// asks; a present worker whose parent departed; usage, ore and a coal backfill. After the mines,
// crew, observation and ledger steps commit in one transaction, the database is consistent.
//
// TC-097-01.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import type { SqliteDatabase, SqliteParam } from '../../kernel/ports/sqliteDatabase'
import { createCrewResetStep } from '../../modules/crew'
import { createLedgerResetStep } from '../../modules/ledger'
import { createMinesResetStep } from '../../modules/mines'
import { createObservationResetStep } from '../../modules/observation'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_000_000_000
const MINE = {
  kept: '00000000-0000-7000-8000-0000000097e1',
  gone: '00000000-0000-7000-8000-0000000097e2'
} as const
const DWARF = {
  /** Present: a worker whose parent departed. */
  worker: '00000000-0000-7000-8000-0000000097c1',
  /** Departed parent, in the kept mine. */
  parent: '00000000-0000-7000-8000-0000000097c2',
  /** Departed, alone in the mine that goes. */
  lone: '00000000-0000-7000-8000-0000000097c3'
} as const
const LAUNCH = {
  worker: '00000000-0000-7000-8000-0000000097b1',
  parent: '00000000-0000-7000-8000-0000000097b2'
} as const

function seed(db: SqliteDatabase): void {
  for (const [id, path] of [
    [MINE.kept, '/kept'],
    [MINE.gone, '/gone']
  ] as const) {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, has_been_measured,
         measured_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, 'active', 'silver', 1, ?, ?, ?)`,
      [id, path, path.slice(1), path.slice(1), T0, T0, T0]
    )
  }
  const dwarf = (id: string, mineId: string, parent: string | null, departed: boolean) =>
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         parent_dwarf_id, process_state, turn_state, arrived_at, last_activity_at, departed_at,
         departure_cause)
       VALUES (?, ?, 'claude', ?, 'Nori', ?, ?, ?, 'none-yet', ?, ?, ?, ?)`,
      [
        id,
        mineId,
        `session-${id}`,
        parent === null ? 'foreman' : 'worker',
        parent,
        departed ? 'closed' : 'running',
        T0,
        T0,
        departed ? T0 + 1 : null,
        departed ? 'stopped' : null
      ]
    )
  dwarf(DWARF.parent, MINE.kept, null, true)
  dwarf(DWARF.worker, MINE.kept, DWARF.parent, false)
  dwarf(DWARF.lone, MINE.gone, null, true)

  // Launches: the live worker's succeeded launch and the departed parent's.
  for (const [launchId, dwarfId] of [
    [LAUNCH.worker, DWARF.worker],
    [LAUNCH.parent, DWARF.parent]
  ] as const) {
    db.run(
      `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
         state, dwarf_id, delegated, host_epoch, requested_at, spawned_at, settled_at)
       VALUES (?, ?, '/kept', 'supplier', 'claude', 0, 'succeeded', ?, 0, 'epoch-097', ?, ?, ?)`,
      [launchId, MINE.kept, dwarfId, T0, T0, T0]
    )
    db.run(
      `INSERT INTO launch_records (dwarf_id, launch_id, driver_transport, session_ref_json, cwd,
         host_epoch)
       VALUES (?, ?, 'stream-json', '{}', '/kept', 'epoch-097')`,
      [dwarfId, launchId]
    )
  }
  db.run(
    `INSERT INTO delegations (id, parent_dwarf_id, worker_dwarf_id, ticket, state, created_at)
     VALUES ('00000000-0000-7000-8000-0000000097a1', ?, ?, 'ticket-097', 'running', ?)`,
    [DWARF.parent, DWARF.worker, T0]
  )
  db.run(
    `INSERT INTO messages (id, dwarf_id, source_key, role, text, origin, created_at)
     VALUES ('00000000-0000-7000-8000-0000000097a2', ?, 'line-1', 'dwarf', 'done', 'transcript', ?)`,
    [DWARF.lone, T0]
  )
  db.run(
    `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
       opened_at, closed_at)
     VALUES ('00000000-0000-7000-8000-0000000097a3', ?, 'question', 'driver', 'r-1', '{}',
       'answered-in-app', ?, ?)`,
    [DWARF.parent, T0, T0 + 1]
  )

  // Ore in both mines, on the live and the backfill path, and the backfill's scan unit.
  const credit = (n: number, mineId: string, dwarfId: string, material: string, kind: string) => {
    db.run(
      `INSERT INTO usage_units (unit_key, dwarf_id, mine_id, first_observed_at)
       VALUES (?, ?, ?, ?)`,
      [`unit-${n}`, dwarfId, mineId, T0]
    )
    db.run(
      `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind,
         credited_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [`00000000-0000-7000-8000-00000000970${n}`, `unit-${n}`, mineId, material, 1000 * n, kind, T0]
    )
  }
  credit(1, MINE.kept, DWARF.worker, 'silver', 'live')
  credit(2, MINE.kept, DWARF.parent, 'coal', 'coal-backfill')
  credit(3, MINE.gone, DWARF.lone, 'silver', 'live')
  db.run(
    `INSERT OR REPLACE INTO install_moment (id, at, reason, backfill_state)
     VALUES (1, ?, 'fresh-install', 'running')`,
    [T0]
  )
  db.run(
    `INSERT INTO coal_backfill_units (scan_unit, adapter_id, tokens_credited, credited_at)
     VALUES ('codex-day-1', 'codex', 2000, ?)`,
    [T0]
  )
}

/** Rows as plain objects (`node:sqlite` answers null-prototype rows). */
function rows(db: SqliteDatabase, sql: string, params: readonly SqliteParam[] = []): object[] {
  return db.all(sql, params).map((row) => ({ ...row }))
}

function count(db: SqliteDatabase, table: string): number {
  return Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
}

describe('the board modules Reset steps over the schema (09 §6.5 Reset scope)', () => {
  it('[ADR-023] after the four steps foreign_key_check and integrity_check pass and material_totals equals SUM of ledger_entries', () => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    runner.inTransaction(() => seed(db))
    const steps = [
      createMinesResetStep({
        db,
        scope: runner,
        clock: new FakeClock(T0 + 10),
        mapSites: [],
        random: () => 0,
        remeasure: () => undefined
      }),
      createCrewResetStep({ db, scope: runner }),
      createObservationResetStep({ db, scope: runner }),
      createLedgerResetStep({ db, scope: runner })
    ]

    runner.inTransaction(() => steps.forEach((step) => step.reset(runner)))

    expect(rows(db, 'PRAGMA foreign_key_check')).toStrictEqual([])
    expect(rows(db, 'PRAGMA integrity_check')).toStrictEqual([{ integrity_check: 'ok' }])
    // Every total is the sum of its entries, with no total left over for an entry that went.
    expect(
      rows(
        db,
        `SELECT t.mine_id, t.material, t.tokens, t.units,
           coalesce(sum(e.tokens), 0) AS entry_tokens, coalesce(sum(e.units), 0) AS entry_units
         FROM material_totals t
         LEFT JOIN ledger_entries e ON e.mine_id = t.mine_id AND e.material = t.material
         GROUP BY t.mine_id, t.material
         HAVING t.tokens <> entry_tokens OR t.units <> entry_units OR count(e.id) = 0`
      )
    ).toStrictEqual([])
    // The reset applied (09 §7.2): what the probe is about to vouch for is the post-reset state.
    expect({
      mines: count(db, 'mines'),
      dwarfs: count(db, 'dwarfs'),
      ledger_entries: count(db, 'ledger_entries'),
      material_totals: count(db, 'material_totals'),
      install_moment: count(db, 'install_moment')
    }).toStrictEqual({
      mines: 1,
      dwarfs: 1,
      ledger_entries: 0,
      material_totals: 0,
      install_moment: 0
    })
    // The live worker's launch and its record stay (R4B-01); the departed parent's record went.
    expect(rows(db, 'SELECT dwarf_id, launch_id FROM launch_records')).toStrictEqual([
      { dwarf_id: DWARF.worker, launch_id: LAUNCH.worker }
    ])
  })
})
