// layer: L3
// L3 (17 §1.3): the mines, crew, observation and ledger steps of the Reset-metrics saga's `db`
// step (16 §4.12 `ResetDbStep`, ADR-023 items 1, 3, 4; 09 §7.2), together over a copy of the
// template database seeded with a removed mine, an empty mine and an occupied mine. Each module's
// step comes through its `index.ts` (R15); all four join one transaction (16 §2.2).
//
// TC-097-01, TC-097-02, TC-097-03.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import type { MineId } from '../../kernel/domain/values'
import type { SqliteDatabase, SqliteParam } from '../../kernel/ports/sqliteDatabase'
import { createCrewResetStep } from '../../modules/crew'
import { createLedgerResetStep } from '../../modules/ledger'
import { createMinesResetStep } from '../../modules/mines'
import { createObservationResetStep } from '../../modules/observation'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_000_000_000
const NOW = T0 + 86_400_000

const MINE = {
  /** Removed, its one dwarf departed, its ledger retained (PO #4). */
  removed: '00000000-0000-7000-8000-0000000097f1',
  /** Declared and measured, no dwarf ever arrived. */
  empty: '00000000-0000-7000-8000-0000000097f2',
  /** Measured gold, with a present dwarf and a departed one. */
  occupied: '00000000-0000-7000-8000-0000000097f3'
} as const

const DWARF = {
  present: '00000000-0000-7000-8000-0000000097d1',
  departedHere: '00000000-0000-7000-8000-0000000097d2',
  departedRemoved: '00000000-0000-7000-8000-0000000097d3'
} as const

const SITES = [
  { xPct: 10, yPct: 20 },
  { xPct: 30, yPct: 40 },
  { xPct: 50, yPct: 60 }
] as const

/** An `ended_agents` row of a departed subagent and one of a session no dwarf row names. */
const ENDED = [
  ['claude', 'session-departed-here', 'agent-1', T0 + 5],
  ['codex', 'session-never-bound', '', T0 + 6]
] as const

function seed(db: SqliteDatabase): void {
  const mine = (
    id: string,
    path: string,
    state: string,
    extra: { removedAt?: number; site?: { xPct: number; yPct: number } } = {}
  ) =>
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
         has_been_measured, measured_at, removed_at, created_at, last_used_at, map_site_x_pct,
         map_site_y_pct)
       VALUES (?, ?, ?, ?, ?, 'gold', 123456, 1, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        path,
        path.slice(1),
        path.slice(1),
        state,
        T0 + 1,
        extra.removedAt ?? null,
        T0,
        T0 + 2,
        extra.site?.xPct ?? null,
        extra.site?.yPct ?? null
      ]
    )
  mine(MINE.removed, '/removed', 'removed', { removedAt: T0 + 3, site: SITES[0] })
  mine(MINE.empty, '/empty', 'active', { site: SITES[1] })
  mine(MINE.occupied, '/occupied', 'active', { site: SITES[2] })

  const dwarf = (id: string, mineId: string, session: string, departed: boolean) =>
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, custom_name,
         rank, process_state, turn_state, arrived_at, last_activity_at, departed_at,
         departure_cause)
       VALUES (?, ?, 'claude', ?, 'Durin', 'Bob', 'foreman', ?, 'none-yet', ?, ?, ?, ?)`,
      [
        id,
        mineId,
        session,
        departed ? 'closed' : 'running',
        T0,
        T0,
        departed ? T0 + 4 : null,
        departed ? 'stopped' : null
      ]
    )
  dwarf(DWARF.present, MINE.occupied, 'session-present', false)
  dwarf(DWARF.departedHere, MINE.occupied, 'session-departed-here', true)
  dwarf(DWARF.departedRemoved, MINE.removed, 'session-departed-removed', true)

  for (const [n, id] of Object.values(DWARF).entries()) {
    db.run(
      `INSERT INTO dwarf_lifecycle_facts (id, dwarf_id, type, occurred_at, recorded_at)
       VALUES (?, ?, 'DwarfArrived', ?, ?)`,
      [`00000000-0000-7000-8000-0000000097a${n}`, id, T0, T0]
    )
    db.run(
      `INSERT INTO observed_sessions (dwarf_id, cwd, first_seen_at, last_record_at)
       VALUES (?, '/somewhere', ?, ?)`,
      [id, T0, T0]
    )
    db.run(
      `INSERT INTO source_cursors (stream_id, adapter_id, kind, value, updated_at)
       VALUES (?, 'claude', 'byte-offset', 42, ?)`,
      [`stream-${id}`, T0]
    )
    db.run('INSERT INTO observed_session_streams (dwarf_id, stream_id) VALUES (?, ?)', [
      id,
      `stream-${id}`
    ])
  }
  for (const row of ENDED) {
    db.run(
      `INSERT INTO ended_agents (provider_id, provider_session_id, provider_agent_id, ended_at)
       VALUES (?, ?, ?, ?)`,
      [...row]
    )
  }

  // Usage and ore: the occupied mine's present dwarf and the removed mine's departed one.
  const usage = (unit: string, dwarfId: string, mineId: string, tokens: number) => {
    db.run(
      `INSERT INTO usage_units (unit_key, dwarf_id, mine_id, sealed, first_observed_at, sealed_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [unit, dwarfId, mineId, T0, T0]
    )
    db.run(
      `INSERT INTO usage_observations (source_key, unit_key, path, fidelity, output, sealed,
         observed_at)
       VALUES (?, ?, 'transcript', 2, ?, 1, ?)`,
      [`obs-${unit}`, unit, tokens, T0]
    )
    db.run(
      `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind,
         credited_at)
       VALUES (?, ?, ?, 'gold', ?, 1, 'live', ?)`,
      [`${unit.padEnd(32, '0').slice(0, 32)}0e01`, unit, mineId, tokens, T0]
    )
  }
  usage('unit-present', DWARF.present, MINE.occupied, 1000)
  usage('unit-removed', DWARF.departedRemoved, MINE.removed, 2000)
  db.run(
    `INSERT OR REPLACE INTO install_moment (id, at, reason, backfill_state, backfill_done_at)
     VALUES (1, ?, 'fresh-install', 'done', ?)`,
    [T0, T0 + 1]
  )
  db.run(
    `INSERT INTO coal_backfill_units (scan_unit, adapter_id, tokens_credited, credited_at)
     VALUES ('claude-project-1', 'claude', 77, ?)`,
    [T0]
  )
}

/** The four steps over a seeded template copy, as the composition root builds them. */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => seed(db))
  const clock = new FakeClock(NOW)
  const walked: MineId[] = []
  const mines = createMinesResetStep({
    db,
    scope: runner,
    clock,
    mapSites: SITES,
    // Always the first free site.
    random: () => 0,
    remeasure: (mineId) => walked.push(mineId)
  })
  const crew = createCrewResetStep({ db, scope: runner })
  const observation = createObservationResetStep({ db, scope: runner })
  const ledger = createLedgerResetStep({ db, scope: runner })
  const steps = [mines, crew, observation, ledger]
  const resetAll = () => runner.inTransaction(() => steps.forEach((step) => step.reset(runner)))
  return { db, runner, mines, crew, observation, ledger, steps, resetAll, walked }
}

function column(db: SqliteDatabase, sql: string, params: readonly SqliteParam[] = []): unknown[] {
  return db.all(sql, params).map((row) => Object.values(row)[0])
}

/** Rows as plain objects (`node:sqlite` answers null-prototype rows). */
function rows(db: SqliteDatabase, sql: string, params: readonly SqliteParam[] = []): object[] {
  return db.all(sql, params).map((row) => ({ ...row }))
}

function count(db: SqliteDatabase, table: string): number {
  return Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
}

describe('the board modules Reset steps (16 §4.12; 09 §7.2)', () => {
  it('[S3.23] the mines step deletes every mine with no present dwarf, removed ones included', () => {
    const { db, resetAll } = seeded()

    resetAll()

    expect(column(db, 'SELECT id FROM mines ORDER BY id')).toStrictEqual([MINE.occupied])
  })

  it('[S3.24, INV-109] a mine with a present dwarf keeps its id, returns to measuring with no tier and no ore, and its dwarf stays present', () => {
    const { db, resetAll, mines, walked } = seeded()

    resetAll()

    expect(rows(db, 'SELECT * FROM mines WHERE id = ?', [MINE.occupied])).toStrictEqual([
      {
        id: MINE.occupied,
        canonical_path: '/occupied',
        name: 'occupied',
        name_norm: 'occupied',
        state: 'measuring',
        tier: null,
        source_weight_bytes: null,
        has_been_measured: 0,
        measured_at: null,
        unenterable_reason: null,
        removed_at: null,
        created_at: NOW,
        last_used_at: NOW,
        // Re-picked among the sites no kept mine holds: with `random` 0, the first one.
        map_site_x_pct: SITES[0].xPct,
        map_site_y_pct: SITES[0].yPct
      }
    ])
    expect(count(db, 'material_totals')).toBe(0)
    // INV-109: no session ended — the dwarf is present, running, in the same mine.
    expect(
      rows(db, 'SELECT mine_id, process_state, presence, departed_at FROM dwarfs WHERE id = ?', [
        DWARF.present
      ])
    ).toStrictEqual([
      { mine_id: MINE.occupied, process_state: 'running', presence: 'present', departed_at: null }
    ])
    // The walk is queued after the commit, never inside the transaction.
    expect(walked).toStrictEqual([])
    mines.walkRecreatedMines()
    expect(walked).toStrictEqual([MINE.occupied])
    mines.walkRecreatedMines()
    expect(walked).toStrictEqual([MINE.occupied])
  })

  it("[ADR-023] the crew step deletes departed dwarfs and clears present dwarfs' custom names", () => {
    const { db, resetAll } = seeded()

    resetAll()

    expect(rows(db, 'SELECT id, custom_name FROM dwarfs ORDER BY id')).toStrictEqual([
      { id: DWARF.present, custom_name: null }
    ])
    // Their lifecycle facts stay, so their provider keys keep deduping (09 §7.2).
    expect(column(db, 'SELECT dwarf_id FROM dwarf_lifecycle_facts')).toStrictEqual([DWARF.present])
  })

  it('[ADR-029] the observation step keeps every ended_agents row and the cursors of present dwarfs', () => {
    const { db, resetAll } = seeded()

    resetAll()

    expect(
      db
        .all(
          `SELECT provider_id, provider_session_id, provider_agent_id, ended_at FROM ended_agents
           ORDER BY provider_id`
        )
        .map((row) => Object.values(row))
    ).toStrictEqual(ENDED.map((row) => [...row]))
    expect(
      rows(
        db,
        `SELECT s.dwarf_id, c.stream_id, c.value FROM observed_session_streams s
         JOIN source_cursors c ON c.stream_id = s.stream_id`
      )
    ).toStrictEqual([{ dwarf_id: DWARF.present, stream_id: `stream-${DWARF.present}`, value: 42 }])
    expect(column(db, 'SELECT dwarf_id FROM observed_sessions')).toStrictEqual([DWARF.present])
  })

  it('[ADR-023] the ledger step deletes usage, ledger entries, totals and the install moment', () => {
    const { db, resetAll } = seeded()

    resetAll()

    expect({
      usage_units: count(db, 'usage_units'),
      usage_observations: count(db, 'usage_observations'),
      ledger_entries: count(db, 'ledger_entries'),
      material_totals: count(db, 'material_totals'),
      install_moment: count(db, 'install_moment'),
      coal_backfill_units: count(db, 'coal_backfill_units')
    }).toStrictEqual({
      usage_units: 0,
      usage_observations: 0,
      ledger_entries: 0,
      material_totals: 0,
      install_moment: 0,
      coal_backfill_units: 0
    })
  })

  it('[ADR-023] all four steps run inside one joined transaction and a throw in one rolls back all', () => {
    const { db, runner, steps } = seeded()
    const snapshot = () =>
      [
        'mines',
        'dwarfs',
        'dwarf_lifecycle_facts',
        'observed_sessions',
        'source_cursors',
        'ended_agents',
        'usage_units',
        'ledger_entries',
        'material_totals',
        'install_moment'
      ].map((table) => db.all(`SELECT * FROM ${table} ORDER BY 1`))
    const before = snapshot()

    expect(steps.map((step) => step.name)).toStrictEqual(['mines', 'crew', 'observation', 'ledger'])
    expect(() =>
      runner.inTransaction(() => {
        steps.forEach((step) => step.reset(runner))
        throw new Error('a later ResetDbStep failed')
      })
    ).toThrow('a later ResetDbStep failed')

    expect(snapshot()).toStrictEqual(before)
    // A step called with no open transaction is a code defect: it throws and writes nothing.
    for (const step of steps) expect(() => step.reset(runner)).toThrow(/transaction/)
    expect(snapshot()).toStrictEqual(before)
  })
})
