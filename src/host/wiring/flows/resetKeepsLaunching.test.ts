// layer: L2
// L2 (17 §1.2): the launching module's Reset step registered with the Reset-metrics saga by
// host/wiring/resetParticipants.ts after the mines and crew steps (ADR-023 items 1, 3-5; 09 §7.2
// step (4); 16 §4.12 `ResetDbStep`, AMENDMENT-10), composed over a copy of the template database
// with the real saga and every registered module step: a Reset while an owned session runs
// commits, the session's launch record, launch and process stay, and a person message still being
// handed over (`sending`, 07 S7.19) survives the `db` transaction and settles afterwards.
//
// TC-181-01, TC-181-02.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import { createAttentionResetStep } from '../../modules/attention'
import { SqliteLaunchRecordStore } from '../../modules/launching/adapters/sqlite/SqliteLaunchRecordStore'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type SecretStore
} from '../../modules/preferences'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { createModuleResetSteps } from '../moduleResetSteps'
import { resetParticipants } from '../resetParticipants'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0181'
const MINE = '00000000-0000-7000-8000-0000000181f1'
const LIVE = '00000000-0000-7000-8000-0000000181d1' as DwarfId
const GONE = '00000000-0000-7000-8000-0000000181d2'
const LIVE_LAUNCH = '00000000-0000-7000-8000-0000000181b1'
const GONE_LAUNCH = '00000000-0000-7000-8000-0000000181b2'
const LIVE_PROCESS = '00000000-0000-7000-8000-0000000181c1'
const SENDING = '00000000-0000-7000-8000-0000000181e1'
const DELIVERED = '00000000-0000-7000-8000-0000000181e2'
const AFTER_RESET = '00000000-0000-7000-8000-0000000181e3'

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
 * A Host over a template copy: a present dwarf whose DwarfAI-launched session runs (succeeded
 * launch, live launch record, its process) with one person message still `sending` and one
 * delivered, and a departed dwarf whose settled launch only its own record references.
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
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', 'session-live', 'Durin', 'foreman', 'running', 'active', ?, ?)`,
      [LIVE, MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
       VALUES (?, ?, 'claude', 'session-gone', 'Balin', 'foreman', 'closed', 'none-yet', ?, ?, ?,
         'stopped')`,
      [GONE, MINE, T0, T0, T0 + 5]
    )
    ;(
      [
        [LIVE_LAUNCH, LIVE],
        [GONE_LAUNCH, GONE]
      ] as const
    ).forEach(([launchId, dwarfId]) =>
      db.run(
        `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
           state, dwarf_id, delegated, host_epoch, requested_at, settled_at)
         VALUES (?, ?, '/work/mine-one', 'supplier', 'claude', 0, 'succeeded', ?, 0, ?, ?, ?)`,
        [launchId, MINE, dwarfId, EPOCH, T0, T0 + 1]
      )
    )
    db.run(
      `INSERT INTO processes (id, pid, process_start_time_ms, boot_id, purpose, launch_id,
         host_epoch, recorded_at)
       VALUES (?, 1811, ?, 'boot-0181', 'session', ?, ?, ?)`,
      [LIVE_PROCESS, T0, LIVE_LAUNCH, EPOCH, T0]
    )
    db.run(
      `INSERT INTO launch_records (dwarf_id, launch_id, driver_transport, session_ref_json, cwd,
         process_id, resume_intent, host_epoch, ended_at)
       VALUES (?, ?, 'stream-json', '{}', '/work/mine-one', ?, 1, ?, NULL)`,
      [LIVE, LIVE_LAUNCH, LIVE_PROCESS, EPOCH]
    )
    db.run(
      `INSERT INTO launch_records (dwarf_id, launch_id, driver_transport, session_ref_json, cwd,
         resume_intent, host_epoch, ended_at)
       VALUES (?, ?, 'stream-json', '{}', '/work/mine-one', 0, ?, ?)`,
      [GONE, GONE_LAUNCH, EPOCH, T0 + 5]
    )
    ;(
      [
        [SENDING, 'sending', null],
        [DELIVERED, 'delivered', 'confirmed']
      ] as const
    ).forEach(([id, phase, confidence]) => {
      db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
         VALUES (?, ?, 'person', 'keep digging', 'dwarfai', ?)`,
        [id, LIVE, T0 + 4]
      )
      db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, confidence, sent_at, phase_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?)`,
        [id, LIVE, phase, confidence, T0 + 4, T0 + 4]
      )
    })
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
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })
  const records = new SqliteLaunchRecordStore({ db, scope: runner })
  const column = (sql: string): string[] => db.all(sql).map((row) => String(Object.values(row)[0]))
  return { db, runner, saga, participants, records, column }
}

describe('the Reset saga with the launching step', () => {
  it('[ADR-023] a Reset while an owned session runs commits and the session keeps running and receiving messages', async () => {
    const { db, runner, saga, participants, records, column } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result.outcome).toBe('reset')
    const names = participants.dbSteps.map((step) => step.name)
    expect(names.indexOf('launching')).toBeGreaterThan(names.indexOf('crew'))
    expect(names.indexOf('launching')).toBeGreaterThan(names.indexOf('mines'))
    // 09 §7.2 (4): the departed dwarf's settled launch went; the live session's stayed with its
    // record and its process (INV-109).
    expect(column('SELECT id FROM launches ORDER BY id')).toStrictEqual([LIVE_LAUNCH])
    expect(records.live().map((r) => [r.dwarfId, r.launchId])).toStrictEqual([[LIVE, LIVE_LAUNCH]])
    expect(column(`SELECT launch_id FROM processes WHERE id = '${LIVE_PROCESS}'`)).toStrictEqual([
      LIVE_LAUNCH
    ])
    expect(column(`SELECT process_state FROM dwarfs WHERE id = '${LIVE}'`)).toStrictEqual([
      'running'
    ])
    // The session keeps receiving messages: a new person message is handed over after the reset.
    runner.inTransaction(() => {
      db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
         VALUES (?, ?, 'person', 'one more vein', 'dwarfai', ?)`,
        [AFTER_RESET, LIVE, T0 + 20]
      )
      db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
         VALUES (?, ?, 'message', 'sending', ?, ?)`,
        [AFTER_RESET, LIVE, T0 + 20, T0 + 20]
      )
    })
    expect(column('SELECT message_id FROM deliveries ORDER BY message_id')).toStrictEqual([
      SENDING,
      AFTER_RESET
    ])
  })

  it('[S7.19, ADR-023] a sending delivery and its message are kept by Reset and settle normally afterwards', async () => {
    const { db, runner, saga, column } = host()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result.outcome).toBe('reset')
    expect(column('SELECT id FROM messages ORDER BY id')).toStrictEqual([SENDING])
    expect(column(`SELECT phase FROM deliveries WHERE message_id = '${SENDING}'`)).toStrictEqual([
      'sending'
    ])
    // The hand-over settles: the driver's result is the second transaction (09 §8.2).
    runner.inTransaction(() =>
      db.run(
        `UPDATE deliveries SET phase = 'delivered', confidence = 'confirmed', phase_at = ?
         WHERE message_id = ?`,
        [T0 + 20, SENDING]
      )
    )
    expect(column(`SELECT phase FROM deliveries WHERE message_id = '${SENDING}'`)).toStrictEqual([
      'delivered'
    ])
  })
})
