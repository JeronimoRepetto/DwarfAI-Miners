// layer: L2
// L2 (17 §1.2): the attention module's Reset step registered with the Reset-metrics saga by
// host/wiring/resetParticipants.ts (ADR-023 items 1, 4; 09 §7.2; 16 §4.12 `ResetDbStep`), composed
// over a copy of the template database with the real attention policy and its SQLite ledger: an
// ask open across the reset is never announced again (INV-100), and the step is part of the saga's
// one `db` transaction, so it rolls back with it.
//
// TC-118-02, TC-118-03.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import {
  createAttention,
  createAttentionResetStep,
  type AttentionEvent,
  type AttentionFact
} from '../../modules/attention'
import { SqliteAttentionLedger } from '../../modules/attention/adapters/SqliteAttentionLedger'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type ResetDbStep,
  type SecretStore
} from '../../modules/preferences'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { resetParticipants } from '../resetParticipants'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0118'
const MINE = '00000000-0000-7000-8000-0000000118f1' as MineId
const DWARF = '00000000-0000-7000-8000-0000000118d1' as DwarfId
const OPEN_ASK = '00000000-0000-7000-8000-0000000118a1'
const NEW_ASK = '00000000-0000-7000-8000-0000000118a2'
const NAMES = { displayName: 'Gimli', mineName: 'Moria' }

/** Cut 1: nothing in the OS secret store, no owned config entry (the steps complete at once). */
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

/** A Host over a template copy: one present dwarf, its attention module and the Reset saga. */
function host(options: { laterStep?: ResetDbStep } = {}) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/moria', 'Moria', 'moria', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', 'session-1', 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
  })
  const openAsk = (id: string): AttentionFact => {
    transactions.inTransaction(() =>
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at)
         VALUES (?, ?, 'question', 'driver', ?, '{}', 'open', ?)`,
        [id, DWARF, `request-${id}`, clock.now()]
      )
    )
    return {
      key: `${DWARF}:question:${id}`,
      kind: 'question',
      dwarfId: DWARF,
      mineId: MINE,
      at: clock.now(),
      reannounce: true
    }
  }

  const attentionBus = new RecordingEventBus<AttentionEvent>({ transactionScope: transactions })
  const attention = createAttention({
    settings: { systemNotificationsOn: () => true },
    ledger: new SqliteAttentionLedger({ db, scope: transactions, clock, hostEpoch: EPOCH }),
    transactions,
    bus: attentionBus,
    clock,
    ids,
    hostEpoch: EPOCH,
    titles: (kind, displayName) => `fake ${kind} title for ${displayName}`
  })

  // The saga as the composition root wires it, with the attention step registered.
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    attention: createAttentionResetStep({ db, scope: transactions }),
    ledger: { setInstallMoment: () => undefined },
    clock
  })
  const later = options.laterStep === undefined ? [] : [options.laterStep]
  const saga = createResetSaga({
    db,
    transactions,
    dbSteps: [...participants.dbSteps, ...later],
    installMoment: participants.installMoment,
    maintenance: {
      deleteBackups: () => undefined,
      truncateWal: () => undefined,
      vacuum: () => undefined
    },
    secrets: noSecrets,
    externalConfig: noOwnedConfig,
    // No UI is attached: the ui-prefs step settles at once (07 S13.05).
    ui: { progress: () => undefined, resetPreferences: () => Promise.resolve() },
    bus: new InProcessEventBus<PreferencesEvent>({
      transactionScope: transactions,
      onHandlerError: () => undefined
    }),
    clock,
    ids,
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })

  const notified = () => attentionBus.ofType('AttentionNotified').map((e) => e.payload.key)
  const keys = () =>
    db.all('SELECT key FROM attention_keys ORDER BY key').map((row) => String(row['key']))
  /** A past turn-finished key of the dwarf, which the reset deletes (09 §7.2). */
  const addTurnKey = () =>
    transactions.inTransaction(() =>
      db.run(
        `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
         VALUES (?, ?, 'turn-finished', NULL, ?, ?)`,
        [`${DWARF}:turn-finished:turn-1`, DWARF, EPOCH, T0]
      )
    )
  return { attention, participants, saga, openAsk, notified, keys, addTurnKey }
}

describe('resetAttention flow', () => {
  it('[ADR-023, INV-100] after a reset an ask that was open before it is not announced again, and a new need after it is announced once', async () => {
    const { attention, saga, openAsk, notified, keys, addTurnKey } = host()
    const open = openAsk(OPEN_ASK)
    attention.inputs.onFact(open, NAMES)
    expect(notified()).toStrictEqual([open.key])
    addTurnKey()

    const result = await saga.resetMetrics({ confirmed: 'yes' })
    expect(result.outcome).toBe('reset')

    // The open ask is observed again after the reset (a replay, a re-read): its key was kept.
    attention.inputs.onFact(open, NAMES)
    const fresh = openAsk(NEW_ASK)
    attention.inputs.onFact(fresh, NAMES)
    attention.inputs.onFact(fresh, NAMES)

    expect(notified()).toStrictEqual([open.key, fresh.key])
    // The registered step ran: the past turn key went, the open ask's key stayed (09 §7.2).
    expect(keys()).toStrictEqual([open.key, fresh.key].sort())
  })

  it('[ADR-023] the attention step is registered with the saga and runs inside its db transaction', async () => {
    const failing: ResetDbStep = {
      name: 'a-later-step',
      reset: () => {
        throw new Error('a later ResetDbStep failed')
      }
    }
    const { participants, saga, keys, addTurnKey } = host({ laterStep: failing })
    expect(participants.dbSteps.map((step) => step.name)).toContain('attention')
    // A turn key the attention step deletes (09 §7.2), so a rollback is visible.
    addTurnKey()
    const before = keys()

    const result = await saga.resetMetrics({ confirmed: 'yes' })

    expect(result).toStrictEqual({
      outcome: 'failed',
      reason: expect.any(String),
      resumesOnNextStart: false
    })
    expect(keys()).toStrictEqual(before)
  })
})
