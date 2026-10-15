// layer: L5
// L5 (17 §1.5): the launching module's `ResetDbStep` (16 §4.12) over a copy of the template
// database seeded with a live owned session and a departed dwarf, the 09 §6.5 "Reset scope" probe
// for the launching tables (09 §7.2 step (4) and rows "`launches` in flight, `launch_records` and
// `processes` of present dwarfs - kept", "Settled `launches`", "`host_recovery_reports` / items";
// ADR-023 items 1, 3-5). Each case runs the crew step first, in the same transaction, as the saga
// orders them (09 §7.2 (2) before (4)): its cascade takes the departed dwarf's launch record.
//
// TC-181-01, TC-181-02.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { createCrewResetStep } from '../../../crew'
import { createLaunchingResetStep } from '../../index'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000181f1'

const DWARF = {
  /** Present, its session owned by DwarfAI and running. */
  live: '00000000-0000-7000-8000-0000000181d1',
  /** Departed: the crew step deletes it, and its launch record by cascade. */
  gone: '00000000-0000-7000-8000-0000000181d2'
} as const

const LAUNCH = {
  /** `succeeded`, referenced by the live dwarf's launch record. */
  live: '00000000-0000-7000-8000-0000000181b1',
  /** `succeeded`, referenced only by the departed dwarf's launch record. */
  gone: '00000000-0000-7000-8000-0000000181b2',
  /** `failed`, no dwarf and no record. */
  failed: '00000000-0000-7000-8000-0000000181b3',
  /** In flight: spawned, its handshake not yet answered. */
  spawned: '00000000-0000-7000-8000-0000000181b4',
  /** In flight: still routing. */
  routing: '00000000-0000-7000-8000-0000000181b5'
} as const

const PROCESS = {
  live: '00000000-0000-7000-8000-0000000181c1',
  gone: '00000000-0000-7000-8000-0000000181c2',
  spawned: '00000000-0000-7000-8000-0000000181c3'
} as const

const EPOCH = { settled: 'epoch-settled', pending: 'epoch-pending', now: 'epoch-now' } as const

const MESSAGE = {
  sending: '00000000-0000-7000-8000-0000000181e1',
  delivered: '00000000-0000-7000-8000-0000000181e2'
} as const

/** The probe: a live owned session, a departed dwarf's session, settled and in-flight launches. */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
       VALUES (?, ?, 'claude', 'session-live', 'Durin', 'foreman', 'running', 'none-yet', ?, ?,
         NULL, NULL)`,
      [DWARF.live, MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
       VALUES (?, ?, 'claude', 'session-gone', 'Balin', 'foreman', 'closed', 'none-yet', ?, ?, ?,
         'stopped')`,
      [DWARF.gone, MINE, T0, T0, T0 + 5]
    )
    const launch = (id: string, state: string, dwarfId: string | null) => {
      const settled = ['succeeded', 'failed'].includes(state)
      db.run(
        `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
           state, failure_cause, dwarf_id, delegated, host_epoch, requested_at, settled_at)
         VALUES (?, ?, '/work/mine-one', 'supplier', 'claude', 0, ?, ?, ?, 0, ?, ?, ?)`,
        [
          id,
          MINE,
          state,
          state === 'failed' ? 'could-not-start' : null,
          dwarfId,
          EPOCH.now,
          T0,
          settled ? T0 + 1 : null
        ]
      )
    }
    launch(LAUNCH.live, 'succeeded', DWARF.live)
    launch(LAUNCH.gone, 'succeeded', DWARF.gone)
    launch(LAUNCH.failed, 'failed', null)
    launch(LAUNCH.spawned, 'spawned', null)
    launch(LAUNCH.routing, 'routing', null)
    const process = (id: string, pid: number, launchId: string) =>
      db.run(
        `INSERT INTO processes (id, pid, process_start_time_ms, boot_id, purpose, launch_id,
           host_epoch, recorded_at)
         VALUES (?, ?, ?, 'boot-0181', 'session', ?, ?, ?)`,
        [id, pid, T0, launchId, EPOCH.now, T0]
      )
    process(PROCESS.live, 1811, LAUNCH.live)
    process(PROCESS.gone, 1812, LAUNCH.gone)
    process(PROCESS.spawned, 1813, LAUNCH.spawned)
    const record = (dwarfId: string, launchId: string, processId: string, endedAt: number | null) =>
      db.run(
        `INSERT INTO launch_records (dwarf_id, launch_id, driver_transport, session_ref_json, cwd,
           process_id, resume_intent, host_epoch, ended_at)
         VALUES (?, ?, 'stream-json', '{}', '/work/mine-one', ?, ?, ?, ?)`,
        [dwarfId, launchId, processId, endedAt === null ? 1 : 0, EPOCH.now, endedAt]
      )
    record(DWARF.live, LAUNCH.live, PROCESS.live, null)
    record(DWARF.gone, LAUNCH.gone, PROCESS.gone, T0 + 5)
    db.run(
      `INSERT INTO host_recovery_reports (host_epoch, at, state, shown_at, settled_at)
       VALUES (?, ?, 'settled', ?, ?)`,
      [EPOCH.settled, T0, T0 + 1, T0 + 2]
    )
    db.run(
      `INSERT INTO host_recovery_reports (host_epoch, at, state) VALUES (?, ?, 'pending-display')`,
      [EPOCH.pending, T0 + 3]
    )
    ;[EPOCH.settled, EPOCH.pending].forEach((epoch) =>
      db.run(
        `INSERT INTO host_recovery_items (host_epoch, dwarf_id, reason) VALUES (?, ?, 'turn-lost')`,
        [epoch, DWARF.live]
      )
    )
    const message = (id: string, phase: string) => {
      db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
         VALUES (?, ?, 'person', 'keep digging', 'dwarfai', ?)`,
        [id, DWARF.live, T0 + 4]
      )
      db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, confidence, sent_at, phase_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?)`,
        [id, DWARF.live, phase, phase === 'delivered' ? 'confirmed' : null, T0 + 4, T0 + 4]
      )
    }
    message(MESSAGE.sending, 'sending')
    message(MESSAGE.delivered, 'delivered')
  })
  const crew = createCrewResetStep({ db, scope: runner })
  const step = createLaunchingResetStep({ db, scope: runner })
  /** The saga's `db` transaction restricted to (2) crew and (4) launching (09 §7.2). */
  const resetDb = (): void =>
    runner.inTransaction(() => [crew, step].forEach((s) => s.reset(runner)))
  return { db, runner, step, resetDb }
}

function column(db: SqliteDatabase, sql: string): string[] {
  return db.all(sql).map((row) => String(Object.values(row)[0]))
}

describe('LaunchingResetStep', () => {
  it('[ADR-023] settled launches no launch record references are deleted and the succeeded launch of a live owned session is kept', () => {
    const { db, step, resetDb } = seeded()

    expect(resetDb).not.toThrow()

    expect(step.name).toBe('launching')
    expect(column(db, 'SELECT id FROM launches ORDER BY id')).toStrictEqual([
      LAUNCH.live,
      LAUNCH.spawned,
      LAUNCH.routing
    ])
  })

  it('[ADR-023] in-flight launches and the launch records and processes of present dwarfs are kept', () => {
    const { db, resetDb } = seeded()

    resetDb()

    expect(column(db, 'SELECT launch_id FROM launch_records ORDER BY launch_id')).toStrictEqual([
      LAUNCH.live
    ])
    expect(
      db.all('SELECT dwarf_id, process_id, ended_at FROM launch_records WHERE launch_id = ?', [
        LAUNCH.live
      ])
    ).toEqual([{ dwarf_id: DWARF.live, process_id: PROCESS.live, ended_at: null }])
    expect(
      db.all('SELECT id, launch_id FROM processes WHERE id IN (?, ?) ORDER BY id', [
        PROCESS.live,
        PROCESS.spawned
      ])
    ).toEqual([
      { id: PROCESS.live, launch_id: LAUNCH.live },
      { id: PROCESS.spawned, launch_id: LAUNCH.spawned }
    ])
    expect(
      column(db, `SELECT state FROM launches WHERE settled_at IS NULL ORDER BY id`)
    ).toStrictEqual(['spawned', 'routing'])
  })

  it('[ADR-023] settled recovery reports are deleted and an unsettled one is kept', () => {
    const { db, resetDb } = seeded()

    resetDb()

    expect(column(db, 'SELECT host_epoch FROM host_recovery_reports')).toStrictEqual([
      EPOCH.pending
    ])
    // The settled report's items go by cascade; the unsettled one still owes its answer.
    expect(column(db, 'SELECT host_epoch FROM host_recovery_items')).toStrictEqual([EPOCH.pending])
  })

  it('[S7.19] a sending delivery and its message survive the db transaction', () => {
    const { db, resetDb } = seeded()

    resetDb()

    expect(
      db.all('SELECT message_id, phase FROM deliveries WHERE message_id = ?', [MESSAGE.sending])
    ).toEqual([{ message_id: MESSAGE.sending, phase: 'sending' }])
    expect(column(db, `SELECT id FROM messages WHERE id = '${MESSAGE.sending}'`)).toStrictEqual([
      MESSAGE.sending
    ])
  })

  it('[ADR-023] running the step twice leaves the same rows', () => {
    const { db, runner, step, resetDb } = seeded()
    resetDb()
    const once = {
      launches: column(db, 'SELECT id FROM launches ORDER BY id'),
      reports: column(db, 'SELECT host_epoch FROM host_recovery_reports')
    }

    runner.inTransaction(() => step.reset(runner))

    expect(column(db, 'SELECT id FROM launches ORDER BY id')).toStrictEqual(once.launches)
    expect(column(db, 'SELECT host_epoch FROM host_recovery_reports')).toStrictEqual(once.reports)
  })

  it('[ADR-023] the step called with no open transaction throws and writes nothing', () => {
    const { db, runner, step } = seeded()
    const before = column(db, 'SELECT id FROM launches ORDER BY id')

    expect(() => step.reset(runner)).toThrow(HostInvariantError)

    expect(column(db, 'SELECT id FROM launches ORDER BY id')).toStrictEqual(before)
  })
})
