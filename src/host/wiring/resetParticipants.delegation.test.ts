// layer: L2
// L2 (17 §1.2): the delegation module's Reset step registered with the Reset-metrics saga by
// host/wiring/resetParticipants.ts (ADR-023 items 1, 3, 4; 09 §7.2; 16 §4.12 `ResetDbStep`),
// composed over a copy of the template database with the real saga: a delegation running during
// Reset metrics keeps its row and its token, so its worker hands back its result after the saga
// reaches done; the settled delegations and their settled worker launches go.
//
// TC-208-01, TC-208-03.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../kernel/InProcessEventBus'
import { createAttentionResetStep } from '../modules/attention'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type SecretStore
} from '../modules/preferences'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../platform/sqlite/testing/templateDb'
import { createModuleResetSteps } from './moduleResetSteps'
import { resetParticipants } from './resetParticipants'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000208f1'
const PARENT = '00000000-0000-7000-8000-0000000208d1'
const WORKER = '00000000-0000-7000-8000-0000000208d2'
const RUNNING = '00000000-0000-7000-8000-0000000208a2'
const SUCCEEDED = '00000000-0000-7000-8000-0000000208a3'
const RUNNING_LAUNCH = '00000000-0000-7000-8000-0000000208b2'
const SETTLED_LAUNCH = '00000000-0000-7000-8000-0000000208b3'

const noSecrets: SecretStore = {
  backend: () => Promise.resolve('os-secret-store'),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve('deleted')
}
const noOwnedConfig: ExternalConfigWriter = {
  install: () => Promise.reject(new Error('nothing is installed in this case')),
  verify: () => Promise.resolve('absent'),
  revert: () => Promise.resolve({ ok: true, value: undefined }),
  findLegacy: () => Promise.resolve(false)
}

/**
 * A Host over a template copy: a parent dwarf whose delegation is running with its worker (spawned
 * launch, token) and another delegation already succeeded (settled worker launch, token).
 */
function host() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0 + 10)
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
    db.run(
      `INSERT INTO delegations (id, parent_dwarf_id, worker_dwarf_id, ticket, task_text, state,
         created_at) VALUES (?, ?, ?, 'ticket-running', 'do the work', 'running', ?)`,
      [RUNNING, PARENT, WORKER, T0]
    )
    db.run(
      `INSERT INTO delegations (id, parent_dwarf_id, ticket, state, handoff_via, handoff_phase,
         handoff_phase_at, created_at, settled_at)
       VALUES (?, ?, 'ticket-done', 'succeeded', 'tool-result', 'delivered', ?, ?, ?)`,
      [SUCCEEDED, PARENT, T0 + 2, T0, T0 + 3]
    )
    const launch = (id: string, delegationId: string, state: string, settledAt: number | null) =>
      db.run(
        `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
           state, delegation_id, delegated, host_epoch, requested_at, settled_at)
         VALUES (?, ?, '/work/mine-one', 'supplier', 'claude', 0, ?, ?, 1, 'epoch-0208', ?, ?)`,
        [id, MINE, state, delegationId, T0, settledAt]
      )
    launch(RUNNING_LAUNCH, RUNNING, 'spawned', null)
    launch(SETTLED_LAUNCH, SUCCEEDED, 'succeeded', T0 + 3)
    ;[RUNNING_LAUNCH, SETTLED_LAUNCH].forEach((launchId) =>
      db.run(
        `INSERT INTO delegation_tokens (launch_id, parent_dwarf_id, mechanism, credential_hash, issued_at)
         VALUES (?, ?, 'in-process', NULL, ?)`,
        [launchId, PARENT, T0]
      )
    )
  })
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    modules: createModuleResetSteps({ db, scope: runner, clock, mapSites: [], random: () => 0 })
      .steps,
    attention: createAttentionResetStep({ db, scope: runner }),
    ledger: { setInstallMoment: () => undefined },
    clock
  })
  const saga = createResetSaga({
    db,
    transactions: runner,
    dbSteps: participants.dbSteps,
    installMoment: participants.installMoment,
    maintenance: {
      deleteBackups: () => undefined,
      truncateWal: () => undefined,
      vacuum: () => undefined
    },
    secrets: noSecrets,
    externalConfig: noOwnedConfig,
    ui: { progress: () => undefined, resetPreferences: () => Promise.resolve() },
    bus: new InProcessEventBus<PreferencesEvent>({
      transactionScope: runner,
      onHandlerError: () => undefined
    }),
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0208',
    log: new RecordingDiagnosticsLog()
  })
  const column = (sql: string): string[] => db.all(sql).map((row) => String(Object.values(row)[0]))
  return { db, runner, saga, participants, column }
}

describe('resetParticipants with the delegation step', () => {
  it('[INV-109, FM-142] a delegation running during Reset metrics keeps running and hands back its result after the saga reaches done', async () => {
    const { db, runner, saga, column } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result.outcome).toBe('reset')
    // The settled delegation went; the running one, its worker, its launch and its token stayed.
    // Amended with ISSUE-181: the launching step of 09 §7.2 (4) now deletes the settled worker
    // launch, and its token goes by the schema's `delegation_tokens.launch_id ... ON DELETE
    // CASCADE` (the list was both tokens while no launching step was registered).
    expect(column('SELECT id FROM delegations')).toStrictEqual([RUNNING])
    expect(column('SELECT launch_id FROM delegation_tokens ORDER BY launch_id')).toStrictEqual([
      RUNNING_LAUNCH
    ])
    expect(column(`SELECT worker_dwarf_id FROM delegations WHERE id = '${RUNNING}'`)).toStrictEqual(
      [WORKER]
    )
    expect(
      column(`SELECT delegation_id FROM launches WHERE id = '${RUNNING_LAUNCH}'`)
    ).toStrictEqual([RUNNING])
    // The worker hands its result back: the delegation settles normally.
    runner.inTransaction(() =>
      db.run(
        `UPDATE delegations SET state = 'succeeded', task_text = NULL, handoff_via = 'tool-result',
           handoff_phase = 'delivered', handoff_phase_at = ?, settled_at = ? WHERE id = ?`,
        [T0 + 20, T0 + 20, RUNNING]
      )
    )
    expect(column(`SELECT state FROM delegations WHERE id = '${RUNNING}'`)).toStrictEqual([
      'succeeded'
    ])
  })

  it('[ADR-023] the delegation step is the last step of (3), registered after attention, and the db transaction commits', async () => {
    const { participants, saga, column } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    const names = participants.dbSteps.map((step) => step.name)
    // Amended with ISSUE-181: the launching step of (4) now follows, so the delegation step is
    // the one right before it (it was the last step while no launching step was registered).
    expect(names.indexOf('delegation')).toBe(names.indexOf('launching') - 1)
    expect(names.at(-1)).toBe('launching')
    expect(names.indexOf('delegation')).toBeGreaterThan(names.indexOf('attention'))
    expect(result.outcome).toBe('reset')
    // The running delegation's worker launch stays; the settled one's worker launch is deleted by
    // the launching step of (4) (amended with ISSUE-181: it kept its row while no launching step
    // was registered).
    expect(column('SELECT id FROM launches ORDER BY id')).toStrictEqual([RUNNING_LAUNCH])
  })
})
