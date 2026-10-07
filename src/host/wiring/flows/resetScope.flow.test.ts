// layer: L5
// L5 (17 §1.5) and L2 (17 §1.2): the Reset-metrics saga over every cut-1 module's step, as the
// composition root registers them (host/wiring/moduleResetSteps.ts and resetParticipants.ts;
// ADR-023 items 1–4; 16 §4.12 `ResetDbStep`; 09 §7.2), over a copy of the template database seeded
// as the 09 §6.5 "Reset scope" probe restricted to the cut-1 tables: a mine with a present dwarf
// (and a departed one), a mine with no dwarf, a removed mine with a departed dwarf, messages with a
// `sending` one, ledger entries and the install moment, cursors, message keys, lifecycle facts and
// `ended_agents` rows. The saga's one `db` transaction runs them in the 09 §7.2 order, and a
// failure in its last step rolls back every one (16 §2.2). The "Reset resume" probe: a Host killed
// between the `db` commit and `VACUUM` re-runs the `db` tail at its next boot, before the secrets
// step, and never the module steps again.
//
// TC-121-01, TC-121-02, TC-121-03.
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, HostEpoch, Instant, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { SqliteDatabase, SqliteParam } from '../../kernel/ports/sqliteDatabase'
import { createAttentionResetStep } from '../../modules/attention'
import { createConversation, type ConversationEvent } from '../../modules/conversation'
import { createLedger, zeroTotals, type HistoricalUsageScanner } from '../../modules/ledger'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type ResetDbMaintenance,
  type ResetDbStep,
  type SecretStore
} from '../../modules/preferences'
import { NodeSqliteDatabase } from '../../platform/sqlite/NodeSqliteDatabase'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { copyTemplateDb } from '../../platform/sqlite/testing/templateDb'
import {
  composeObservedBatchSink,
  conversationBatchHalf,
  ledgerBatchHalf
} from '../bridges/observedBatchSink'
import { createModuleResetSteps } from '../moduleResetSteps'
import { resetParticipants } from '../resetParticipants'

const T0 = 1_790_000_000_000
const NOW = T0 + 86_400_000
const EPOCH = 'epoch-0121' as HostEpoch
const YES = { confirmed: 'yes' } as const

const MINE = {
  /** Removed, its one dwarf departed, its ledger retained (PO #4). */
  removed: '00000000-0000-7000-8000-0000000121f1',
  /** Declared and measured, no dwarf ever arrived. */
  empty: '00000000-0000-7000-8000-0000000121f2',
  /** Measured gold, with a present dwarf and a departed one. */
  occupied: '00000000-0000-7000-8000-0000000121f3'
} as const

const DWARF = {
  present: '00000000-0000-7000-8000-0000000121d1',
  departedHere: '00000000-0000-7000-8000-0000000121d2',
  departedRemoved: '00000000-0000-7000-8000-0000000121d3'
} as const

const MESSAGE = {
  /** The present dwarf's observed words, keyed by their provider record. */
  presentWords: '00000000-0000-7000-8000-0000000121e1',
  /** A person message to the present dwarf, delivered. */
  presentDelivered: '00000000-0000-7000-8000-0000000121e2',
  /** A person message to the present dwarf, still being handed over. */
  presentSending: '00000000-0000-7000-8000-0000000121e3',
  /** The departed dwarf's observed words. */
  departedWords: '00000000-0000-7000-8000-0000000121e4'
} as const

const KEY = {
  present: 'claude:session-present:event-1',
  departed: 'claude:session-departed-here:event-1'
} as const

/** An `ended_agents` row of a departed subagent and one of a session no dwarf row names. */
const ENDED = [
  ['claude', 'session-departed-here', 'agent-1', T0 + 5],
  ['codex', 'session-never-bound', '', T0 + 6]
] as const

/** Every table of the cut-1 modules (09 §4), in the order a snapshot reads them. */
const CUT_1_TABLES = [
  'mines',
  'dwarfs',
  'dwarf_lifecycle_facts',
  'observed_sessions',
  'observed_session_streams',
  'source_cursors',
  'ended_agents',
  'messages',
  'message_keys',
  'deliveries',
  'activity_disclosures',
  'outcome_lines',
  'usage_units',
  'usage_observations',
  'ledger_entries',
  'material_totals',
  'install_moment',
  'coal_backfill_units',
  'attention_keys',
  'host_preferences',
  'reset_journal',
  'app_meta'
] as const

function seed(db: SqliteDatabase): void {
  const mine = (id: string, path: string, state: string, removedAt: number | null) =>
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
         has_been_measured, measured_at, removed_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, 'gold', 123456, 1, ?, ?, ?, ?)`,
      [id, path, path.slice(1), path.slice(1), state, T0 + 1, removedAt, T0, T0 + 2]
    )
  mine(MINE.removed, '/removed', 'removed', T0 + 3)
  mine(MINE.empty, '/empty', 'active', null)
  mine(MINE.occupied, '/occupied', 'active', null)

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
      [`00000000-0000-7000-8000-0000000121a${n}`, id, T0, T0]
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

  // Conversation: observed words with their keys, a delivered and a `sending` person message.
  const observed = (id: string, dwarfId: string, key: string) => {
    db.run(
      `INSERT INTO messages (id, dwarf_id, source_key, role, text, origin, provider_time,
         created_at)
       VALUES (?, ?, ?, 'dwarf', 'Struck gold.', 'transcript', ?, ?)`,
      [id, dwarfId, key, T0 + 1, T0 + 1]
    )
    db.run(
      `INSERT INTO message_keys (source_key, dwarf_id, message_id, first_seen_at)
       VALUES (?, ?, ?, ?)`,
      [key, dwarfId, id, T0 + 1]
    )
  }
  observed(MESSAGE.presentWords, DWARF.present, KEY.present)
  observed(MESSAGE.departedWords, DWARF.departedHere, KEY.departed)
  const person = (id: string, phase: 'delivered' | 'sending') => {
    db.run(
      `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
       VALUES (?, ?, 'person', ?, 'dwarfai', ?)`,
      [id, DWARF.present, `a ${phase} message`, T0 + 2]
    )
    db.run(
      `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
       VALUES (?, ?, 'message', ?, ?, ?)`,
      [id, DWARF.present, phase, T0 + 2, T0 + 2]
    )
  }
  person(MESSAGE.presentDelivered, 'delivered')
  person(MESSAGE.presentSending, 'sending')
  db.run(
    `INSERT INTO activity_disclosures (id, dwarf_id, turn_key, open, opened_at, closed_at)
     VALUES ('00000000-0000-7000-8000-0000000121b1', ?, 'turn-1', 0, ?, ?)`,
    [DWARF.present, T0, T0 + 1]
  )
  db.run(
    `INSERT INTO outcome_lines (dwarf_id, kind, reliability, at)
     VALUES (?, 'finished', 'reliable', ?)`,
    [DWARF.present, T0 + 1]
  )
  // A past turn key of the present dwarf, which the attention step deletes (09 §7.2).
  db.run(
    `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
     VALUES (?, ?, 'turn-finished', NULL, ?, ?)`,
    [`${DWARF.present}:turn-finished:turn-1`, DWARF.present, EPOCH, T0]
  )

  // Usage and ore: the present dwarf's in the occupied mine, the departed one's in the removed mine.
  const usage = (unit: string, dwarfId: string, mineId: string, tokens: number) => {
    db.run(
      `INSERT INTO usage_units (unit_key, dwarf_id, mine_id, sealed, provider_time,
         first_observed_at, sealed_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      [unit, dwarfId, mineId, T0 + 1, T0 + 1, T0 + 1]
    )
    db.run(
      `INSERT INTO usage_observations (source_key, unit_key, path, fidelity, output, sealed,
         provider_time, observed_at)
       VALUES (?, ?, 'transcript', 1, ?, 1, ?, ?)`,
      [`obs-${unit}`, unit, tokens, T0 + 1, T0 + 1]
    )
    db.run(
      `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind,
         credited_at)
       VALUES (?, ?, ?, 'gold', ?, 1, 'live', ?)`,
      [`${unit.padEnd(32, '0').slice(0, 32)}0e01`, unit, mineId, tokens, T0 + 1]
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

/** Every connection a case opened, closed before its temp directory is removed. */
const opened: NodeSqliteDatabase[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

/** The process of a killed Host is gone: nothing it would still do runs (CH-11). */
class HostKilled extends Error {
  constructor() {
    super('CH-11: the Host was killed')
    this.name = 'HostKilled'
  }
}

/** The Host's connection, which the fake injector can kill: every later call throws. */
function killable(db: SqliteDatabase): SqliteDatabase & { kill(): void } {
  let killed = false
  const guard = <T>(work: () => T): T => {
    if (killed) throw new HostKilled()
    return work()
  }
  return {
    exec: (sql) => guard(() => db.exec(sql)),
    run: (sql, params) => guard(() => db.run(sql, params)),
    all: (sql, params) => guard(() => db.all(sql, params)),
    openReader: () => guard(() => db.openReader()),
    close: () => db.close(),
    kill: () => {
      killed = true
    }
  }
}

/** What the machine keeps across Hosts: the database file and the OS secret store. */
function machine() {
  const path = copyTemplateDb()
  const raw = NodeSqliteDatabase.open(path)
  opened.push(raw)
  new SqliteTransactionRunner(raw).inTransaction(() => seed(raw))
  return {
    path,
    secrets: new Map<string, string>([
      ['jev-key', 'k'],
      ['opencode-password', 'p']
    ])
  }
}

type Machine = ReturnType<typeof machine>

interface HostOptions {
  /** Wraps the attention step, the last one the `db` transaction runs. */
  lastStep?: (attention: ResetDbStep) => ResetDbStep
  /** Kills the Host after the `db` commit and before the backups, the WAL and `VACUUM` (CH-11). */
  killBeforeCleanup?: boolean
}

/** One Host over the machine's database: the saga as the composition root wires it (16 §8.2). */
function host(m: Machine, options: HostOptions = {}) {
  const raw = NodeSqliteDatabase.open(m.path)
  opened.push(raw)
  const db = killable(raw)
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(NOW)
  const ids = new SequenceIdGenerator()
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  /** Every step the saga runs and every action of its later steps, in order. */
  const order: string[] = []
  /** The mines module's walks, played: what the route asked of them. */
  const walks: string[] = []

  // Boot step 3: the steps over the database alone, then the saga (preferencesWiring.ts).
  const modules = createModuleResetSteps({
    db,
    scope: transactions,
    clock,
    mapSites: [],
    random: () => 0
  })
  const attention = createAttentionResetStep({ db, scope: transactions })
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    modules: modules.steps,
    attention: options.lastStep === undefined ? attention : options.lastStep(attention),
    ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    clock
  })
  const recorded = participants.dbSteps.map((step): ResetDbStep => ({
    name: step.name,
    reset: (tx) => {
      order.push(step.name)
      step.reset(tx)
    }
  }))
  const kill = (): never => {
    db.kill()
    throw new HostKilled()
  }
  const maintenance: ResetDbMaintenance = {
    deleteBackups: () => {
      if (options.killBeforeCleanup === true) kill()
      order.push('deleteBackups')
    },
    truncateWal: () => void order.push('truncateWal'),
    vacuum: () => void order.push('vacuum')
  }
  const secrets: SecretStore = {
    backend: () => Promise.resolve('os-secret-store'),
    get: (name) => Promise.resolve(m.secrets.get(name) ?? null),
    has: (name) => Promise.resolve(m.secrets.has(name)),
    set: (name, value) => {
      m.secrets.set(name, value)
      return Promise.resolve()
    },
    delete: (name) => {
      order.push(`delete ${name}`)
      m.secrets.delete(name)
      return Promise.resolve('deleted')
    }
  }
  const externalConfig: ExternalConfigWriter = {
    install: () => Promise.reject(new Error('nothing is installed in this case')),
    verify: () => Promise.resolve('absent'),
    revert: () => Promise.resolve({ ok: true, value: undefined }),
    findLegacy: () => Promise.resolve(false)
  }
  const saga = createResetSaga({
    db,
    transactions,
    dbSteps: recorded,
    installMoment: participants.installMoment,
    maintenance,
    secrets,
    externalConfig,
    // No UI is attached: the ui-prefs step settles at once (07 S13.05).
    ui: { progress: () => undefined, resetPreferences: () => Promise.resolve() },
    bus,
    clock,
    ids,
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })
  // Boot step 4, once mines exists: the recreated mines' walks.
  modules.route({
    bus,
    walks: {
      abortAll: () => void walks.push('abortAll'),
      walkDue: (mineId) => void walks.push(`walkDue ${mineId}`)
    }
  })
  return { raw, transactions, clock, ids, saga, order, walks, participants }
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

function snapshot(db: SqliteDatabase): Record<string, object[]> {
  return Object.fromEntries(
    CUT_1_TABLES.map((table) => [table, rows(db, `SELECT * FROM ${table} ORDER BY 1`)])
  )
}

describe('Reset scope, cut-1 modules (09 §6.5)', () => {
  it('[ADR-023] the db transaction commits with every cut-1 step registered and every table marked deleted in 09 §7.2 is empty afterwards', async () => {
    const m = machine()
    const { raw, saga, order } = host(m)

    const result = await saga.resetMetrics(YES)

    expect(result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    // 09 §7.2: (2) mines and crew, then (3) the other per-table deletions, attention last.
    expect(order.slice(0, 7)).toStrictEqual([
      'mines',
      'crew',
      'preferences',
      'observation',
      'ledger',
      'conversation',
      'attention'
    ])
    expect(column(raw, 'SELECT id FROM mines')).toStrictEqual([MINE.occupied])
    expect(column(raw, 'SELECT id FROM dwarfs')).toStrictEqual([DWARF.present])
    expect(column(raw, 'SELECT id FROM messages')).toStrictEqual([MESSAGE.presentSending])
    expect({
      activity_disclosures: count(raw, 'activity_disclosures'),
      outcome_lines: count(raw, 'outcome_lines'),
      usage_units: count(raw, 'usage_units'),
      usage_observations: count(raw, 'usage_observations'),
      ledger_entries: count(raw, 'ledger_entries'),
      material_totals: count(raw, 'material_totals'),
      coal_backfill_units: count(raw, 'coal_backfill_units'),
      attention_keys: count(raw, 'attention_keys')
    }).toStrictEqual({
      activity_disclosures: 0,
      outcome_lines: 0,
      usage_units: 0,
      usage_observations: 0,
      ledger_entries: 0,
      material_totals: 0,
      coal_backfill_units: 0,
      attention_keys: 0
    })
    // Deleted in `db`, rewritten `(now, 'reset')` by the install-moment step; the backfill re-runs.
    expect(
      rows(raw, 'SELECT at, reason, backfill_state, backfill_done_at FROM install_moment')
    ).toStrictEqual([
      { at: NOW, reason: 'reset', backfill_state: 'not-started', backfill_done_at: null }
    ])
    // INV-36: every ended_agents row stays (ADR-029 §B).
    expect(
      raw
        .all(
          `SELECT provider_id, provider_session_id, provider_agent_id, ended_at FROM ended_agents
           ORDER BY provider_id`
        )
        .map((row) => Object.values(row))
    ).toStrictEqual(ENDED.map((row) => [...row]))
  })

  it('[ADR-023] the present dwarf keeps its row, cursors, message keys and lifecycle facts; its mine keeps its id and is measuring again', async () => {
    const m = machine()
    const { raw, saga, walks } = host(m)

    await saga.resetMetrics(YES)

    expect(
      rows(raw, 'SELECT id, mine_id, process_state, presence, custom_name, departed_at FROM dwarfs')
    ).toStrictEqual([
      {
        id: DWARF.present,
        mine_id: MINE.occupied,
        process_state: 'running',
        presence: 'present',
        custom_name: null,
        departed_at: null
      }
    ])
    expect(
      rows(
        raw,
        `SELECT s.dwarf_id, c.stream_id, c.value FROM observed_session_streams s
         JOIN source_cursors c ON c.stream_id = s.stream_id`
      )
    ).toStrictEqual([{ dwarf_id: DWARF.present, stream_id: `stream-${DWARF.present}`, value: 42 }])
    // The keys of present dwarfs stay, pointing at nothing; those of departed dwarfs went (09 §7.2).
    expect(rows(raw, 'SELECT source_key, dwarf_id, message_id FROM message_keys')).toStrictEqual([
      { source_key: KEY.present, dwarf_id: DWARF.present, message_id: null }
    ])
    expect(column(raw, 'SELECT dwarf_id FROM dwarf_lifecycle_facts')).toStrictEqual([DWARF.present])
    expect(
      rows(raw, 'SELECT id, state, tier, has_been_measured, created_at FROM mines')
    ).toStrictEqual([
      { id: MINE.occupied, state: 'measuring', tier: null, has_been_measured: 0, created_at: NOW }
    ])
    // After the commit (`MetricsResetStarted`): every walk aborted, then the recreated mine walked.
    expect(walks).toStrictEqual(['abortAll', `walkDue ${MINE.occupied}`])
  })

  it('[ADR-023] a sending message and its delivery survive the reset', async () => {
    const m = machine()
    const { raw, saga } = host(m)

    await saga.resetMetrics(YES)

    expect(rows(raw, 'SELECT id, dwarf_id, role, text FROM messages')).toStrictEqual([
      {
        id: MESSAGE.presentSending,
        dwarf_id: DWARF.present,
        role: 'person',
        text: 'a sending message'
      }
    ])
    expect(rows(raw, 'SELECT message_id, dwarf_id, phase FROM deliveries')).toStrictEqual([
      { message_id: MESSAGE.presentSending, dwarf_id: DWARF.present, phase: 'sending' }
    ])
  })

  it('[ADR-023] a failure injected in the last step leaves every table unchanged', async () => {
    const m = machine()
    const { raw, saga, order, walks } = host(m, {
      lastStep: (attention) => ({
        name: attention.name,
        reset: (tx) => {
          attention.reset(tx)
          throw new Error('the last ResetDbStep failed')
        }
      })
    })
    const before = snapshot(raw)

    const result = await saga.resetMetrics(YES)

    expect(result).toStrictEqual({
      outcome: 'failed',
      reason: 'db-transaction-failed',
      resumesOnNextStart: false
    })
    // Every step ran inside the one transaction, and its rollback undid them all.
    expect(order).toStrictEqual([
      'mines',
      'crew',
      'preferences',
      'observation',
      'ledger',
      'conversation',
      'attention'
    ])
    expect(snapshot(raw)).toStrictEqual(before)
    // Nothing committed, so nothing was published: no walk was touched.
    expect(walks).toStrictEqual([])
  })

  it('[ADR-023] after the reset a replay of a pre-reset transcript inserts nothing and the ledger totals start from zero', async () => {
    const m = machine()
    const { raw, transactions, clock, ids, saga } = host(m)
    await saga.resetMetrics(YES)
    const messagesAfterReset = rows(raw, 'SELECT * FROM messages ORDER BY id')

    // Observation re-reads the present dwarf's transcript from the start, through the
    // ObservedBatchSink bridge as host/main.ts composes it (ISSUE-096, ISSUE-108).
    const conversation = createConversation({
      db: raw,
      transactions,
      bus: new InProcessEventBus<ConversationEvent>({
        transactionScope: transactions,
        onHandlerError: (failure) => {
          throw failure.error
        }
      }),
      lifecycleFacts: new SqliteLifecycleFactLog({ db: raw, scope: transactions, ids, clock }),
      clock,
      ids,
      hostEpoch: EPOCH
    })
    const NO_HISTORY: HistoricalUsageScanner = {
      scan: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined })
        })
      })
    }
    const ledger = createLedger({
      repository: new SqliteLedgerRepository({ db: raw, scope: transactions, ids, clock }),
      transactions,
      scope: transactions,
      bus: new InProcessEventBus({
        transactionScope: transactions,
        onHandlerError: () => undefined
      }),
      clock,
      ids,
      hostEpoch: EPOCH,
      scanner: NO_HISTORY,
      log: new RecordingDiagnosticsLog()
    })
    const bridge = composeObservedBatchSink({
      transactions,
      ledger: ledgerBatchHalf(ledger),
      conversation: conversationBatchHalf(conversation)
    })
    clock.advance(1_000)
    bridge.transactions.inTransaction(() =>
      bridge.sink.apply({
        dwarfId: DWARF.present as DwarfId,
        entries: [
          {
            sourceKey: KEY.present,
            role: 'dwarf',
            text: 'Struck gold.',
            providerTime: (T0 + 1) as Instant
          }
        ],
        usage: [
          {
            sourceKey: 'obs-unit-present',
            unitKey: 'unit-present',
            dwarfId: DWARF.present,
            fidelity: 1,
            tokens: { inputNet: 0, output: 1000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            sealed: true,
            providerTime: T0 + 1,
            observedAt: clock.now()
          }
        ]
      })
    )

    expect(rows(raw, 'SELECT * FROM messages ORDER BY id')).toStrictEqual(messagesAfterReset)
    expect(ledger.queries.totals(MINE.occupied as MineId)).toStrictEqual(zeroTotals())
    expect(count(raw, 'ledger_entries')).toBe(0)
  })

  it('[ADR-023] the Reset resume probe: a kill between the db commit and VACUUM re-runs the db tail at the next boot before the secrets step', async () => {
    const m = machine()
    const killed = host(m, { killBeforeCleanup: true })
    await expect(killed.saga.resetMetrics(YES)).rejects.toBeInstanceOf(HostKilled)
    // The `db` transaction committed: the journal reads `db` and the module steps' work is there.
    expect(rows(killed.raw, 'SELECT step, epoch FROM reset_journal')).toStrictEqual([
      { step: 'db', epoch: 1 }
    ])
    const afterCommit = snapshot(killed.raw)

    const next = host(m)
    const resumed = await next.saga.resumeOnBoot()

    expect(resumed).toStrictEqual({ outcome: 'reset', epoch: 1 })
    // The db tail first, then the secrets step; no module step runs again.
    expect(next.order).toStrictEqual([
      'deleteBackups',
      'truncateWal',
      'vacuum',
      'delete jev-key',
      'delete opencode-password'
    ])
    // Only the saga's own rows moved on: its journal, and the install moment it rewrote.
    const afterResume = snapshot(next.raw)
    for (const table of ['reset_journal', 'install_moment'] as const) {
      delete afterResume[table]
      delete afterCommit[table]
    }
    expect(afterResume).toStrictEqual(afterCommit)
    expect(rows(next.raw, 'SELECT step, epoch FROM reset_journal')).toStrictEqual([
      { step: 'done', epoch: 1 }
    ])
    expect(rows(next.raw, 'SELECT at, reason FROM install_moment')).toStrictEqual([
      { at: NOW, reason: 'reset' }
    ])
  })
})
