// layer: L2
// L2 flow (17 §1.2): "Reset metrics" as the Host saga alone, with every participant (ISSUE-233;
// ADR-023 items 1–5; 09 §7.2; 07 S13.03, S13.04, S41.07; UC-027; 13 FM-126, FM-142). The saga is
// composed as host/wiring/preferencesWiring.ts and host/main.ts compose it: every module's `db` step
// (moduleResetSteps.ts, ordered by resetParticipants.ts), the preferences and attention steps, the
// ledger's install-moment step, the real post-commit cleanup, both secrets through an inline `SecretStore` double (R15),
// the one config writer engine with BOTH real targets (`ClaudeHooksConfigWriter`,
// `OpenCodePluginConfigWriter`) over a FakeFs behind bridges/hostConfigWriter.ts, and a recording UI
// fan-out for the `ui-prefs` step. The world is a copy of the template database seeded with mines
// with and without present dwarfs, ore, custom names, messages (one still being handed over), both
// secrets, both integrations on (written by the engine itself), the first-run step answered, and a
// non-default preferences row. "Start with the system" is UI main's (05 R10): its half is
// ui-main/window/application/resetStartWithSystem.test.ts (lead decision 2026-10-16).
//
// TC-233-01, TC-233-02, TC-233-03 (the Host half), TC-233-04.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Instant, MineId } from '../../kernel/domain/values'
import type { HostEpoch } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase, SqliteParam } from '../../kernel/ports/sqliteDatabase'
import { createAttentionResetStep } from '../../modules/attention'
import { createLedger, type HistoricalUsageScanner } from '../../modules/ledger'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import {
  createPreferencesResetStep,
  createResetSaga,
  createWelcomeStep,
  type ChannelToken,
  type MetricsResetResult,
  type PreferencesEvent,
  type SecretStore
} from '../../modules/preferences'
import { ClaudeHooksConfigWriter } from '../../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../../modules/preferences/adapters/external-config/configWriterEngine'
import {
  OPENCODE_PLUGIN_FILE_NAME,
  OpenCodePluginConfigWriter
} from '../../modules/preferences/adapters/external-config/openCodePlugin/OpenCodePluginConfigWriter'
import { SqliteChannelTokenStore } from '../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { ScriptedToolFs } from '../../modules/preferences/testing/ScriptedToolFs'
import { NodeSqliteDatabase } from '../../platform/sqlite/NodeSqliteDatabase'
import { SqliteResetCleanup } from '../../platform/sqlite/resetCleanup'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { copyTemplateDb } from '../../platform/sqlite/testing/templateDb'
import { hostConfigWriter, persistedIngressPort } from '../bridges/hostConfigWriter'
import { createModuleResetSteps } from '../moduleResetSteps'
import { resetParticipants } from '../resetParticipants'

const T0 = 1_790_000_000_000
const NOW = T0 + 86_400_000
const EPOCH = 'epoch-0233' as HostEpoch
const YES = { confirmed: 'yes' } as const
const INGRESS_PORT = 41_233
const CLAUDE_SETTINGS = '/home/person/.claude/settings.json'
const PLUGIN_DIR = '/home/person/.config/opencode/plugin'
const PLUGIN_FILE = `${PLUGIN_DIR}/${OPENCODE_PLUGIN_FILE_NAME}`
const CLAUDE_TOKEN = 'c1'.repeat(32) as ChannelToken
const PLUGIN_TOKEN = 'f00d'.repeat(16) as ChannelToken

const MINE = {
  /** Measured gold, with a present dwarf and a departed one. */
  occupied: '00000000-0000-7000-8000-0000000233f1',
  /** Declared and measured, no dwarf ever arrived. */
  empty: '00000000-0000-7000-8000-0000000233f2',
  /** Removed, its one dwarf departed. */
  removed: '00000000-0000-7000-8000-0000000233f3'
} as const

const DWARF = {
  /** Alive: its session keeps running through the reset (INV-109). */
  live: '00000000-0000-7000-8000-0000000233d1',
  departedHere: '00000000-0000-7000-8000-0000000233d2',
  departedRemoved: '00000000-0000-7000-8000-0000000233d3'
} as const

const MESSAGE = {
  liveWords: '00000000-0000-7000-8000-0000000233e1',
  liveDelivered: '00000000-0000-7000-8000-0000000233e2',
  /** Still being handed over: kept, and it settles normally afterwards (S7.19). */
  liveSending: '00000000-0000-7000-8000-0000000233e3',
  departedWords: '00000000-0000-7000-8000-0000000233e4'
} as const

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function seed(db: SqliteDatabase): void {
  const mine = (id: string, path: string, state: string, removedAt: number | null) =>
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
         has_been_measured, measured_at, removed_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, 'gold', 123456, 1, ?, ?, ?, ?)`,
      [id, path, path.slice(1), path.slice(1), state, T0 + 1, removedAt, T0, T0 + 2]
    )
  mine(MINE.occupied, '/occupied', 'active', null)
  mine(MINE.empty, '/empty', 'active', null)
  mine(MINE.removed, '/removed', 'removed', T0 + 3)

  const dwarf = (id: string, mineId: string, session: string, departed: boolean) =>
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, custom_name,
         rank, process_state, turn_state, arrived_at, last_activity_at, departed_at,
         departure_cause)
       VALUES (?, ?, 'claude', ?, 'Durin', 'Bob the Bold', 'foreman', ?, 'none-yet', ?, ?, ?, ?)`,
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
  dwarf(DWARF.live, MINE.occupied, 'session-live', false)
  dwarf(DWARF.departedHere, MINE.occupied, 'session-departed-here', true)
  dwarf(DWARF.departedRemoved, MINE.removed, 'session-departed-removed', true)
  db.run(
    `INSERT INTO source_cursors (stream_id, adapter_id, kind, value, updated_at)
     VALUES (?, 'claude', 'byte-offset', 42, ?)`,
    [`stream-${DWARF.live}`, T0]
  )
  db.run(
    `INSERT INTO observed_sessions (dwarf_id, cwd, first_seen_at, last_record_at)
     VALUES (?, '/occupied', ?, ?)`,
    [DWARF.live, T0, T0]
  )
  db.run('INSERT INTO observed_session_streams (dwarf_id, stream_id) VALUES (?, ?)', [
    DWARF.live,
    `stream-${DWARF.live}`
  ])

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
  observed(MESSAGE.liveWords, DWARF.live, 'claude:session-live:event-1')
  observed(MESSAGE.departedWords, DWARF.departedHere, 'claude:session-departed-here:event-1')
  const person = (id: string, phase: 'delivered' | 'sending') => {
    db.run(
      `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
       VALUES (?, ?, 'person', ?, 'dwarfai', ?)`,
      [id, DWARF.live, `a ${phase} message`, T0 + 2]
    )
    db.run(
      `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
       VALUES (?, ?, 'message', ?, ?, ?)`,
      [id, DWARF.live, phase, T0 + 2, T0 + 2]
    )
  }
  person(MESSAGE.liveDelivered, 'delivered')
  person(MESSAGE.liveSending, 'sending')

  // Ore: the live dwarf's gold in the occupied mine, the departed one's in the removed mine.
  const usage = (unit: string, dwarfId: string, mineId: string, tokens: number) => {
    db.run(
      `INSERT INTO usage_units (unit_key, dwarf_id, mine_id, sealed, provider_time,
         first_observed_at, sealed_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      [unit, dwarfId, mineId, T0 + 1, T0 + 1, T0 + 1]
    )
    db.run(
      `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind,
         credited_at)
       VALUES (?, ?, ?, 'gold', ?, 1, 'live', ?)`,
      [`${unit.padEnd(32, '0').slice(0, 32)}0e01`, unit, mineId, tokens, T0 + 1]
    )
  }
  usage('unit-live', DWARF.live, MINE.occupied, 1000)
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

  // Every preference away from its default, and the first-run step answered.
  db.run(
    `INSERT OR REPLACE INTO host_preferences (id, subagent_delegation_on, routing_profile,
       default_provider, default_model, default_effort, system_notifications_on, updated_at)
     VALUES (1, 1, 'premium', 'codex', 'gpt-5', 'high', 0, ?)`,
    [T0]
  )
  db.run('UPDATE app_meta SET welcome_answered_at = ?', [T0 + 5])
}

/** Scheduled retries run at once: no real timer in an L2 test (17 §2.2). */
const immediateScheduler: Scheduler = {
  after(_ms, task) {
    queueMicrotask(task)
    return { cancel: () => undefined }
  }
}

/** The OS secret store as an inline double (16 §4.12.1; R15): a map, with every delete recorded. */
function osSecretStore(): SecretStore & { deleted: string[] } {
  const entries = new Map<string, string>()
  const deleted: string[] = []
  return {
    deleted,
    backend: () => Promise.resolve('os-secret-store'),
    get: (name) => Promise.resolve(entries.get(name) ?? null),
    has: (name) => Promise.resolve(entries.has(name)),
    set: (name, value) => {
      entries.set(name, value)
      return Promise.resolve()
    },
    delete: (name) => {
      deleted.push(name)
      entries.delete(name)
      return Promise.resolve('deleted')
    }
  }
}

const opened: NodeSqliteDatabase[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

/** What the machine keeps across Hosts: the database file, the disk, the OS secret store. */
async function machine() {
  const path = copyTemplateDb()
  const raw = NodeSqliteDatabase.open(path)
  opened.push(raw)
  new SqliteTransactionRunner(raw).inTransaction(() => seed(raw))
  const disk = new FakeFs()
  void disk.makeDir('/home/person/.claude')
  void disk.makeDir(PLUGIN_DIR)
  const secrets = osSecretStore()
  await secrets.set('jev-key', 'jev-secret')
  await secrets.set('opencode-password', 'server-password')
  const m = {
    path,
    disk,
    fs: new ScriptedToolFs(disk),
    secrets,
    clock: new FakeClock(NOW),
    ids: new SequenceIdGenerator()
  }
  // Both integrations on, written by the one config writer as Settings writes them (16 §7.2, §7.3).
  const first = host(m)
  for (const [target, token] of [
    ['claude-hooks', CLAUDE_TOKEN],
    ['opencode-plugin', PLUGIN_TOKEN]
  ] as const) {
    const installed = await first.engine.install(target, token, 'settings', sha256(token))
    if (!installed.ok) throw new Error(`the ${target} integration could not be seeded`)
  }
  return m
}

type Machine = Awaited<ReturnType<typeof machine>>

/** One Host over the machine: the saga as preferencesWiring.ts and host/main.ts compose it. */
function host(m: Machine | Omit<Machine, never>) {
  const raw = NodeSqliteDatabase.open(m.path)
  opened.push(raw)
  const db: SqliteDatabase = raw
  const transactions = new SqliteTransactionRunner(db)
  const { clock, ids } = m
  const log = new RecordingDiagnosticsLog()
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const events: string[] = []
  for (const name of [
    'MetricsResetStarted',
    'MetricsResetFinished',
    'MetricsResetFailed'
  ] as const) {
    bus.subscribe(name, () => void events.push(name))
  }
  const installId = String(db.all('SELECT install_id FROM app_meta')[0]?.['install_id'])
  const ingressPort = { read: () => INGRESS_PORT }
  const engine = new ConfigWriterEngine({
    fs: m.fs,
    transactions,
    ledger: new SqliteConfigWriteLedger({ db }),
    settings: new SqliteIntegrationSettingStore({ db }),
    tokens: new SqliteChannelTokenStore({ db, ids }),
    clock,
    ids,
    scheduler: immediateScheduler,
    log,
    targets: [
      new ClaudeHooksConfigWriter({
        path: CLAUDE_SETTINGS,
        platform: 'linux',
        ingressPort: persistedIngressPort(ingressPort)
      }),
      new OpenCodePluginConfigWriter({
        path: PLUGIN_FILE,
        installId,
        ingressPort: persistedIngressPort(ingressPort)
      })
    ]
  })
  const externalConfig = hostConfigWriter({
    claudeHooks: engine,
    openCodePlugin: engine,
    ingressPort,
    log
  })
  const modules = createModuleResetSteps({
    db,
    scope: transactions,
    clock,
    mapSites: [],
    random: () => 0
  })
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    modules: modules.steps,
    attention: createAttentionResetStep({ db, scope: transactions }),
    ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    clock
  })
  /** The epochs each attached UI was asked to reset its stores to (B-F26). */
  const uiResets: number[] = []
  const saga = createResetSaga({
    db,
    transactions,
    dbSteps: participants.dbSteps,
    installMoment: participants.installMoment,
    maintenance: new SqliteResetCleanup({ db, path: m.path }),
    secrets: m.secrets,
    externalConfig,
    ui: {
      progress: () => undefined,
      resetPreferences: (epoch) => {
        uiResets.push(epoch)
        return Promise.resolve()
      }
    },
    bus,
    clock,
    ids,
    hostEpoch: EPOCH,
    log
  })
  const walks: string[] = []
  modules.route({
    bus,
    walks: {
      abortAll: () => void walks.push('abortAll'),
      walkDue: (mineId) => void walks.push(`walkDue ${mineId}`)
    }
  })
  return { db, transactions, engine, externalConfig, saga, events, uiResets, walks, log }
}

function rows(db: SqliteDatabase, sql: string, params: readonly SqliteParam[] = []): object[] {
  return db.all(sql, params).map((row) => ({ ...row }))
}

function count(db: SqliteDatabase, table: string): number {
  return Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
}

function setting(db: SqliteDatabase, id: string): unknown {
  return db.all('SELECT state FROM integration_settings WHERE id = ?', [id])[0]?.['state'] ?? 'off'
}

async function read(m: Machine, path: string): Promise<string | null> {
  const bytes = await m.disk.readFile(path)
  return bytes.ok ? new TextDecoder().decode(bytes.value) : null
}

const resetOf = (epoch: number): MetricsResetResult => ({ outcome: 'reset', epoch })

describe('Reset metrics as the Host saga with every participant (ADR-023; 09 §7.2)', () => {
  it("[US-SET-010.AC05, INV-108, NFR-PERS-14, BR-06] after the reset every mine's ore, tier, name and record, every preference, both secrets and the UI layouts are at defaults and the result is reset with its epoch", async () => {
    const m = await machine()
    const h = host(m)
    const epochBefore = Number(h.db.all('SELECT reset_epoch FROM app_meta')[0]?.['reset_epoch'])

    const result = await h.saga.resetMetrics(YES)

    const epoch = epochBefore + 1
    expect(result).toStrictEqual(resetOf(epoch))
    expect(Number(h.db.all('SELECT reset_epoch FROM app_meta')[0]?.['reset_epoch'])).toBe(epoch)
    // Mines: only the one with a present dwarf stays, recreated fresh at its id (S3.24); the others
    // and their records are gone; no ore is left anywhere.
    expect(
      rows(h.db, 'SELECT id, state, tier, has_been_measured, source_weight_bytes FROM mines')
    ).toStrictEqual([
      {
        id: MINE.occupied,
        state: 'measuring',
        tier: null,
        has_been_measured: 0,
        source_weight_bytes: null
      }
    ])
    expect(h.walks).toStrictEqual(['abortAll', `walkDue ${MINE.occupied}`])
    expect(count(h.db, 'ledger_entries')).toBe(0)
    expect(count(h.db, 'usage_units')).toBe(0)
    // Names: the custom name of the dwarf that stays is cleared.
    expect(rows(h.db, 'SELECT id, custom_name FROM dwarfs')).toStrictEqual([
      { id: DWARF.live, custom_name: null }
    ])
    // Every preference at its default (09 §4.8 `host_preferences`).
    expect(
      rows(
        h.db,
        `SELECT subagent_delegation_on, routing_profile, default_provider, default_model,
           default_effort, system_notifications_on FROM host_preferences`
      )
    ).toStrictEqual([
      {
        subagent_delegation_on: 0,
        routing_profile: 'balanced',
        default_provider: null,
        default_model: null,
        default_effort: null,
        system_notifications_on: 1
      }
    ])
    // Both secrets cleared (ADR-017 item 7).
    expect(m.secrets.deleted).toStrictEqual(['jev-key', 'opencode-password'])
    expect(await m.secrets.get('jev-key')).toBeNull()
    expect(await m.secrets.get('opencode-password')).toBeNull()
    // The UI layouts: every attached UI was asked to reset its stores to this epoch (07 S13.04).
    expect(h.uiResets).toStrictEqual([epoch])
    expect(h.events).toStrictEqual(['MetricsResetStarted', 'MetricsResetFinished'])
  })

  it('[US-SET-010.AC06, ADR-023] the install moment is rewritten and the coal backfill credits exactly the usage older than it', async () => {
    const m = await machine()
    const h = host(m)
    m.clock.advance(5_000)
    const resetAt = m.clock.now()

    expect(await h.saga.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    expect(rows(h.db, 'SELECT at, reason FROM install_moment')).toStrictEqual([
      { at: resetAt, reason: 'reset' }
    ])
    expect(count(h.db, 'coal_backfill_units')).toBe(0)

    // The backfill as on a new install: history older than the new moment is coal, newer is not.
    const asked: number[] = []
    const scanner: HistoricalUsageScanner = {
      scan: async function* (before) {
        asked.push(before)
        await Promise.resolve()
        yield {
          kind: 'scanned' as const,
          scanUnit: 'claude:/history/occupied',
          adapterId: 'claude',
          records: [
            {
              unitKey: 'history-older' as never,
              span: 'unit' as const,
              mineId: MINE.occupied as MineId,
              tokens: 300,
              providerTime: (resetAt - 1) as Instant
            },
            {
              unitKey: 'history-newer' as never,
              span: 'unit' as const,
              mineId: MINE.occupied as MineId,
              tokens: 500,
              providerTime: (resetAt + 1) as Instant
            }
          ]
        }
      }
    }
    const ledger = createLedger({
      repository: new SqliteLedgerRepository({
        db: h.db,
        scope: h.transactions,
        ids: m.ids,
        clock: m.clock
      }),
      transactions: h.transactions,
      scope: h.transactions,
      bus: new InProcessEventBus({
        transactionScope: h.transactions,
        onHandlerError: () => undefined
      }),
      clock: m.clock,
      ids: m.ids,
      hostEpoch: EPOCH,
      scanner,
      log: new RecordingDiagnosticsLog()
    })

    const report = await ledger.commands.runCoalBackfill(new AbortController().signal)

    expect(asked).toStrictEqual([resetAt])
    expect(report).toMatchObject({ outcome: 'done', tokensCredited: 300 })
    expect(ledger.queries.totals(MINE.occupied as MineId).coal).toStrictEqual({ tokens: 300 })
  })

  it('[US-SET-010.AC07, S13.03, INV-112] the OpenCode toggle reads off and the plugin file is gone', async () => {
    const m = await machine()
    const h = host(m)
    expect(await read(m, PLUGIN_FILE)).toContain(`const PUSH_TOKEN = '${PLUGIN_TOKEN}'`)
    expect(setting(h.db, 'opencode-permissions')).toBe('on-verified')
    expect(await read(m, CLAUDE_SETTINGS)).toContain('/hooks/claude/')
    expect(setting(h.db, 'claude-hooks')).toBe('on-verified')

    expect(await h.saga.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    // Both foreign-config reverts ran (16 §7.4): the plugin file and the Claude hook entry are gone,
    // both toggles read off, both rows reverted.
    expect(await read(m, PLUGIN_FILE)).toBeNull()
    expect(setting(h.db, 'opencode-permissions')).toBe('off')
    expect(await read(m, CLAUDE_SETTINGS)).not.toContain('/hooks/claude/')
    expect(setting(h.db, 'claude-hooks')).toBe('off')
    expect(
      rows(h.db, 'SELECT kind FROM config_writes WHERE reverted_at IS NULL ORDER BY kind')
    ).toStrictEqual([])
    expect(await h.externalConfig.verify('opencode-plugin')).toBe('absent')
  })

  it('[US-SET-010.AC08] every kept message is deleted, except a message still being handed over', async () => {
    const m = await machine()
    const h = host(m)

    expect(await h.saga.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    expect(rows(h.db, 'SELECT id, role FROM messages')).toStrictEqual([
      { id: MESSAGE.liveSending, role: 'person' }
    ])
    expect(rows(h.db, 'SELECT message_id, phase FROM deliveries')).toStrictEqual([
      { message_id: MESSAGE.liveSending, phase: 'sending' }
    ])
    // The live dwarf's message keys stay (09 §7.2), so a replay of its transcript from before the
    // reset point inserts nothing again; the departed dwarf's went with it.
    expect(rows(h.db, 'SELECT dwarf_id FROM message_keys')).toStrictEqual([
      { dwarf_id: DWARF.live }
    ])
  })

  it('[US-SET-010.AC09, INV-109] a live dwarf keeps its session and its chat starts empty from the reset point', async () => {
    const m = await machine()
    const h = host(m)

    expect(await h.saga.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    // The session is not ended: its dwarf, its provider session, its stream and cursor stay.
    expect(
      rows(h.db, 'SELECT id, provider_session_id, process_state, departed_at FROM dwarfs')
    ).toStrictEqual([
      {
        id: DWARF.live,
        provider_session_id: 'session-live',
        process_state: 'running',
        departed_at: null
      }
    ])
    expect(rows(h.db, 'SELECT stream_id, value FROM source_cursors')).toStrictEqual([
      { stream_id: `stream-${DWARF.live}`, value: 42 }
    ])
    // Its chat holds nothing from before the reset point but the message still being handed over.
    expect(
      rows(h.db, "SELECT id FROM messages WHERE dwarf_id = ? AND role = 'dwarf'", [DWARF.live])
    ).toStrictEqual([])
  })

  it('[US-SET-010.AC11, S41.07] the first-run step is due again after done with each installed tool offered and both integrations off', async () => {
    const m = await machine()
    const h = host(m)

    expect(await h.saga.resetMetrics(YES)).toMatchObject({ outcome: 'reset' })

    expect(rows(h.db, 'SELECT welcome_answered_at FROM app_meta')).toStrictEqual([
      { welcome_answered_at: null }
    ])
    // The next boot evaluates the step (07 S41.01) over the installed detection.
    const step = createWelcomeStep({
      db: h.db,
      bus: new InProcessEventBus<PreferencesEvent>({
        transactionScope: h.transactions,
        onHandlerError: () => undefined
      }),
      clock: m.clock,
      ids: m.ids,
      hostEpoch: EPOCH,
      installedTools: { installed: () => ['claude-hooks', 'opencode-permissions'] },
      externalConfig: h.externalConfig
    })
    const state = await step.evaluateWelcomeAtBoot()

    // Offered: every installed tool (ADR-016 item 5); from step 4a the Host writes both foreign
    // entries, so the per-cut offered filter is gone (21 §2 4a; ISSUE-232).
    expect(state).toStrictEqual({
      due: true,
      reason: 'first-run',
      legacyFound: [],
      offered: ['claude-hooks', 'opencode-permissions']
    })
    expect(setting(h.db, 'claude-hooks')).toBe('off')
    expect(setting(h.db, 'opencode-permissions')).toBe('off')
  })

  it('[FM-126, ADR-023] a plugin file edited by the person fails the step and the saga resumes at the next boot, with no success result', async () => {
    const m = await machine()
    const h = host(m)
    // The person edits DwarfAI's plugin file and keeps it open: the OS refuses its removal (16 §7.4
    // "a locked file": in the Reset saga the step fails and resumes at the next boot).
    const edited = `${await read(m, PLUGIN_FILE)}\n// a note the person added\n`
    m.disk.addFile(PLUGIN_FILE, edited)
    m.fs.lock(PLUGIN_FILE)

    const failed = await h.saga.resetMetrics(YES)

    expect(failed).toStrictEqual({
      outcome: 'failed',
      reason: 'config-revert-locked',
      resumesOnNextStart: true
    })
    expect(h.events).toStrictEqual(['MetricsResetStarted', 'MetricsResetFailed'])
    expect(h.uiResets).toStrictEqual([])
    expect(await read(m, PLUGIN_FILE)).toBe(edited)
    expect(rows(h.db, 'SELECT step, finished_at FROM reset_journal')).toStrictEqual([
      { step: 'secrets', finished_at: null }
    ])

    // The next Host boot, the file closed: the saga resumes from its journal and completes.
    m.fs.lock(PLUGIN_FILE, false)
    const next = host(m)
    const resumed = await next.saga.resumeOnBoot()

    expect(resumed).toMatchObject({ outcome: 'reset' })
    expect(next.events).toStrictEqual(['MetricsResetFinished'])
    expect(await read(m, PLUGIN_FILE)).toBeNull()
    expect(setting(next.db, 'opencode-permissions')).toBe('off')
    expect(rows(next.db, 'SELECT step FROM reset_journal')).toStrictEqual([{ step: 'done' }])
  })
})
