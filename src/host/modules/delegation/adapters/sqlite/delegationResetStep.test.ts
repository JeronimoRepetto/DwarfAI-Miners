// layer: L5
// L5 (17 §1.5): the delegation module's `ResetDbStep` (16 §4.12) over a copy of the template
// database, the 09 §6.5 "Reset scope" probe for the delegation tables (09 §7.2 rows "`delegations`
// in flight, `delegation_tokens` - kept" and "Settled `delegations` - deleted"; ADR-023 items 1,
// 3-4). The step reaches the saga structurally: the module imports nothing from `preferences`
// (05 §1.3, R4).
//
// TC-208-01, TC-208-02, TC-208-03.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { createDelegationResetStep } from '../../index'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000208f1'
const PARENT = '00000000-0000-7000-8000-0000000208d1'
const WORKER = '00000000-0000-7000-8000-0000000208d2'

const DELEGATION = {
  attempted: '00000000-0000-7000-8000-0000000208a1',
  running: '00000000-0000-7000-8000-0000000208a2',
  succeeded: '00000000-0000-7000-8000-0000000208a3',
  failed: '00000000-0000-7000-8000-0000000208a4'
} as const

const LAUNCH = {
  attempted: '00000000-0000-7000-8000-0000000208b1',
  running: '00000000-0000-7000-8000-0000000208b2',
  succeeded: '00000000-0000-7000-8000-0000000208b3',
  failed: '00000000-0000-7000-8000-0000000208b4'
} as const

const settled = (state: string): boolean => ['succeeded', 'failed'].includes(state)

/**
 * The seeded probe: a present parent dwarf and a present worker, one delegation in each state, a
 * worker launch for each (the settled ones settled too), and a token for every launch.
 */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    ;[PARENT, WORKER].forEach((id, n) => {
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
         VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?, NULL, NULL)`,
        [id, MINE, `session-${n}`, T0, T0]
      )
    })
    const delegation = (
      id: string,
      ticket: string,
      state: string,
      worker: string | null,
      handedOff: boolean
    ) =>
      db.run(
        `INSERT INTO delegations (id, parent_dwarf_id, worker_dwarf_id, ticket, task_text, state,
           failure, handoff_via, handoff_phase, handoff_phase_at, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          PARENT,
          worker,
          ticket,
          settled(state) ? null : 'do the work',
          state,
          state === 'failed' ? 'worker-failed' : null,
          handedOff ? 'tool-result' : null,
          handedOff ? 'delivered' : null,
          handedOff ? T0 + 2 : null,
          T0,
          settled(state) ? T0 + 3 : null
        ]
      )
    delegation(DELEGATION.attempted, 'ticket-1', 'attempted', null, false)
    delegation(DELEGATION.running, 'ticket-2', 'running', WORKER, false)
    delegation(DELEGATION.succeeded, 'ticket-3', 'succeeded', null, true)
    delegation(DELEGATION.failed, 'ticket-4', 'failed', null, false)
    const launch = (id: string, delegationId: string, state: string) =>
      db.run(
        `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
           state, failure_cause, delegation_id, delegated, host_epoch, requested_at, settled_at)
         VALUES (?, ?, '/work/mine-one', 'supplier', 'claude', 0, ?, ?, ?, 1, 'epoch-0208', ?, ?)`,
        [
          id,
          MINE,
          state,
          state === 'failed' ? 'could-not-start' : null,
          delegationId,
          T0,
          settled(state) ? T0 + 3 : null
        ]
      )
    launch(LAUNCH.attempted, DELEGATION.attempted, 'routing')
    launch(LAUNCH.running, DELEGATION.running, 'spawned')
    launch(LAUNCH.succeeded, DELEGATION.succeeded, 'succeeded')
    launch(LAUNCH.failed, DELEGATION.failed, 'failed')
    Object.values(LAUNCH).forEach((launchId) =>
      db.run(
        `INSERT INTO delegation_tokens (launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at)
         VALUES (?, ?, 'in-process', NULL, ?)`,
        [launchId, PARENT, T0]
      )
    )
  })
  const step = createDelegationResetStep({ db, scope: runner })
  return { db, runner, step }
}

function delegationRows(db: SqliteDatabase): Array<Record<string, unknown>> {
  return db.all('SELECT * FROM delegations ORDER BY id')
}

function ids(
  db: SqliteDatabase,
  table: 'delegations' | 'delegation_tokens' | 'launches'
): string[] {
  const column = table === 'delegation_tokens' ? 'launch_id' : 'id'
  return db
    .all(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
    .map((row) => String(row['id']))
}

describe('DelegationResetStep', () => {
  it('[INV-109] the delegation step deletes settled delegations and keeps attempted and running ones and every delegation token', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))

    expect(step.name).toBe('delegation')
    expect(ids(db, 'delegations')).toStrictEqual([DELEGATION.attempted, DELEGATION.running])
    expect(ids(db, 'delegation_tokens')).toStrictEqual(Object.values(LAUNCH).sort())
    // The running delegation keeps its worker and its launch.
    expect(
      db.all('SELECT worker_dwarf_id FROM delegations WHERE id = ?', [DELEGATION.running])
    ).toEqual([{ worker_dwarf_id: WORKER }])
    expect(ids(db, 'launches')).toStrictEqual(Object.values(LAUNCH).sort())
  })

  it('[ADR-023] running the step twice leaves the same rows', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))
    const once = delegationRows(db)
    runner.inTransaction(() => step.reset(runner))

    expect(once).toHaveLength(2)
    expect(delegationRows(db)).toStrictEqual(once)
  })

  it('[ADR-023] a settled delegation whose worker launch is also settled is deleted before that launch, and the db transaction commits', () => {
    const { db, runner, step } = seeded()
    // 09 §7.2 (4): the launching step's statement, run after the delegation step.
    const settledLaunches = `DELETE FROM launches WHERE settled_at IS NOT NULL
      AND id NOT IN (SELECT launch_id FROM launch_records)`

    runner.inTransaction(() => {
      step.reset(runner)
      // The deleted delegation nulled its worker launch's FK, which no CHECK reads (V4-01).
      expect(db.all('SELECT delegation_id FROM launches WHERE id = ?', [LAUNCH.succeeded])).toEqual(
        [{ delegation_id: null }]
      )
      db.run(settledLaunches)
    })

    expect(ids(db, 'launches')).toStrictEqual([LAUNCH.attempted, LAUNCH.running].sort())
    expect(ids(db, 'delegations')).toStrictEqual([DELEGATION.attempted, DELEGATION.running])
  })

  it('[ADR-023] the step called with no open transaction throws and writes nothing', () => {
    const { db, runner, step } = seeded()
    const before = delegationRows(db)

    expect(() => step.reset(runner)).toThrow(HostInvariantError)

    expect(delegationRows(db)).toStrictEqual(before)
  })
})
