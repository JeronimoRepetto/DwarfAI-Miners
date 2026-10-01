import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../kernel/domain/errors'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteParam, SqliteRow } from '../../kernel/ports/sqliteDatabase'
import { initialMigration } from './migrations/0001-initial'
import { migrationsFor } from './migrations/index'
import { openHostDb, type OpenHostDbOptions, type OpenedHostDb } from './migrations/runner'
import { migrationChecksum, type Migration } from './migrations/types'
import {
  collapseWhitespace,
  constraintInventory,
  type SchemaConstraint
} from './testing/constraintInventory'
import { renderSchemaSnapshot, SCHEMA_QUERY } from './testing/schemaSnapshot'

// L5 (17 §1.5; 09 §6.5 "Schema snapshot", "FK index coverage", "STRICT coverage"): the structural
// contract of migration 1 over a real database file, one temp dir per test. The behavioural
// CHECK / UNIQUE / trigger / FK probes (ISSUE-036) follow in "schema contract probes".

const MIGRATION_SQL = readFileSync(
  new URL('./migrations/0001-initial.sql', import.meta.url),
  'utf8'
)
const SNAPSHOT = readFileSync(new URL('./schema.snapshot.sql', import.meta.url), 'utf8')

const MIGRATED_AT = 1_750_000_000_000
const DWARFAI_APPLICATION_ID = 1146569033

function count(pattern: RegExp): number {
  return MIGRATION_SQL.replace(/\r\n?/g, '\n').match(pattern)?.length ?? 0
}

function names(db: SqliteDatabase, sql: string): string[] {
  return db.all(sql).map((row) => String(row['name']))
}

function tables(db: SqliteDatabase): string[] {
  return names(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
}

function pragma(db: SqliteDatabase, name: string): unknown {
  const [row] = db.all(`PRAGMA ${name}`)
  return row === undefined ? undefined : Object.values(row)[0]
}

describe('migration 0001-initial: schema v1 (09 §4)', () => {
  let dir: string
  let path: string
  let clock: FakeClock
  const toClose: SqliteDatabase[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-schema-'))
    path = join(dir, 'dwarfai.db')
    clock = new FakeClock(MIGRATED_AT)
  })

  afterEach(async () => {
    for (const db of toClose.splice(0).reverse()) db.close()
    await rm(dir, { recursive: true, force: true })
  })

  function options(overrides: Partial<OpenHostDbOptions> = {}): OpenHostDbOptions {
    return {
      buildKind: 'test',
      releaseDataDir: join(dir, 'release-data'),
      appVersion: '0.0.0-test',
      clock,
      log: new RecordingDiagnosticsLog(),
      migrations: migrationsFor({ clock, ids: new SequenceIdGenerator() }),
      ...overrides
    }
  }

  /** Migrate the empty temp file; the opened connection is closed after the test. */
  function migrate(overrides: Partial<OpenHostDbOptions> = {}): OpenedHostDb {
    const result = openHostDb(path, options(overrides))
    if (!result.ok) throw new Error(`expected the open to succeed, got ${result.error}`)
    toClose.push(result.value.db)
    return result.value
  }

  it('[ADR-005, NFR-PERS-15] migrating an empty file produces exactly schema.snapshot.sql', () => {
    // The build's registered list (`migrations/index.ts`), as the Host opens its database.
    const { db } = migrate({ migrations: undefined })

    expect(renderSchemaSnapshot(db.all(SCHEMA_QUERY))).toBe(SNAPSHOT.replace(/\r\n?/g, '\n'))
  })

  it('[ADR-005] the schema has 37 tables, 55 explicit indexes and 6 triggers, the numbers counted from 0001-initial.sql', () => {
    const declared = {
      tables: count(/^CREATE TABLE /gm),
      indexes: count(/^CREATE (UNIQUE )?INDEX /gm),
      triggers: count(/^CREATE TRIGGER /gm)
    }
    const { db } = migrate()

    const built = {
      tables: tables(db).length,
      indexes: names(db, "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL")
        .length,
      triggers: names(db, "SELECT name FROM sqlite_schema WHERE type = 'trigger'").length
    }

    expect(declared).toEqual({ tables: 37, indexes: 55, triggers: 6 })
    expect(built).toEqual(declared)
  })

  it('[ADR-005] every table in sqlite_schema is STRICT', () => {
    const { db } = migrate()

    const listed = db.all(
      "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )

    expect(listed.map((entry) => entry['name'])).toEqual(tables(db))
    expect(listed).toHaveLength(37)
    expect(listed.filter((entry) => entry['strict'] !== 1)).toEqual([])
  })

  it('[ADR-005] every foreign key column leads an index', () => {
    const { db } = migrate()

    const foreignKeys = db.all(
      `SELECT t.name AS tbl, f."from" AS col
         FROM sqlite_schema t, pragma_foreign_key_list(t.name) f
        WHERE t.type = 'table'
        ORDER BY t.name, f."from"`
    )
    const uncovered = foreignKeys.filter(
      (fk) =>
        db.all(
          `SELECT 1 FROM pragma_index_list(?) l, pragma_index_info(l.name) i
            WHERE i.seqno = 0 AND i.name = ?`,
          [String(fk['tbl']), String(fk['col'])]
        ).length === 0
    )

    expect(foreignKeys).toHaveLength(count(/\bREFERENCES\b/g))
    expect(uncovered).toEqual([])
  })

  it('[ADR-005] application_id is 1146569033 after migration 1', () => {
    const { db } = migrate()

    expect(pragma(db, 'application_id')).toBe(DWARFAI_APPLICATION_ID)
    expect(DWARFAI_APPLICATION_ID).toBe(0x44574149)
  })

  it('[ADR-005] the seed rows exist: app_meta with install_id and reset_epoch 0, install_moment reason fresh-install at the migration clock, host_preferences defaults, integration_settings claude-hooks and opencode-permissions off', () => {
    const { db } = migrate()

    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'app_meta',
        'install_moment',
        'host_preferences',
        'integration_settings'
      ])
    )
    expect(db.all('SELECT * FROM app_meta')).toEqual([
      {
        id: 1,
        install_id: '00000000-0000-7000-8000-000000000001',
        reset_epoch: 0,
        current_host_epoch: null,
        host_epoch_started_at: null,
        host_boot_id: null,
        host_boot_time_ms: null,
        host_logon_session_id: null,
        clean_shutdown_epoch: null,
        clean_shutdown_at: null,
        clean_shutdown_reason: null,
        ingress_port: null,
        welcome_answered_at: null,
        created_at: MIGRATED_AT
      }
    ])
    expect(db.all('SELECT * FROM install_moment')).toEqual([
      {
        id: 1,
        at: MIGRATED_AT,
        reason: 'fresh-install',
        backfill_state: 'not-started',
        backfill_done_at: null
      }
    ])
    expect(db.all('SELECT * FROM host_preferences')).toEqual([
      {
        id: 1,
        subagent_delegation_on: 0,
        routing_profile: 'balanced',
        default_provider: null,
        default_model: null,
        default_effort: null,
        system_notifications_on: 1,
        updated_at: MIGRATED_AT
      }
    ])
    expect(db.all('SELECT * FROM integration_settings ORDER BY id')).toEqual([
      { id: 'claude-hooks', state: 'off', consent_origin: null, changed_at: MIGRATED_AT },
      { id: 'opencode-permissions', state: 'off', consent_origin: null, changed_at: MIGRATED_AT }
    ])
  })

  it('[ADR-005] a seed row that fails rolls back the whole schema: the DDL and the seed rows share one transaction', () => {
    const invalidIds: IdGenerator = { uuidv7: () => 'not-a-uuid' }

    expect(() => migrate({ migrations: migrationsFor({ clock, ids: invalidIds }) })).toThrow(
      /CHECK constraint failed/
    )

    const { db } = migrate({ migrations: [] })
    expect(tables(db)).toEqual([])
    expect(pragma(db, 'application_id')).toBe(0)
  })

  it('[ADR-005] the six named triggers exist: source_cursors_never_regress, deliveries_match_message, deliveries_match_message_update, ledger_entries_accumulate, ledger_entries_withdraw, ledger_entries_immutable', () => {
    const { db } = migrate()

    expect(
      names(db, "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
    ).toEqual([
      'deliveries_match_message',
      'deliveries_match_message_update',
      'ledger_entries_accumulate',
      'ledger_entries_immutable',
      'ledger_entries_withdraw',
      'source_cursors_never_regress'
    ])
  })

  it('[ADR-005] foreign_key_check and integrity_check are clean after migration 1', () => {
    const opened = migrate()

    expect(opened).toMatchObject({ readOnly: false, version: 1, applied: [1] })
    expect(opened.db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(opened.db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('[ADR-005] the checksum of 0001-initial is stable across a CRLF checkout', () => {
    const lf = MIGRATION_SQL.replace(/\r\n?/g, '\n')
    const migration: Migration = initialMigration({ clock, ids: new SequenceIdGenerator() })

    expect(migration).toMatchObject({ version: 1, name: '0001-initial' })
    expect(migration.sql.replace(/\r\n?/g, '\n')).toBe(lf)
    expect(migration.checksum).toBe(migrationChecksum(lf))
    expect(migration.checksum).toBe(migrationChecksum(lf.replace(/\n/g, '\r\n')))
  })
})

// ---------------------------------------------------------------------------------------------
// Schema contract probes (ISSUE-036; 17 §1.5 "DDL probes become the schema contract suite";
// 09 §12 probe list; 09 §6.5 "Invariant triggers"). The probes run against the migration code
// over a real file opened by `openHostDb`, so the 09 §8.1 pragmas (`foreign_keys = ON`) are on.
//
// - `T(tag, action)`: the action must store.
// - `R(tag, action)`: the action must be rejected with the tagged constraint's own error
//   (`constraintInventory` gives it), so a probe never passes on a neighbouring constraint.
// - The tag is a string literal naming one constraint of `constraintInventory`;
//   `schema.coverage.test.ts` reads the literals and fails on a constraint without both kinds.
// - Every test runs inside one transaction rolled back after it (17 §5.3: no order dependency),
//   over a small base fixture inserted at its start.

type Row = Record<string, SqliteParam>

interface Statement {
  readonly sql: string
  readonly params: readonly SqliteParam[]
}

type Action = Statement | string | (() => void)

const fixedId = (n: number): string => `aaaaaaaa-0000-7000-8000-${String(n).padStart(12, '0')}`
const uuidOf = (n: number): string => `bbbbbbbb-0000-7000-8000-${String(n).padStart(12, '0')}`
const hex64 = (n: number): string => n.toString(16).padStart(64, '0')

// The base fixture, inserted at the start of every probe.
const MINE = fixedId(1)
const DWARF = fixedId(2)
const DWARF2 = fixedId(3)
const MESSAGE = fixedId(4)
const ANSWERS_MESSAGE = fixedId(5)
const ASK = fixedId(6)
const LAUNCH = fixedId(7)
const CURSOR = 'stream-base'
const REPORT = 'epoch-report'
const USAGE_UNIT = 'usage-base'
/** A well-formed id no row ever carries: an orphan reference. */
const GHOST = fixedId(999)
/** One character short of a UUID: every `CHECK (length(id) = 36)` rejects it. */
const ID_35 = fixedId(8).slice(1)

/** A valid row of each table; `n` makes its ids and UNIQUE values fresh. */
const DEFAULTS: Readonly<Record<string, (n: number) => Row>> = {
  activity_disclosures: (n) => ({
    id: uuidOf(n),
    dwarf_id: DWARF,
    turn_key: `turn-${n}`,
    open: 0,
    step_count: 0,
    summaries_json: '[]',
    opened_at: 1,
    closed_at: 2
  }),
  app_meta: (n) => ({ id: 1, install_id: uuidOf(n), reset_epoch: 0, created_at: 1 }),
  ask_answers: (n) => ({
    request_id: `answer-${n}`,
    ask_id: ASK,
    outcome: null,
    refusal_reason: null,
    message_id: null,
    at: 1,
    settled_at: null
  }),
  asks: (n) => ({
    id: uuidOf(n),
    dwarf_id: DWARF,
    kind: 'question',
    channel: 'driver',
    provider_request_id: `request-${n}`,
    payload_json: '{}',
    current_step: 0,
    state: 'open',
    reannounce: 1,
    opened_at: 1,
    closed_at: null
  }),
  attention_announced: () => ({
    dwarf_id: DWARF,
    kind: 'question',
    pre_crash_key: 'key-before-crash',
    host_epoch: 'epoch-1',
    recorded_at: 1
  }),
  attention_keys: (n) => ({
    key: `attention-${n}`,
    dwarf_id: DWARF,
    kind: 'turn-finished',
    ask_id: null,
    host_epoch: 'epoch-1',
    emitted_at: 1,
    suppressed: 0,
    withdrawn_at: null
  }),
  capability_records: (n) => ({
    id: uuidOf(n),
    provider_id: 'provider-a',
    provider_version: `1.0.${n}`,
    capabilities_json: '{}',
    measured_at: 1
  }),
  channel_tokens: (n) => ({
    id: uuidOf(n),
    channel: 'claude-hooks',
    token_sha256: hex64(n),
    created_at: 1,
    revoked_at: null
  }),
  coal_backfill_units: (n) => ({
    scan_unit: `scan-${n}`,
    install_moment_id: 1,
    adapter_id: 'adapter-a',
    tokens_credited: 0,
    credited_at: 1
  }),
  config_writes: (n) => ({
    id: uuidOf(n),
    target_path: `/config/settings-${n}.json`,
    kind: 'claude-hooks',
    owned_marker: 'dwarfai',
    backup_path: null,
    consent_origin: 'settings',
    written_at: 1,
    verified_at: null,
    reverted_at: null
  }),
  delegation_tokens: () => ({
    launch_id: LAUNCH,
    parent_dwarf_id: DWARF,
    mechanism: 'in-process',
    credential_hash: null,
    issued_at: 1,
    revoked_at: null
  }),
  delegations: (n) => ({
    id: uuidOf(n),
    parent_dwarf_id: DWARF,
    worker_dwarf_id: null,
    ticket: `ticket-${n}`,
    task_text: null,
    context_text: null,
    state: 'attempted',
    failure: null,
    handoff_via: null,
    handoff_phase: null,
    handoff_phase_at: null,
    created_at: 1,
    settled_at: null
  }),
  deliveries: () => ({
    message_id: MESSAGE,
    dwarf_id: DWARF,
    kind: 'message',
    phase: 'sending',
    confidence: null,
    held_until_turn_end: 0,
    failure_kind: null,
    failure_reason: null,
    attempts: 1,
    sent_at: 1,
    phase_at: 1
  }),
  dwarf_lifecycle_facts: (n) => ({
    id: uuidOf(n),
    dwarf_id: DWARF,
    type: 'DwarfArrived',
    source_key: null,
    cause: null,
    exit_code: null,
    occurred_at: 1,
    recorded_at: 1
  }),
  dwarfs: (n) => ({
    id: uuidOf(n),
    mine_id: MINE,
    provider_id: 'provider-a',
    provider_session_id: `session-${n}`,
    provider_agent_id: '',
    base_name: 'Borin',
    custom_name: null,
    rank: 'foreman',
    parent_dwarf_id: null,
    delegated: 0,
    process_state: 'running',
    presence: 'present',
    turn_state: 'none-yet',
    turn_ended_at: null,
    turn_end_reliability: null,
    arrived_at: 1,
    last_activity_at: 1,
    workplace_path: null,
    workplace_branch: null,
    stop_in_flight: 0,
    departed_at: null,
    departure_cause: null,
    usage_path: 'transcript'
  }),
  host_preferences: () => ({ id: 1, updated_at: 1 }),
  host_recovery_items: () => ({
    host_epoch: REPORT,
    dwarf_id: DWARF,
    reason: 'turn-lost',
    message_ids_json: null,
    retry_outcome: null
  }),
  host_recovery_reports: (n) => ({
    host_epoch: `epoch-${n}`,
    at: 1,
    resumed_json: '[]',
    state: 'pending-display',
    shown_at: null,
    settled_at: null
  }),
  install_moment: () => ({
    id: 1,
    at: 1,
    reason: 'reset',
    backfill_state: 'not-started',
    backfill_done_at: null
  }),
  integration_settings: () => ({
    id: 'claude-hooks',
    state: 'off',
    consent_origin: null,
    changed_at: 1
  }),
  launch_records: () => ({
    dwarf_id: DWARF,
    launch_id: LAUNCH,
    driver_transport: 'acp',
    session_ref_json: '{}',
    cwd: '/mines/base',
    process_id: null,
    resume_intent: 1,
    stopped_by_person: 0,
    host_epoch: 'epoch-1',
    ended_at: null
  }),
  launches: (n) => ({
    id: uuidOf(n),
    mine_id: MINE,
    cwd: '/mines/base',
    way_kind: 'supplier',
    provider_id: 'provider-a',
    custom_command_json: null,
    launched_with_let_jev_choose: 0,
    jev_auto_accept: 0,
    state: 'routing',
    failure_cause: null,
    jev_reason: null,
    dwarf_id: null,
    retry_of: null,
    delegation_id: null,
    delegated: 0,
    host_epoch: 'epoch-1',
    requested_at: 1,
    spawned_at: null,
    settled_at: null,
    seen_at: null
  }),
  ledger_entries: (n) => ({
    id: uuidOf(n),
    unit_key: `ledger-${n}`,
    mine_id: MINE,
    material: 'bronze',
    tokens: 10,
    units: 1,
    kind: 'live',
    source_key: null,
    credited_at: 1
  }),
  material_totals: () => ({ mine_id: MINE, material: 'silver', tokens: 0, units: 0 }),
  message_keys: (n) => ({
    source_key: `key-${n}`,
    dwarf_id: DWARF,
    message_id: null,
    first_seen_at: 1
  }),
  messages: (n) => ({
    id: uuidOf(n),
    dwarf_id: DWARF,
    source_key: null,
    role: 'person',
    text: 'hello',
    issuer_dwarf_id: null,
    activity_json: null,
    attachments_json: '[]',
    origin: 'dwarfai',
    pending_echo: null,
    provider_time: null,
    created_at: 1,
    ask_id: null,
    request_id: null
  }),
  mines: (n) => ({
    id: uuidOf(n),
    canonical_path: `/mines/m${n}`,
    name: `Mine ${n}`,
    name_norm: `mine ${n}`,
    state: 'active',
    tier: null,
    source_weight_bytes: null,
    has_been_measured: 0,
    measured_at: null,
    unenterable_reason: null,
    removed_at: null,
    created_at: 1,
    last_used_at: 1,
    map_site_x_pct: null,
    map_site_y_pct: null
  }),
  observed_session_streams: () => ({ dwarf_id: DWARF, stream_id: CURSOR }),
  observed_sessions: () => ({
    dwarf_id: DWARF2,
    cwd: '/mines/base',
    first_seen_at: 1,
    last_record_at: 1,
    closed_at: null
  }),
  outcome_lines: () => ({
    dwarf_id: DWARF,
    kind: 'finished',
    step_count: 0,
    parts_json: '[]',
    detail: null,
    closing_words: null,
    reliability: 'reliable',
    at: 1
  }),
  processes: (n) => ({
    id: uuidOf(n),
    pid: 1000 + n,
    process_start_time_ms: 1,
    boot_id: '',
    purpose: 'session',
    launch_id: null,
    host_epoch: 'epoch-1',
    recorded_at: 1
  }),
  reset_journal: (n) => ({
    id: uuidOf(n),
    epoch: n,
    step: 'done',
    started_at: 1,
    step_at: 1,
    finished_at: 2,
    last_failure: null
  }),
  schema_migrations: (n) => ({
    version: 100 + n,
    name: `${100 + n}-probe`,
    checksum: hex64(n),
    applied_at: 1,
    app_version: '0.0.0-test'
  }),
  source_cursors: (n) => ({
    stream_id: `stream-${n}`,
    adapter_id: 'adapter-a',
    kind: 'byte-offset',
    value: 0,
    file_identity: null,
    missing_since: null,
    updated_at: 1
  }),
  usage_observations: (n) => ({
    source_key: `observation-${n}`,
    unit_key: USAGE_UNIT,
    path: 'driver',
    fidelity: 2,
    input_net: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    sealed: 0,
    provider_time: null,
    observed_at: 1
  }),
  usage_units: (n) => ({
    unit_key: `usage-${n}`,
    dwarf_id: DWARF,
    mine_id: MINE,
    sealed: 0,
    provider_time: null,
    first_observed_at: 1,
    sealed_at: null
  })
}

let probeDb: SqliteDatabase
let constraints: ReadonlyMap<string, SchemaConstraint>
let sequence = 0

const next = (): number => ++sequence
/** A fresh id for a row a probe needs to reference. */
const newId = (): string => uuidOf(next())

function insert(table: string, overrides: Row = {}): Statement {
  const defaults = DEFAULTS[table]
  if (defaults === undefined) throw new Error(`no default row for ${table}`)
  const row: Row = { ...defaults(next()), ...overrides }
  const columns = Object.keys(row)
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: columns.map((column) => row[column] ?? null)
  }
}

/** One INSERT of several rows: SQLite applies it, its triggers included, all or nothing. */
function insertRows(table: string, rows: readonly Row[]): Statement {
  const statements = rows.map((row) => insert(table, row))
  const first = statements[0]
  if (first === undefined) throw new Error('insertRows needs at least one row')
  const values = first.sql.slice(first.sql.indexOf(' VALUES ') + ' VALUES '.length)
  return {
    sql: `${first.sql.slice(0, first.sql.indexOf(' VALUES '))} VALUES ${statements.map(() => values).join(', ')}`,
    params: statements.flatMap((statement) => statement.params)
  }
}

function where(row: Row): { clause: string; params: SqliteParam[] } {
  const columns = Object.keys(row)
  return {
    clause: columns.map((column) => `${column} = ?`).join(' AND '),
    params: columns.map((column) => row[column] ?? null)
  }
}

function update(table: string, set: Row, match: Row): Statement {
  const columns = Object.keys(set)
  const filter = where(match)
  return {
    sql: `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${filter.clause}`,
    params: [...columns.map((column) => set[column] ?? null), ...filter.params]
  }
}

function remove(table: string, match: Row): Statement {
  const filter = where(match)
  return { sql: `DELETE FROM ${table} WHERE ${filter.clause}`, params: filter.params }
}

function rows(sql: string, params: readonly SqliteParam[] = []): SqliteRow[] {
  return probeDb.all(sql, params)
}

function value(sql: string, params: readonly SqliteParam[] = []): unknown {
  const [row] = rows(sql, params)
  return row === undefined ? undefined : Object.values(row)[0]
}

function perform(action: Action): void {
  if (typeof action === 'function') action()
  else if (typeof action === 'string') probeDb.exec(action)
  else probeDb.run(action.sql, action.params)
}

/** Fixture setup a probe builds on; it must store. */
function put(...actions: Action[]): void {
  for (const action of actions) perform(action)
}

function constraintOf(tag: string): SchemaConstraint {
  const constraint = constraints.get(tag)
  if (constraint === undefined)
    throw new Error(`no constraint of the migrated schema is tagged "${tag}"`)
  return constraint
}

/** A stores probe: `action` must commit its rows. */
function T(tag: string, action: Action): void {
  constraintOf(tag)
  try {
    perform(action)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`[stores] ${tag}: expected the action to store, it failed with: ${reason}`, {
      cause: error
    })
  }
}

/**
 * A rejected probe: `action` must fail with the tagged constraint's error. A trigger without a
 * `RAISE` has no error of its own; its probe names the error the rejected statement meets.
 */
function R(tag: string, action: Action, rejection?: string): void {
  const constraint = constraintOf(tag)
  const expected = rejection ?? constraint.rejection
  if (expected === null) throw new Error(`${tag} raises no error itself: name the expected one`)
  let failure: unknown = null
  try {
    perform(action)
  } catch (error) {
    failure = error
  }
  if (!(failure instanceof SqliteInfrastructureError)) {
    throw new Error(
      failure === null
        ? `[rejected] ${tag}: expected the action to be rejected, it stored`
        : `[rejected] ${tag}: expected a SQLite constraint error, got ${String(failure)}`,
      { cause: failure }
    )
  }
  expect({ tag, code: failure.code, message: collapseWhitespace(failure.message) }).toEqual({
    tag,
    code: 'SQLITE_CONSTRAINT',
    message: expected
  })
}

describe('schema contract probes (17 §1.5, 09 §12)', () => {
  let probeDir: string

  beforeAll(async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'dwarfai-probes-'))
    const clock = new FakeClock(MIGRATED_AT)
    const opened = openHostDb(join(probeDir, 'dwarfai.db'), {
      buildKind: 'test',
      releaseDataDir: join(probeDir, 'release-data'),
      appVersion: '0.0.0-test',
      clock,
      migrations: migrationsFor({ clock, ids: new SequenceIdGenerator() }),
      log: new RecordingDiagnosticsLog()
    })
    if (!opened.ok) throw new Error(`expected the open to succeed, got ${opened.error}`)
    probeDb = opened.value.db
    constraints = new Map(constraintInventory(probeDb).map((entry) => [entry.tag, entry]))
  })

  afterAll(async () => {
    probeDb.close()
    await rm(probeDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    sequence = 0
    probeDb.exec('BEGIN')
    put(
      insert('mines', { id: MINE, canonical_path: '/mines/base' }),
      insert('dwarfs', { id: DWARF }),
      insert('dwarfs', { id: DWARF2 }),
      insert('messages', { id: MESSAGE }),
      insert('asks', { id: ASK }),
      insert('messages', { id: ANSWERS_MESSAGE, role: 'answers-record' }),
      insert('launches', { id: LAUNCH }),
      insert('source_cursors', { stream_id: CURSOR, value: 10 }),
      insert('observed_sessions', { dwarf_id: DWARF }),
      insert('host_recovery_reports', { host_epoch: REPORT }),
      insert('usage_units', { unit_key: USAGE_UNIT })
    )
  })

  afterEach(() => {
    probeDb.exec('ROLLBACK')
  })

  it('[ADR-005] the connection the probes use enforces foreign keys (09 §8.1)', () => {
    expect(value('PRAGMA foreign_keys')).toBe(1)
  })

  describe('09 §4.1 meta, migrations, install moment, reset journal', () => {
    it('[ADR-005] schema_migrations: a version from 1 with a 64-character checksum and a new name stores; version 0, a short checksum and a repeated name are rejected', () => {
      T('schema_migrations.version CHECK', insert('schema_migrations', { version: 2 }))
      R('schema_migrations.version CHECK', insert('schema_migrations', { version: 0 }))
      T('schema_migrations.checksum CHECK', insert('schema_migrations', { checksum: hex64(7) }))
      R('schema_migrations.checksum CHECK', insert('schema_migrations', { checksum: 'abc' }))
      T('schema_migrations UNIQUE (name)', insert('schema_migrations', { name: '0002-probe' }))
      R('schema_migrations UNIQUE (name)', insert('schema_migrations', { name: '0001-initial' }))
    })

    it('[ADR-005] app_meta: the single row keeps id 1, a 36-character install id and a non-negative reset epoch, ingress port and welcome instant', () => {
      T('app_meta.id CHECK', update('app_meta', { id: 1 }, { id: 1 }))
      R('app_meta.id CHECK', insert('app_meta', { id: 2 }))
      T('app_meta.install_id CHECK', update('app_meta', { install_id: newId() }, { id: 1 }))
      R('app_meta.install_id CHECK', update('app_meta', { install_id: ID_35 }, { id: 1 }))
      T(
        'app_meta.reset_epoch CHECK',
        'UPDATE app_meta SET reset_epoch = reset_epoch + 1, welcome_answered_at = NULL'
      )
      R('app_meta.reset_epoch CHECK', update('app_meta', { reset_epoch: -1 }, { id: 1 }))
      for (const port of [1024, 65535]) {
        T('app_meta.ingress_port CHECK', update('app_meta', { ingress_port: port }, { id: 1 }))
      }
      for (const port of [1023, 65536]) {
        R('app_meta.ingress_port CHECK', update('app_meta', { ingress_port: port }, { id: 1 }))
      }
      T(
        'app_meta.welcome_answered_at CHECK',
        update('app_meta', { welcome_answered_at: 5 }, { id: 1 })
      )
      R(
        'app_meta.welcome_answered_at CHECK',
        update('app_meta', { welcome_answered_at: -1 }, { id: 1 })
      )
    })

    it('[ADR-005] app_meta: an epoch with its start instant stores; an epoch without a start instant is rejected', () => {
      const epoch = { current_host_epoch: 'epoch-2', host_epoch_started_at: 7 }
      T(
        'app_meta CHECK ((current_host_epoch IS NULL) = (host_epoch_started_at IS NULL))',
        update('app_meta', epoch, { id: 1 })
      )
      R(
        'app_meta CHECK ((current_host_epoch IS NULL) = (host_epoch_started_at IS NULL))',
        update(
          'app_meta',
          { current_host_epoch: 'epoch-3', host_epoch_started_at: null },
          { id: 1 }
        )
      )
      R(
        'app_meta CHECK ((current_host_epoch IS NULL) = (host_epoch_started_at IS NULL))',
        update('app_meta', { current_host_epoch: null, host_epoch_started_at: 8 }, { id: 1 })
      )
    })

    it('[ADR-005] app_meta: a full or an all-NULL boot identity stores with an epoch; a boot identity without an epoch and a negative boot time are rejected', () => {
      const boot = {
        host_boot_id: 'boot-1',
        host_boot_time_ms: 0,
        host_logon_session_id: 'logon-1'
      }
      T(
        'app_meta CHECK (current_host_epoch IS NOT NULL OR (host_boot_id IS NULL AND host_boot_time_ms IS NULL AND host_logon_session_id IS NULL))',
        update(
          'app_meta',
          { current_host_epoch: 'epoch-2', host_epoch_started_at: 7, ...boot },
          { id: 1 }
        )
      )
      T(
        'app_meta CHECK (current_host_epoch IS NOT NULL OR (host_boot_id IS NULL AND host_boot_time_ms IS NULL AND host_logon_session_id IS NULL))',
        update(
          'app_meta',
          { host_boot_id: null, host_boot_time_ms: null, host_logon_session_id: null },
          { id: 1 }
        )
      )
      R(
        'app_meta CHECK (current_host_epoch IS NOT NULL OR (host_boot_id IS NULL AND host_boot_time_ms IS NULL AND host_logon_session_id IS NULL))',
        update(
          'app_meta',
          { current_host_epoch: null, host_epoch_started_at: null, host_boot_id: 'boot-2' },
          { id: 1 }
        )
      )
      T(
        'app_meta.host_boot_time_ms CHECK',
        update('app_meta', { host_boot_time_ms: 12 }, { id: 1 })
      )
      R(
        'app_meta.host_boot_time_ms CHECK',
        update('app_meta', { host_boot_time_ms: -1 }, { id: 1 })
      )
    })

    it('[ADR-005] app_meta: each clean-shutdown reason stop-all, upgrade, os-session-end stores; idle and upgrade-drain are rejected; a marker without a reason is rejected', () => {
      const marker = { clean_shutdown_epoch: 'epoch-1', clean_shutdown_at: 9 }
      for (const reason of ['stop-all', 'upgrade', 'os-session-end']) {
        T(
          'app_meta.clean_shutdown_reason CHECK',
          update('app_meta', { ...marker, clean_shutdown_reason: reason }, { id: 1 })
        )
      }
      for (const reason of ['idle', 'upgrade-drain']) {
        R(
          'app_meta.clean_shutdown_reason CHECK',
          update('app_meta', { ...marker, clean_shutdown_reason: reason }, { id: 1 })
        )
      }
      T(
        'app_meta CHECK ((clean_shutdown_epoch IS NULL) = (clean_shutdown_reason IS NULL))',
        update(
          'app_meta',
          { clean_shutdown_epoch: null, clean_shutdown_at: null, clean_shutdown_reason: null },
          { id: 1 }
        )
      )
      R(
        'app_meta CHECK ((clean_shutdown_epoch IS NULL) = (clean_shutdown_reason IS NULL))',
        update('app_meta', { ...marker, clean_shutdown_reason: null }, { id: 1 })
      )
      R(
        'app_meta CHECK ((clean_shutdown_epoch IS NULL) = (clean_shutdown_reason IS NULL))',
        update('app_meta', { clean_shutdown_reason: 'stop-all' }, { id: 1 })
      )
      T(
        'app_meta CHECK ((clean_shutdown_epoch IS NULL) = (clean_shutdown_at IS NULL))',
        update('app_meta', { ...marker, clean_shutdown_reason: 'stop-all' }, { id: 1 })
      )
      R(
        'app_meta CHECK ((clean_shutdown_epoch IS NULL) = (clean_shutdown_at IS NULL))',
        update('app_meta', { clean_shutdown_at: null }, { id: 1 })
      )
    })

    it('[ADR-005] install_moment: the single row keeps id 1; each reason and backfill state stores; pending and a done backfill without its instant are rejected', () => {
      T('install_moment.id CHECK', update('install_moment', { id: 1 }, { id: 1 }))
      R('install_moment.id CHECK', insert('install_moment', { id: 2 }))
      for (const reason of ['fresh-install', 'reset']) {
        T('install_moment.reason CHECK', update('install_moment', { reason }, { id: 1 }))
      }
      R('install_moment.reason CHECK', update('install_moment', { reason: 'upgrade' }, { id: 1 }))
      for (const state of ['not-started', 'running', 'paused']) {
        T(
          'install_moment.backfill_state CHECK',
          update('install_moment', { backfill_state: state }, { id: 1 })
        )
      }
      R(
        'install_moment.backfill_state CHECK',
        update('install_moment', { backfill_state: 'pending' }, { id: 1 })
      )
      T(
        "install_moment CHECK ((backfill_state = 'done') = (backfill_done_at IS NOT NULL))",
        update('install_moment', { backfill_state: 'done', backfill_done_at: 3 }, { id: 1 })
      )
      R(
        "install_moment CHECK ((backfill_state = 'done') = (backfill_done_at IS NOT NULL))",
        update('install_moment', { backfill_done_at: null }, { id: 1 })
      )
      R(
        "install_moment CHECK ((backfill_state = 'done') = (backfill_done_at IS NOT NULL))",
        update('install_moment', { backfill_state: 'running' }, { id: 1 })
      )
    })

    it('[ADR-005] coal_backfill_units: a unit of the install moment stores and goes with it; negative tokens and another moment are rejected', () => {
      T(
        'coal_backfill_units.tokens_credited CHECK',
        insert('coal_backfill_units', { tokens_credited: 5 })
      )
      R(
        'coal_backfill_units.tokens_credited CHECK',
        insert('coal_backfill_units', { tokens_credited: -1 })
      )
      R(
        'fk coal_backfill_units.install_moment_id → install_moment',
        insert('coal_backfill_units', { install_moment_id: 2 })
      )
      T(
        'fk coal_backfill_units.install_moment_id → install_moment',
        remove('install_moment', { id: 1 })
      )
      expect(value('SELECT count(*) FROM coal_backfill_units')).toBe(0)
    })

    it('[ADR-023] reset_journal: a second unfinished saga is rejected', () => {
      T(
        'index reset_journal_one_active',
        insert('reset_journal', { epoch: 1, step: 'begun', finished_at: null })
      )
      T('index reset_journal_one_active', insert('reset_journal', { epoch: 2 }))
      R(
        'index reset_journal_one_active',
        insert('reset_journal', { epoch: 3, step: 'db', finished_at: null })
      )
    })

    it('[ADR-023] reset_journal: each step stores in order; an unknown step, epoch 0, a repeated epoch, a done step without its instant and a short id are rejected', () => {
      const id = newId()
      T(
        'reset_journal.step CHECK',
        insert('reset_journal', { id, epoch: 1, step: 'begun', finished_at: null })
      )
      for (const step of ['db', 'secrets', 'external-config', 'ui-prefs', 'install-moment']) {
        T('reset_journal.step CHECK', update('reset_journal', { step }, { id }))
      }
      R('reset_journal.step CHECK', update('reset_journal', { step: 'vacuum' }, { id }))
      T(
        "reset_journal CHECK ((step = 'done') = (finished_at IS NOT NULL))",
        update('reset_journal', { step: 'done', finished_at: 5 }, { id })
      )
      R(
        "reset_journal CHECK ((step = 'done') = (finished_at IS NOT NULL))",
        update('reset_journal', { finished_at: null }, { id })
      )
      R(
        "reset_journal CHECK ((step = 'done') = (finished_at IS NOT NULL))",
        insert('reset_journal', { step: 'begun' })
      )
      T('reset_journal.epoch CHECK', insert('reset_journal', { epoch: 2 }))
      R('reset_journal.epoch CHECK', insert('reset_journal', { epoch: 0 }))
      T('reset_journal UNIQUE (epoch)', insert('reset_journal', { epoch: 3 }))
      R('reset_journal UNIQUE (epoch)', insert('reset_journal', { epoch: 1 }))
      T('reset_journal.id CHECK', insert('reset_journal', { id: newId() }))
      R('reset_journal.id CHECK', insert('reset_journal', { id: ID_35 }))
    })
  })

  describe('09 §4.2 mines, crew and observation', () => {
    it('[ADR-005] mines: a mine with a 36-character id, a path and a name stores; a short id, an empty path or name and a repeated path are rejected', () => {
      T('mines.id CHECK', insert('mines', { id: newId() }))
      R('mines.id CHECK', insert('mines', { id: ID_35 }))
      T('mines.canonical_path CHECK', insert('mines', { canonical_path: '/mines/other' }))
      R('mines.canonical_path CHECK', insert('mines', { canonical_path: '' }))
      T('mines.name CHECK', insert('mines', { name: 'Deep' }))
      R('mines.name CHECK', insert('mines', { name: '' }))
      T('mines UNIQUE (canonical_path)', insert('mines', { canonical_path: '/mines/second' }))
      R('mines UNIQUE (canonical_path)', insert('mines', { canonical_path: '/mines/base' }))
    })

    it('[ADR-005] mines: each state stores with its own fields; an unknown state, a removed mine without its instant and an unenterable mine without its reason are rejected', () => {
      for (const state of ['unrecorded', 'measuring', 'active']) {
        T('mines.state CHECK', insert('mines', { state }))
      }
      R('mines.state CHECK', insert('mines', { state: 'gone' }))
      T(
        "mines CHECK ((state = 'removed') = (removed_at IS NOT NULL))",
        insert('mines', { state: 'removed', removed_at: 4 })
      )
      R(
        "mines CHECK ((state = 'removed') = (removed_at IS NOT NULL))",
        insert('mines', { state: 'removed' })
      )
      R(
        "mines CHECK ((state = 'removed') = (removed_at IS NOT NULL))",
        insert('mines', { removed_at: 4 })
      )
      T(
        "mines CHECK ((state = 'unenterable') = (unenterable_reason IS NOT NULL))",
        insert('mines', { state: 'unenterable', unenterable_reason: 'access-denied' })
      )
      R(
        "mines CHECK ((state = 'unenterable') = (unenterable_reason IS NOT NULL))",
        insert('mines', { state: 'unenterable' })
      )
      R(
        "mines CHECK ((state = 'unenterable') = (unenterable_reason IS NOT NULL))",
        insert('mines', { unenterable_reason: 'access-denied' })
      )
    })

    it('[ADR-005] mines: a measured mine stores each tier and a weight; a tier before measuring, an unmeasured instant, coal as a tier, a negative weight and a flag outside 0/1 are rejected', () => {
      const measured = { has_been_measured: 1, measured_at: 3 }
      for (const tier of ['bronze', 'copper', 'silver', 'gold', 'uranium']) {
        T('mines.tier CHECK', insert('mines', { ...measured, tier }))
      }
      R('mines.tier CHECK', insert('mines', { ...measured, tier: 'coal' }))
      T(
        'mines CHECK (tier IS NULL OR has_been_measured = 1)',
        insert('mines', { ...measured, tier: 'gold' })
      )
      R('mines CHECK (tier IS NULL OR has_been_measured = 1)', insert('mines', { tier: 'gold' }))
      T(
        'mines CHECK ((has_been_measured = 1) = (measured_at IS NOT NULL))',
        insert('mines', measured)
      )
      R(
        'mines CHECK ((has_been_measured = 1) = (measured_at IS NOT NULL))',
        insert('mines', { has_been_measured: 1 })
      )
      T('mines.has_been_measured CHECK', insert('mines', measured))
      R('mines.has_been_measured CHECK', insert('mines', { has_been_measured: 2 }))
      T('mines.source_weight_bytes CHECK', insert('mines', { source_weight_bytes: 0 }))
      R('mines.source_weight_bytes CHECK', insert('mines', { source_weight_bytes: -1 }))
    })

    it('[ADR-005] mines: a map site from 0 to 100 on both axes stores; a coordinate past 100 or one axis alone is rejected', () => {
      T('mines.map_site_x_pct CHECK', insert('mines', { map_site_x_pct: 0, map_site_y_pct: 50 }))
      R(
        'mines.map_site_x_pct CHECK',
        insert('mines', { map_site_x_pct: 100.5, map_site_y_pct: 50 })
      )
      T('mines.map_site_y_pct CHECK', insert('mines', { map_site_x_pct: 50, map_site_y_pct: 100 }))
      R('mines.map_site_y_pct CHECK', insert('mines', { map_site_x_pct: 50, map_site_y_pct: -0.5 }))
      T(
        'mines CHECK ((map_site_x_pct IS NULL) = (map_site_y_pct IS NULL))',
        insert('mines', { map_site_x_pct: 10, map_site_y_pct: 20 })
      )
      R(
        'mines CHECK ((map_site_x_pct IS NULL) = (map_site_y_pct IS NULL))',
        insert('mines', { map_site_x_pct: 10 })
      )
    })

    it('[ADR-005, ADR-015] dwarfs: a dwarf with a 36-character id, a provider, a session and a base name stores; a short id or an empty provider, session or base name is rejected; one provider session and agent maps to one dwarf', () => {
      T('dwarfs.id CHECK', insert('dwarfs', { id: newId() }))
      R('dwarfs.id CHECK', insert('dwarfs', { id: ID_35 }))
      T('dwarfs.provider_id CHECK', insert('dwarfs', { provider_id: 'provider-b' }))
      R('dwarfs.provider_id CHECK', insert('dwarfs', { provider_id: '' }))
      T('dwarfs.provider_session_id CHECK', insert('dwarfs', { provider_session_id: 'session-x' }))
      R('dwarfs.provider_session_id CHECK', insert('dwarfs', { provider_session_id: '' }))
      T('dwarfs.base_name CHECK', insert('dwarfs', { base_name: 'Dain' }))
      R('dwarfs.base_name CHECK', insert('dwarfs', { base_name: '' }))
      const session = String(value('SELECT provider_session_id FROM dwarfs WHERE id = ?', [DWARF]))
      T(
        'dwarfs UNIQUE (provider_id, provider_session_id, provider_agent_id)',
        insert('dwarfs', { provider_session_id: session, provider_agent_id: 'subagent-1' })
      )
      R(
        'dwarfs UNIQUE (provider_id, provider_session_id, provider_agent_id)',
        insert('dwarfs', { provider_session_id: session })
      )
    })

    it('[ADR-005] dwarfs: a custom name of 1 to 24 characters, each rank, delegated and stop flags store; an empty or 25-character name, an unknown rank and flags outside 0/1 are rejected', () => {
      for (const name of ['A', 'x'.repeat(24)]) {
        T('dwarfs.custom_name CHECK', insert('dwarfs', { custom_name: name }))
      }
      for (const name of ['', 'x'.repeat(25)]) {
        R('dwarfs.custom_name CHECK', insert('dwarfs', { custom_name: name }))
      }
      for (const rank of ['foreman', 'worker', 'worker2']) {
        T('dwarfs.rank CHECK', insert('dwarfs', { rank }))
      }
      R('dwarfs.rank CHECK', insert('dwarfs', { rank: 'captain' }))
      T('dwarfs.delegated CHECK', insert('dwarfs', { delegated: 1 }))
      R('dwarfs.delegated CHECK', insert('dwarfs', { delegated: 2 }))
      T('dwarfs.stop_in_flight CHECK', insert('dwarfs', { stop_in_flight: 1 }))
      R('dwarfs.stop_in_flight CHECK', insert('dwarfs', { stop_in_flight: 2 }))
    })

    it("[ADR-015] dwarfs: process_state 'unrecovered', each presence and each usage_path store; unknown values are rejected", () => {
      for (const state of ['running', 'unrecovered', 'closed']) {
        T('dwarfs.process_state CHECK', insert('dwarfs', { process_state: state }))
      }
      R('dwarfs.process_state CHECK', insert('dwarfs', { process_state: 'dead' }))
      for (const presence of ['present', 'resuming', 'walking-out']) {
        T('dwarfs.presence CHECK', insert('dwarfs', { presence }))
      }
      R('dwarfs.presence CHECK', insert('dwarfs', { presence: 'away' }))
      for (const path of ['driver', 'transcript']) {
        T('dwarfs.usage_path CHECK', insert('dwarfs', { usage_path: path }))
      }
      R('dwarfs.usage_path CHECK', insert('dwarfs', { usage_path: 'hook' }))
    })

    it('[ADR-005] dwarfs: an ended turn stores with its instant and reliability; a turn ended without either and an unknown turn state or reliability are rejected', () => {
      const ended = { turn_state: 'ended', turn_ended_at: 5 }
      for (const state of ['active', 'none-yet']) {
        T('dwarfs.turn_state CHECK', insert('dwarfs', { turn_state: state }))
      }
      R('dwarfs.turn_state CHECK', insert('dwarfs', { turn_state: 'idle' }))
      for (const reliability of ['reliable', 'inferred']) {
        T(
          'dwarfs.turn_end_reliability CHECK',
          insert('dwarfs', { ...ended, turn_end_reliability: reliability })
        )
      }
      R(
        'dwarfs.turn_end_reliability CHECK',
        insert('dwarfs', { ...ended, turn_end_reliability: 'guessed' })
      )
      T(
        "dwarfs CHECK ((turn_state = 'ended') = (turn_ended_at IS NOT NULL))",
        insert('dwarfs', { ...ended, turn_end_reliability: 'reliable' })
      )
      R(
        "dwarfs CHECK ((turn_state = 'ended') = (turn_ended_at IS NOT NULL))",
        insert('dwarfs', { turn_state: 'ended', turn_end_reliability: 'reliable' })
      )
      R(
        "dwarfs CHECK ((turn_state = 'ended') = (turn_ended_at IS NOT NULL))",
        insert('dwarfs', { turn_state: 'active', turn_ended_at: 5 })
      )
      T(
        "dwarfs CHECK ((turn_state = 'ended') = (turn_end_reliability IS NOT NULL))",
        insert('dwarfs', { ...ended, turn_end_reliability: 'inferred' })
      )
      R(
        "dwarfs CHECK ((turn_state = 'ended') = (turn_end_reliability IS NOT NULL))",
        insert('dwarfs', ended)
      )
    })

    it('[ADR-005] dwarfs: a departed dwarf stores with its cause and a closed process; a departure without a cause or with a live process, an unknown cause, a branch without a path and a dwarf that parents itself are rejected', () => {
      const departed = { process_state: 'closed', departed_at: 6 }
      for (const cause of [
        'stopped',
        'mine-removed',
        'closed-elsewhere',
        'crashed',
        'recovery-dismissed',
        'recovery-failed'
      ]) {
        T('dwarfs.departure_cause CHECK', insert('dwarfs', { ...departed, departure_cause: cause }))
      }
      R(
        'dwarfs.departure_cause CHECK',
        insert('dwarfs', { ...departed, departure_cause: 'vanished' })
      )
      T(
        'dwarfs CHECK ((departed_at IS NULL) = (departure_cause IS NULL))',
        insert('dwarfs', { ...departed, departure_cause: 'stopped' })
      )
      R(
        'dwarfs CHECK ((departed_at IS NULL) = (departure_cause IS NULL))',
        insert('dwarfs', departed)
      )
      T(
        "dwarfs CHECK (departed_at IS NULL OR process_state = 'closed')",
        insert('dwarfs', { ...departed, departure_cause: 'crashed' })
      )
      R(
        "dwarfs CHECK (departed_at IS NULL OR process_state = 'closed')",
        insert('dwarfs', { departed_at: 6, departure_cause: 'crashed' })
      )
      T(
        'dwarfs CHECK (workplace_branch IS NULL OR workplace_path IS NOT NULL)',
        insert('dwarfs', { workplace_path: '/mines/base/tree', workplace_branch: 'feature' })
      )
      R(
        'dwarfs CHECK (workplace_branch IS NULL OR workplace_path IS NOT NULL)',
        insert('dwarfs', { workplace_branch: 'feature' })
      )
      T(
        'dwarfs CHECK (parent_dwarf_id IS NULL OR parent_dwarf_id <> id)',
        insert('dwarfs', { parent_dwarf_id: DWARF })
      )
      const self = newId()
      R(
        'dwarfs CHECK (parent_dwarf_id IS NULL OR parent_dwarf_id <> id)',
        insert('dwarfs', { id: self, parent_dwarf_id: self })
      )
    })

    it('[ADR-005] dwarfs: removing a mine removes its crew; removing a parent clears the child link; a missing mine or parent is rejected', () => {
      const mine = newId()
      const crew = newId()
      put(insert('mines', { id: mine }), insert('dwarfs', { id: crew, mine_id: mine }))
      T('fk dwarfs.mine_id → mines', remove('mines', { id: mine }))
      expect(rows('SELECT id FROM dwarfs WHERE id = ?', [crew])).toEqual([])
      R('fk dwarfs.mine_id → mines', insert('dwarfs', { mine_id: GHOST }))

      const child = newId()
      put(insert('dwarfs', { id: child, parent_dwarf_id: DWARF2 }))
      T('fk dwarfs.parent_dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT parent_dwarf_id FROM dwarfs WHERE id = ?', [child])).toBeNull()
      R('fk dwarfs.parent_dwarf_id → dwarfs', insert('dwarfs', { parent_dwarf_id: GHOST }))
    })

    it('[ADR-006] source_cursors: a regression of a cursor value is rejected by its trigger', () => {
      T(
        'trigger source_cursors_never_regress',
        update('source_cursors', { value: 20 }, { stream_id: CURSOR })
      )
      T(
        'trigger source_cursors_never_regress',
        update('source_cursors', { value: 20 }, { stream_id: CURSOR })
      )
      R(
        'trigger source_cursors_never_regress',
        update('source_cursors', { value: 5 }, { stream_id: CURSOR })
      )
      R(
        'trigger source_cursors_never_regress',
        update('source_cursors', { kind: 'watermark' }, { stream_id: CURSOR })
      )
      expect(value('SELECT value FROM source_cursors WHERE stream_id = ?', [CURSOR])).toBe(20)
    })

    it('[ADR-006] source_cursors: each kind stores, missing_since included; an empty stream id, an unknown kind, a negative value and a none cursor with a value are rejected', () => {
      for (const kind of ['byte-offset', 'watermark', 'none']) {
        T('source_cursors.kind CHECK', insert('source_cursors', { kind, missing_since: 3 }))
      }
      R('source_cursors.kind CHECK', insert('source_cursors', { kind: 'line' }))
      T('source_cursors.stream_id CHECK', insert('source_cursors', { stream_id: 'stream-x' }))
      R('source_cursors.stream_id CHECK', insert('source_cursors', { stream_id: '' }))
      T('source_cursors.value CHECK', insert('source_cursors', { value: 0 }))
      R('source_cursors.value CHECK', insert('source_cursors', { value: -1 }))
      T(
        "source_cursors CHECK (kind <> 'none' OR value = 0)",
        insert('source_cursors', { kind: 'none' })
      )
      R(
        "source_cursors CHECK (kind <> 'none' OR value = 0)",
        insert('source_cursors', { kind: 'none', value: 5 })
      )
    })

    it('[ADR-006] observed_sessions and their streams: a session stores with its streams and goes with its dwarf; a last record before the first, a missing dwarf, session or stream are rejected', () => {
      const unobserved = newId()
      put(insert('dwarfs', { id: unobserved }))
      T(
        'observed_sessions CHECK (last_record_at >= first_seen_at)',
        insert('observed_sessions', { last_record_at: 1 })
      )
      R(
        'observed_sessions CHECK (last_record_at >= first_seen_at)',
        insert('observed_sessions', { dwarf_id: unobserved, first_seen_at: 5, last_record_at: 4 })
      )
      R('fk observed_sessions.dwarf_id → dwarfs', insert('observed_sessions', { dwarf_id: GHOST }))
      T(
        'fk observed_session_streams.dwarf_id → observed_sessions',
        insert('observed_session_streams')
      )
      R(
        'fk observed_session_streams.dwarf_id → observed_sessions',
        insert('observed_session_streams', { dwarf_id: unobserved })
      )
      R(
        'fk observed_session_streams.stream_id → source_cursors',
        insert('observed_session_streams', { stream_id: 'stream-unknown' })
      )
      T(
        'fk observed_session_streams.stream_id → source_cursors',
        remove('source_cursors', { stream_id: CURSOR })
      )
      expect(value('SELECT count(*) FROM observed_session_streams')).toBe(0)

      put(insert('source_cursors', { stream_id: 'stream-2' }))
      put(insert('observed_session_streams', { stream_id: 'stream-2' }))
      T('fk observed_sessions.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF }))
      expect(value('SELECT count(*) FROM observed_sessions WHERE dwarf_id = ?', [DWARF])).toBe(0)
      expect(value('SELECT count(*) FROM observed_session_streams')).toBe(0)
    })

    it('[ADR-005] observed_session_streams: removing the observed session removes its stream links', () => {
      put(insert('observed_session_streams'))
      T(
        'fk observed_session_streams.dwarf_id → observed_sessions',
        remove('observed_sessions', { dwarf_id: DWARF })
      )
      expect(value('SELECT count(*) FROM observed_session_streams')).toBe(0)
      expect(value('SELECT count(*) FROM source_cursors WHERE stream_id = ?', [CURSOR])).toBe(1)
    })

    it('[ADR-006] dwarf_lifecycle_facts: a TurnEnded without a turn: key is rejected; a second DwarfDeparted for one dwarf is rejected', () => {
      T(
        "dwarf_lifecycle_facts CHECK (type <> 'TurnEnded' OR source_key LIKE 'turn:%')",
        insert('dwarf_lifecycle_facts', { type: 'TurnEnded', source_key: 'turn:1' })
      )
      R(
        "dwarf_lifecycle_facts CHECK (type <> 'TurnEnded' OR source_key LIKE 'turn:%')",
        insert('dwarf_lifecycle_facts', { type: 'TurnEnded', source_key: 'end:2' })
      )
      T(
        'dwarf_lifecycle_facts UNIQUE (source_key)',
        insert('dwarf_lifecycle_facts', { type: 'TurnEnded', source_key: 'turn:2' })
      )
      R(
        'dwarf_lifecycle_facts UNIQUE (source_key)',
        insert('dwarf_lifecycle_facts', { type: 'TurnEnded', source_key: 'turn:1' })
      )
      const departed = { type: 'DwarfDeparted', cause: 'stopped' }
      T('index dwarf_lifecycle_facts_one_departure', insert('dwarf_lifecycle_facts', departed))
      T(
        'index dwarf_lifecycle_facts_one_departure',
        insert('dwarf_lifecycle_facts', { ...departed, dwarf_id: DWARF2 })
      )
      R('index dwarf_lifecycle_facts_one_departure', insert('dwarf_lifecycle_facts', departed))
    })

    it('[ADR-006] dwarf_lifecycle_facts: each fact type stores with its own fields; an unknown type or cause, a departure without a cause, an exit code on another type, a keyless observation and a short id are rejected', () => {
      const departedDwarf = newId()
      put(insert('dwarfs', { id: departedDwarf }))
      const typed: readonly Row[] = [
        { type: 'DwarfArrived' },
        { type: 'DwarfRebound' },
        { type: 'SubagentObserved', source_key: 'subagent:1' },
        { type: 'SessionClosedObserved', source_key: 'closed:1' },
        { type: 'DriverSessionExited', source_key: 'exit:1', exit_code: 0 },
        { type: 'TurnEnded', source_key: 'turn:9' },
        { type: 'DwarfDeparted', cause: 'stopped', dwarf_id: departedDwarf }
      ]
      for (const fields of typed)
        T('dwarf_lifecycle_facts.type CHECK', insert('dwarf_lifecycle_facts', fields))
      R(
        'dwarf_lifecycle_facts.type CHECK',
        insert('dwarf_lifecycle_facts', { type: 'DwarfNapped', source_key: 'nap:1' })
      )

      const fact = newId()
      put(
        insert('dwarf_lifecycle_facts', {
          id: fact,
          dwarf_id: DWARF2,
          type: 'DwarfDeparted',
          cause: 'stopped'
        })
      )
      for (const cause of [
        'mine-removed',
        'closed-elsewhere',
        'crashed',
        'recovery-dismissed',
        'recovery-failed'
      ]) {
        T(
          'dwarf_lifecycle_facts.cause CHECK',
          update('dwarf_lifecycle_facts', { cause }, { id: fact })
        )
      }
      R(
        'dwarf_lifecycle_facts.cause CHECK',
        update('dwarf_lifecycle_facts', { cause: 'vanished' }, { id: fact })
      )

      T(
        "dwarf_lifecycle_facts CHECK ((type = 'DwarfDeparted') = (cause IS NOT NULL))",
        insert('dwarf_lifecycle_facts', { type: 'DwarfRebound' })
      )
      R(
        "dwarf_lifecycle_facts CHECK ((type = 'DwarfDeparted') = (cause IS NOT NULL))",
        insert('dwarf_lifecycle_facts', { type: 'DwarfDeparted' })
      )
      R(
        "dwarf_lifecycle_facts CHECK ((type = 'DwarfDeparted') = (cause IS NOT NULL))",
        insert('dwarf_lifecycle_facts', { type: 'DwarfArrived', cause: 'stopped' })
      )
      T(
        "dwarf_lifecycle_facts CHECK (exit_code IS NULL OR type = 'DriverSessionExited')",
        insert('dwarf_lifecycle_facts', {
          type: 'DriverSessionExited',
          source_key: 'exit:2',
          exit_code: 1
        })
      )
      R(
        "dwarf_lifecycle_facts CHECK (exit_code IS NULL OR type = 'DriverSessionExited')",
        insert('dwarf_lifecycle_facts', { type: 'TurnEnded', source_key: 'turn:10', exit_code: 1 })
      )
      T(
        "dwarf_lifecycle_facts CHECK (source_key IS NOT NULL OR type IN ('DwarfArrived', 'DwarfRebound', 'DwarfDeparted'))",
        insert('dwarf_lifecycle_facts', { type: 'SubagentObserved', source_key: 'subagent:2' })
      )
      R(
        "dwarf_lifecycle_facts CHECK (source_key IS NOT NULL OR type IN ('DwarfArrived', 'DwarfRebound', 'DwarfDeparted'))",
        insert('dwarf_lifecycle_facts', { type: 'SubagentObserved' })
      )
      T('dwarf_lifecycle_facts.id CHECK', insert('dwarf_lifecycle_facts', { id: newId() }))
      R('dwarf_lifecycle_facts.id CHECK', insert('dwarf_lifecycle_facts', { id: ID_35 }))
    })

    it('[ADR-005] dwarf_lifecycle_facts: the facts of a removed dwarf go with it; a fact for a missing dwarf is rejected', () => {
      put(insert('dwarf_lifecycle_facts', { dwarf_id: DWARF2 }))
      T('fk dwarf_lifecycle_facts.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM dwarf_lifecycle_facts WHERE dwarf_id = ?', [DWARF2])).toBe(
        0
      )
      R(
        'fk dwarf_lifecycle_facts.dwarf_id → dwarfs',
        insert('dwarf_lifecycle_facts', { dwarf_id: GHOST })
      )
    })
  })

  describe('09 §4.3 suppliers, launching and recovery', () => {
    it('[ADR-009] capability_records: one record per provider version with valid JSON stores; a short id, invalid JSON and a repeated provider version are rejected', () => {
      T('capability_records.id CHECK', insert('capability_records', { id: newId() }))
      R('capability_records.id CHECK', insert('capability_records', { id: ID_35 }))
      T(
        'capability_records.capabilities_json CHECK',
        insert('capability_records', { capabilities_json: '{"streaming":true}' })
      )
      R(
        'capability_records.capabilities_json CHECK',
        insert('capability_records', { capabilities_json: 'not json' })
      )
      T(
        'capability_records UNIQUE (provider_id, provider_version)',
        insert('capability_records', { provider_version: '2.0.0' })
      )
      R(
        'capability_records UNIQUE (provider_id, provider_version)',
        insert('capability_records', { provider_version: '2.0.0' })
      )
    })

    it('[ADR-020] launches: each way, state and flag stores with its own fields; unknown values, invalid custom command JSON and a short id are rejected', () => {
      T('launches.id CHECK', insert('launches', { id: newId() }))
      R('launches.id CHECK', insert('launches', { id: ID_35 }))
      const ways: readonly Row[] = [
        { way_kind: 'supplier' },
        { way_kind: 'custom', provider_id: null, custom_command_json: '["run","--json"]' },
        { way_kind: 'jev', provider_id: null, launched_with_let_jev_choose: 1 }
      ]
      for (const way of ways) T('launches.way_kind CHECK', insert('launches', way))
      R('launches.way_kind CHECK', insert('launches', { way_kind: 'manual' }))
      T(
        'launches.custom_command_json CHECK',
        insert('launches', { way_kind: 'custom', custom_command_json: '["run"]' })
      )
      R(
        'launches.custom_command_json CHECK',
        insert('launches', { way_kind: 'custom', custom_command_json: 'not json' })
      )
      T(
        'launches.launched_with_let_jev_choose CHECK',
        insert('launches', { launched_with_let_jev_choose: 1 })
      )
      R(
        'launches.launched_with_let_jev_choose CHECK',
        insert('launches', { launched_with_let_jev_choose: 2 })
      )
      T('launches.jev_auto_accept CHECK', insert('launches', { jev_auto_accept: 1 }))
      R('launches.jev_auto_accept CHECK', insert('launches', { jev_auto_accept: 2 }))
      T('launches.delegated CHECK', insert('launches', { delegated: 1 }))
      R('launches.delegated CHECK', insert('launches', { delegated: 2 }))
      const states: readonly Row[] = [
        { state: 'routing' },
        { state: 'resolving' },
        { state: 'spawned', spawned_at: 2 },
        { state: 'succeeded', settled_at: 3 },
        { state: 'failed', failure_cause: 'not-installed', settled_at: 3 },
        { state: 'handed-back', settled_at: 3 },
        { state: 'lost', settled_at: 3 }
      ]
      for (const state of states) T('launches.state CHECK', insert('launches', state))
      R('launches.state CHECK', insert('launches', { state: 'cancelled' }))
    })

    it('[ADR-020] launches: each of the five failure causes stores on a failed launch, the Jev ones with their reason; an unknown cause, a failure without a cause and a cause on a live launch are rejected', () => {
      const failed = { state: 'failed', settled_at: 3 }
      const jev = { launched_with_let_jev_choose: 1, jev_reason: 'timeout' }
      for (const cause of ['not-installed', 'exited-at-once', 'could-not-start']) {
        T('launches.failure_cause CHECK', insert('launches', { ...failed, failure_cause: cause }))
      }
      for (const cause of ['jev-unreachable', 'jev-could-not-choose']) {
        T(
          'launches.failure_cause CHECK',
          insert('launches', { ...failed, ...jev, failure_cause: cause })
        )
      }
      R('launches.failure_cause CHECK', insert('launches', { ...failed, failure_cause: 'timeout' }))
      T(
        "launches CHECK ((state = 'failed') = (failure_cause IS NOT NULL))",
        insert('launches', { ...failed, failure_cause: 'exited-at-once' })
      )
      R(
        "launches CHECK ((state = 'failed') = (failure_cause IS NOT NULL))",
        insert('launches', failed)
      )
      R(
        "launches CHECK ((state = 'failed') = (failure_cause IS NOT NULL))",
        insert('launches', { failure_cause: 'not-installed' })
      )
      T(
        "launches CHECK (failure_cause NOT IN ('jev-unreachable', 'jev-could-not-choose') OR jev_reason IS NOT NULL)",
        insert('launches', { ...failed, ...jev, failure_cause: 'jev-unreachable' })
      )
      R(
        "launches CHECK (failure_cause NOT IN ('jev-unreachable', 'jev-could-not-choose') OR jev_reason IS NOT NULL)",
        insert('launches', {
          ...failed,
          launched_with_let_jev_choose: 1,
          failure_cause: 'jev-unreachable'
        })
      )
    })

    it('[ADR-020] launches: each Jev reason stores on a Let-Jev-choose or a delegated launch; an unknown reason and a reason on a plain launch are rejected', () => {
      for (const reason of [
        'unreachable',
        'timeout',
        'rate-limited',
        'invalid-response',
        'no-key',
        'unauthorized',
        'low-confidence',
        'budget-exceeded',
        'no-launchable-provider',
        'effort-ceiling'
      ]) {
        T(
          'launches.jev_reason CHECK',
          insert('launches', { launched_with_let_jev_choose: 1, jev_reason: reason })
        )
      }
      R(
        'launches.jev_reason CHECK',
        insert('launches', { launched_with_let_jev_choose: 1, jev_reason: 'busy' })
      )
      T(
        'launches CHECK (jev_reason IS NULL OR launched_with_let_jev_choose = 1 OR delegated = 1)',
        insert('launches', { delegated: 1, jev_reason: 'effort-ceiling' })
      )
      R(
        'launches CHECK (jev_reason IS NULL OR launched_with_let_jev_choose = 1 OR delegated = 1)',
        insert('launches', { jev_reason: 'timeout' })
      )
    })

    it('[INV-53] launches.seen_at stores on a failed launch and is rejected on a succeeded or in-flight launch', () => {
      T(
        "launches CHECK (seen_at IS NULL OR state = 'failed')",
        insert('launches', {
          state: 'failed',
          failure_cause: 'not-installed',
          settled_at: 3,
          seen_at: 4
        })
      )
      R(
        "launches CHECK (seen_at IS NULL OR state = 'failed')",
        insert('launches', { state: 'succeeded', settled_at: 3, seen_at: 4 })
      )
      R(
        "launches CHECK (seen_at IS NULL OR state = 'failed')",
        insert('launches', { state: 'spawned', seen_at: 4 })
      )
    })

    it('[ADR-020] launches: a settled state stores with its instant, a custom way with its command, a supplier way with its provider; each pairing broken is rejected', () => {
      T(
        "launches CHECK ((state IN ('succeeded', 'failed', 'handed-back', 'lost')) = (settled_at IS NOT NULL))",
        insert('launches', { state: 'lost', settled_at: 5 })
      )
      R(
        "launches CHECK ((state IN ('succeeded', 'failed', 'handed-back', 'lost')) = (settled_at IS NOT NULL))",
        insert('launches', { state: 'succeeded' })
      )
      R(
        "launches CHECK ((state IN ('succeeded', 'failed', 'handed-back', 'lost')) = (settled_at IS NOT NULL))",
        insert('launches', { state: 'resolving', settled_at: 5 })
      )
      T(
        "launches CHECK ((way_kind = 'custom') = (custom_command_json IS NOT NULL))",
        insert('launches', { way_kind: 'custom', provider_id: null, custom_command_json: '["go"]' })
      )
      R(
        "launches CHECK ((way_kind = 'custom') = (custom_command_json IS NOT NULL))",
        insert('launches', { way_kind: 'custom' })
      )
      R(
        "launches CHECK ((way_kind = 'custom') = (custom_command_json IS NOT NULL))",
        insert('launches', { custom_command_json: '["go"]' })
      )
      T(
        "launches CHECK (way_kind <> 'supplier' OR provider_id IS NOT NULL)",
        insert('launches', { provider_id: 'provider-b' })
      )
      R(
        "launches CHECK (way_kind <> 'supplier' OR provider_id IS NOT NULL)",
        insert('launches', { provider_id: null })
      )
    })

    it('[ADR-013] launches: a delegated worker launch stores with its delegation and keeps delegated = 1 when the delegation goes; a delegation on a plain launch, Let-Jev-choose on a worker and handed-back on a worker are rejected', () => {
      const delegation = newId()
      const worker = newId()
      put(insert('delegations', { id: delegation }))
      T(
        'launches CHECK (delegated = 1 OR delegation_id IS NULL)',
        insert('launches', { id: worker, delegated: 1, delegation_id: delegation })
      )
      R(
        'launches CHECK (delegated = 1 OR delegation_id IS NULL)',
        insert('launches', { delegation_id: delegation })
      )
      T(
        'launches CHECK (delegated = 0 OR launched_with_let_jev_choose = 0)',
        insert('launches', { delegated: 1 })
      )
      R(
        'launches CHECK (delegated = 0 OR launched_with_let_jev_choose = 0)',
        insert('launches', { delegated: 1, launched_with_let_jev_choose: 1 })
      )
      T(
        "launches CHECK (state <> 'handed-back' OR delegated = 0)",
        insert('launches', { state: 'handed-back', settled_at: 3 })
      )
      R(
        "launches CHECK (state <> 'handed-back' OR delegated = 0)",
        insert('launches', { state: 'handed-back', settled_at: 3, delegated: 1 })
      )
      T('fk launches.delegation_id → delegations', remove('delegations', { id: delegation }))
      expect(rows('SELECT delegation_id, delegated FROM launches WHERE id = ?', [worker])).toEqual([
        { delegation_id: null, delegated: 1 }
      ])
      R(
        'fk launches.delegation_id → delegations',
        insert('launches', { delegated: 1, delegation_id: GHOST })
      )
    })

    it('[ADR-005] launches: one launch per dwarf; removing the dwarf, the mine or the retried launch clears the link; a missing dwarf, mine, retried launch is rejected', () => {
      const launch = newId()
      T('launches UNIQUE (dwarf_id)', insert('launches', { id: launch, dwarf_id: DWARF2 }))
      R('launches UNIQUE (dwarf_id)', insert('launches', { dwarf_id: DWARF2 }))
      T('fk launches.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT dwarf_id FROM launches WHERE id = ?', [launch])).toBeNull()
      R('fk launches.dwarf_id → dwarfs', insert('launches', { dwarf_id: GHOST }))

      const mine = newId()
      const elsewhere = newId()
      put(insert('mines', { id: mine }), insert('launches', { id: elsewhere, mine_id: mine }))
      T('fk launches.mine_id → mines', remove('mines', { id: mine }))
      expect(value('SELECT mine_id FROM launches WHERE id = ?', [elsewhere])).toBeNull()
      R('fk launches.mine_id → mines', insert('launches', { mine_id: GHOST }))

      const retry = newId()
      put(insert('launches', { id: retry, retry_of: LAUNCH }))
      T('fk launches.retry_of → launches', remove('launches', { id: LAUNCH }))
      expect(value('SELECT retry_of FROM launches WHERE id = ?', [retry])).toBeNull()
      R('fk launches.retry_of → launches', insert('launches', { retry_of: GHOST }))
    })

    it('[ADR-014] processes: each purpose stores with a positive pid; an unknown purpose, pid 0, a short id and a repeated process identity are rejected; removing the launch clears the link', () => {
      for (const purpose of ['session', 'session-server', 'mcp-relay', 'hook-shim', 'launcher']) {
        T('processes.purpose CHECK', insert('processes', { purpose }))
      }
      R('processes.purpose CHECK', insert('processes', { purpose: 'daemon' }))
      T('processes.pid CHECK', insert('processes', { pid: 1 }))
      R('processes.pid CHECK', insert('processes', { pid: 0 }))
      T('processes.id CHECK', insert('processes', { id: newId() }))
      R('processes.id CHECK', insert('processes', { id: ID_35 }))
      const identity = { pid: 4242, process_start_time_ms: 77, boot_id: 'boot-1' }
      T('processes UNIQUE (pid, process_start_time_ms, boot_id)', insert('processes', identity))
      T(
        'processes UNIQUE (pid, process_start_time_ms, boot_id)',
        insert('processes', { ...identity, process_start_time_ms: 78 })
      )
      R('processes UNIQUE (pid, process_start_time_ms, boot_id)', insert('processes', identity))

      const process = newId()
      put(insert('processes', { id: process, launch_id: LAUNCH }))
      T('fk processes.launch_id → launches', remove('launches', { id: LAUNCH }))
      expect(value('SELECT launch_id FROM processes WHERE id = ?', [process])).toBeNull()
      R('fk processes.launch_id → launches', insert('processes', { launch_id: GHOST }))
    })

    it('[ADR-015] launch_records: each driver transport and flag stores; an unknown transport, invalid session JSON, flags outside 0/1 and an ended record that still means to resume are rejected', () => {
      put(insert('launch_records'))
      for (const transport of [
        'acp',
        'agent-sdk',
        'stream-json',
        'app-server-rpc',
        'http-server',
        'ndjson',
        'stdio-raw'
      ]) {
        T(
          'launch_records.driver_transport CHECK',
          update('launch_records', { driver_transport: transport }, { dwarf_id: DWARF })
        )
      }
      R(
        'launch_records.driver_transport CHECK',
        update('launch_records', { driver_transport: 'pty' }, { dwarf_id: DWARF })
      )
      T(
        'launch_records.session_ref_json CHECK',
        update('launch_records', { session_ref_json: '{"id":"s"}' }, { dwarf_id: DWARF })
      )
      R(
        'launch_records.session_ref_json CHECK',
        update('launch_records', { session_ref_json: 'x' }, { dwarf_id: DWARF })
      )
      T(
        'launch_records.resume_intent CHECK',
        update('launch_records', { resume_intent: 0 }, { dwarf_id: DWARF })
      )
      R(
        'launch_records.resume_intent CHECK',
        update('launch_records', { resume_intent: 2 }, { dwarf_id: DWARF })
      )
      T(
        'launch_records.stopped_by_person CHECK',
        update('launch_records', { stopped_by_person: 1 }, { dwarf_id: DWARF })
      )
      R(
        'launch_records.stopped_by_person CHECK',
        update('launch_records', { stopped_by_person: 2 }, { dwarf_id: DWARF })
      )
      T(
        'launch_records CHECK (ended_at IS NULL OR resume_intent = 0)',
        update('launch_records', { resume_intent: 0, ended_at: 9 }, { dwarf_id: DWARF })
      )
      R(
        'launch_records CHECK (ended_at IS NULL OR resume_intent = 0)',
        update('launch_records', { resume_intent: 1 }, { dwarf_id: DWARF })
      )
    })

    it('[ADR-015] launch_records: one record per launch; a launch with a record cannot be removed; removing the dwarf removes the record and removing the process clears it; missing references are rejected', () => {
      const other = newId()
      const spare = newId()
      const unrecorded = newId()
      put(
        insert('launch_records'),
        insert('launches', { id: other }),
        insert('launches', { id: spare }),
        insert('dwarfs', { id: unrecorded })
      )
      T(
        'launch_records UNIQUE (launch_id)',
        insert('launch_records', { dwarf_id: DWARF2, launch_id: other })
      )
      R(
        'launch_records UNIQUE (launch_id)',
        insert('launch_records', { dwarf_id: unrecorded, launch_id: LAUNCH })
      )
      R('fk launch_records.launch_id → launches', remove('launches', { id: LAUNCH }))
      R(
        'fk launch_records.launch_id → launches',
        insert('launch_records', { dwarf_id: unrecorded, launch_id: GHOST })
      )
      T('fk launch_records.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF }))
      expect(value('SELECT count(*) FROM launch_records WHERE launch_id = ?', [LAUNCH])).toBe(0)
      T('fk launch_records.launch_id → launches', remove('launches', { id: LAUNCH }))
      R(
        'fk launch_records.dwarf_id → dwarfs',
        insert('launch_records', { dwarf_id: GHOST, launch_id: spare })
      )

      const process = newId()
      put(
        insert('processes', { id: process }),
        update('launch_records', { process_id: process }, { dwarf_id: DWARF2 })
      )
      T('fk launch_records.process_id → processes', remove('processes', { id: process }))
      expect(value('SELECT process_id FROM launch_records WHERE dwarf_id = ?', [DWARF2])).toBeNull()
      R(
        'fk launch_records.process_id → processes',
        update('launch_records', { process_id: GHOST }, { dwarf_id: DWARF2 })
      )
    })

    it('[ADR-015] host_recovery_reports: each state stores with its instants; an unknown state, invalid JSON, a settled report without its instant and a shown report without its shown instant are rejected', () => {
      const states: readonly Row[] = [
        { state: 'pending-display' },
        { state: 'shown', shown_at: 2 },
        { state: 'retrying', shown_at: 2 },
        { state: 'settled', shown_at: 2, settled_at: 3 },
        { state: 'superseded' }
      ]
      for (const state of states)
        T('host_recovery_reports.state CHECK', insert('host_recovery_reports', state))
      R('host_recovery_reports.state CHECK', insert('host_recovery_reports', { state: 'hidden' }))
      T(
        'host_recovery_reports.resumed_json CHECK',
        insert('host_recovery_reports', { resumed_json: '["a"]' })
      )
      R(
        'host_recovery_reports.resumed_json CHECK',
        insert('host_recovery_reports', { resumed_json: 'x' })
      )
      T(
        "host_recovery_reports CHECK ((state = 'settled') = (settled_at IS NOT NULL))",
        insert('host_recovery_reports', { state: 'settled', shown_at: 2, settled_at: 3 })
      )
      R(
        "host_recovery_reports CHECK ((state = 'settled') = (settled_at IS NOT NULL))",
        insert('host_recovery_reports', { state: 'settled', shown_at: 2 })
      )
      R(
        "host_recovery_reports CHECK ((state = 'settled') = (settled_at IS NOT NULL))",
        insert('host_recovery_reports', { state: 'shown', shown_at: 2, settled_at: 3 })
      )
      T(
        "host_recovery_reports CHECK (state NOT IN ('shown', 'retrying', 'settled') OR shown_at IS NOT NULL)",
        insert('host_recovery_reports', { state: 'retrying', shown_at: 2 })
      )
      R(
        "host_recovery_reports CHECK (state NOT IN ('shown', 'retrying', 'settled') OR shown_at IS NOT NULL)",
        insert('host_recovery_reports', { state: 'shown' })
      )
    })

    it('[ADR-015] host_recovery_items: each reason and retry outcome stores; unknown values and invalid JSON are rejected; an item goes with its report or its dwarf; missing references are rejected', () => {
      put(insert('host_recovery_items'))
      const key = { host_epoch: REPORT, dwarf_id: DWARF }
      for (const reason of ['turn-lost', 'no-resume', 'stale-ref', 'resume-error', 'end-failed']) {
        T('host_recovery_items.reason CHECK', update('host_recovery_items', { reason }, key))
      }
      R('host_recovery_items.reason CHECK', update('host_recovery_items', { reason: 'oops' }, key))
      T(
        'host_recovery_items.message_ids_json CHECK',
        update('host_recovery_items', { message_ids_json: '["m"]' }, key)
      )
      R(
        'host_recovery_items.message_ids_json CHECK',
        update('host_recovery_items', { message_ids_json: 'x' }, key)
      )
      for (const outcome of ['resumed', 'failed']) {
        T(
          'host_recovery_items.retry_outcome CHECK',
          update('host_recovery_items', { retry_outcome: outcome }, key)
        )
      }
      R(
        'host_recovery_items.retry_outcome CHECK',
        update('host_recovery_items', { retry_outcome: 'maybe' }, key)
      )

      R(
        'fk host_recovery_items.host_epoch → host_recovery_reports',
        insert('host_recovery_items', { host_epoch: 'epoch-unknown' })
      )
      R(
        'fk host_recovery_items.dwarf_id → dwarfs',
        insert('host_recovery_items', { dwarf_id: GHOST })
      )
      put(insert('host_recovery_items', { dwarf_id: DWARF2 }))
      T('fk host_recovery_items.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM host_recovery_items WHERE dwarf_id = ?', [DWARF2])).toBe(0)
      T(
        'fk host_recovery_items.host_epoch → host_recovery_reports',
        remove('host_recovery_reports', { host_epoch: REPORT })
      )
      expect(value('SELECT count(*) FROM host_recovery_items')).toBe(0)
    })
  })

  describe('09 §4.4 conversation', () => {
    it('[ADR-005] messages: each role and origin stores with its own fields; unknown values, a short id, invalid JSON and a text over 65 536 bytes are rejected', () => {
      const roles: readonly Row[] = [
        { role: 'person' },
        { role: 'dwarf', origin: 'transcript', source_key: 'transcript:1' },
        { role: 'answers-record' },
        { role: 'system-line' }
      ]
      for (const role of roles) T('messages.role CHECK', insert('messages', role))
      R('messages.role CHECK', insert('messages', { role: 'robot' }))
      const origins: readonly Row[] = [
        { origin: 'live-stream', role: 'dwarf', source_key: 'live:1' },
        { origin: 'transcript', role: 'dwarf', source_key: 'transcript:2' },
        { origin: 'dwarfai' }
      ]
      for (const origin of origins) T('messages.origin CHECK', insert('messages', origin))
      R('messages.origin CHECK', insert('messages', { origin: 'import', source_key: 'import:1' }))
      T('messages.id CHECK', insert('messages', { id: newId() }))
      R('messages.id CHECK', insert('messages', { id: ID_35 }))
      T('messages.text CHECK', insert('messages', { text: 'x'.repeat(65536) }))
      R('messages.text CHECK', insert('messages', { text: 'x'.repeat(65537) }))
      T('messages.activity_json CHECK', insert('messages', { activity_json: '{"steps":[]}' }))
      R('messages.activity_json CHECK', insert('messages', { activity_json: 'x' }))
      T(
        'messages.attachments_json CHECK',
        insert('messages', { attachments_json: '[{"name":"a"}]' })
      )
      R('messages.attachments_json CHECK', insert('messages', { attachments_json: 'x' }))
    })

    it('[ADR-006] messages: a provider row stores with its source key and a DwarfAI row without one; a keyless provider row, a repeated key, a pending echo or an answers record from a provider, an ask on another role and a dwarf issuing to itself are rejected', () => {
      T(
        "messages CHECK (source_key IS NOT NULL OR origin = 'dwarfai')",
        insert('messages', { role: 'dwarf', origin: 'transcript', source_key: 'transcript:3' })
      )
      R(
        "messages CHECK (source_key IS NOT NULL OR origin = 'dwarfai')",
        insert('messages', { role: 'dwarf', origin: 'transcript' })
      )
      T(
        'messages UNIQUE (source_key)',
        insert('messages', { role: 'dwarf', origin: 'transcript', source_key: 'transcript:4' })
      )
      R(
        'messages UNIQUE (source_key)',
        insert('messages', { role: 'dwarf', origin: 'transcript', source_key: 'transcript:3' })
      )
      T(
        "messages CHECK (pending_echo IS NULL OR origin = 'dwarfai')",
        insert('messages', { pending_echo: 'echo-1' })
      )
      R(
        "messages CHECK (pending_echo IS NULL OR origin = 'dwarfai')",
        insert('messages', {
          role: 'dwarf',
          origin: 'live-stream',
          source_key: 'live:2',
          pending_echo: 'echo-2'
        })
      )
      T(
        "messages CHECK (role <> 'answers-record' OR origin = 'dwarfai')",
        insert('messages', { role: 'answers-record' })
      )
      R(
        "messages CHECK (role <> 'answers-record' OR origin = 'dwarfai')",
        insert('messages', {
          role: 'answers-record',
          origin: 'transcript',
          source_key: 'transcript:5'
        })
      )
      T(
        "messages CHECK (ask_id IS NULL OR role = 'answers-record')",
        insert('messages', { role: 'answers-record', ask_id: ASK })
      )
      R(
        "messages CHECK (ask_id IS NULL OR role = 'answers-record')",
        insert('messages', { ask_id: ASK })
      )
      T(
        'messages CHECK (issuer_dwarf_id IS NULL OR issuer_dwarf_id <> dwarf_id)',
        insert('messages', { issuer_dwarf_id: DWARF2 })
      )
      R(
        'messages CHECK (issuer_dwarf_id IS NULL OR issuer_dwarf_id <> dwarf_id)',
        insert('messages', { issuer_dwarf_id: DWARF })
      )
    })

    it('[ADR-003] messages.request_id: a second message with the same request_id is rejected; NULLs store', () => {
      T('index messages_send_request', insert('messages', { request_id: 'send-1' }))
      for (let copy = 0; copy < 3; copy += 1) {
        T('index messages_send_request', insert('messages', { request_id: null }))
      }
      R('index messages_send_request', insert('messages', { request_id: 'send-1' }))
      T(
        "messages CHECK (request_id IS NULL OR (role = 'person' AND origin = 'dwarfai'))",
        insert('messages', { request_id: 'send-2' })
      )
      R(
        "messages CHECK (request_id IS NULL OR (role = 'person' AND origin = 'dwarfai'))",
        insert('messages', { role: 'system-line', request_id: 'send-3' })
      )
      R(
        "messages CHECK (request_id IS NULL OR (role = 'person' AND origin = 'dwarfai'))",
        insert('messages', {
          role: 'person',
          origin: 'transcript',
          source_key: 'transcript:6',
          request_id: 'send-4'
        })
      )
    })

    it('[ADR-005] messages: removing a dwarf removes its messages, removing an issuer or an ask clears the link; a missing dwarf, issuer or ask is rejected', () => {
      const own = newId()
      const issued = newId()
      const record = newId()
      const ask = newId()
      put(
        insert('messages', { id: own, dwarf_id: DWARF2 }),
        insert('asks', { id: ask }),
        insert('messages', { id: record, role: 'answers-record', ask_id: ask })
      )
      T(
        'fk messages.issuer_dwarf_id → dwarfs',
        insert('messages', { id: issued, issuer_dwarf_id: DWARF2 })
      )
      T('fk messages.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(rows('SELECT id FROM messages WHERE id = ?', [own])).toEqual([])
      expect(value('SELECT issuer_dwarf_id FROM messages WHERE id = ?', [issued])).toBeNull()
      R('fk messages.dwarf_id → dwarfs', insert('messages', { dwarf_id: GHOST }))
      R('fk messages.issuer_dwarf_id → dwarfs', insert('messages', { issuer_dwarf_id: GHOST }))
      T('fk messages.ask_id → asks', remove('asks', { id: ask }))
      expect(value('SELECT ask_id FROM messages WHERE id = ?', [record])).toBeNull()
      R('fk messages.ask_id → asks', insert('messages', { role: 'answers-record', ask_id: GHOST }))
    })

    it('[ADR-006] message_keys: a key stores and outlives its message; removing the dwarf removes its keys; a missing dwarf or message is rejected', () => {
      const key = 'key-message'
      T(
        'fk message_keys.message_id → messages',
        insert('message_keys', { source_key: key, message_id: MESSAGE })
      )
      put(remove('messages', { id: MESSAGE }))
      expect(rows('SELECT message_id FROM message_keys WHERE source_key = ?', [key])).toEqual([
        { message_id: null }
      ])
      R('fk message_keys.message_id → messages', insert('message_keys', { message_id: GHOST }))
      put(insert('message_keys', { dwarf_id: DWARF2 }))
      T('fk message_keys.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM message_keys WHERE dwarf_id = ?', [DWARF2])).toBe(0)
      R('fk message_keys.dwarf_id → dwarfs', insert('message_keys', { dwarf_id: GHOST }))
    })

    it('[ADR-022] deliveries: each kind, phase, confidence and failure kind stores with its own fields; unknown values, attempts below 1 and flags outside 0/1 are rejected', () => {
      T('deliveries.kind CHECK', insert('deliveries'))
      T(
        'deliveries.kind CHECK',
        insert('deliveries', { message_id: ANSWERS_MESSAGE, kind: 'answers-record' })
      )
      put(remove('deliveries', { message_id: MESSAGE }))
      R('deliveries.kind CHECK', insert('deliveries', { kind: 'note' }))
      put(insert('deliveries'))
      const key = { message_id: MESSAGE }
      for (const phase of ['sending', 'delivered', 'reacted']) {
        T('deliveries.phase CHECK', update('deliveries', { phase }, key))
      }
      R('deliveries.phase CHECK', update('deliveries', { phase: 'lost' }, key))
      for (const confidence of ['confirmed', 'unconfirmed']) {
        T(
          'deliveries.confidence CHECK',
          update('deliveries', { phase: 'delivered', confidence }, key)
        )
      }
      R('deliveries.confidence CHECK', update('deliveries', { confidence: 'maybe' }, key))
      T(
        'deliveries.held_until_turn_end CHECK',
        update('deliveries', { held_until_turn_end: 1 }, key)
      )
      R(
        'deliveries.held_until_turn_end CHECK',
        update('deliveries', { held_until_turn_end: 2 }, key)
      )
      T('deliveries.attempts CHECK', update('deliveries', { attempts: 3 }, key))
      R('deliveries.attempts CHECK', update('deliveries', { attempts: 0 }, key))
      const failures: readonly Row[] = [
        { failure_kind: 'channel-error', failure_reason: 'pipe closed' },
        { failure_kind: 'session-closed', failure_reason: null },
        { failure_kind: 'host-interrupted', failure_reason: null }
      ]
      for (const failure of failures) {
        T(
          'deliveries.failure_kind CHECK',
          update('deliveries', { phase: 'failed', confidence: null, ...failure }, key)
        )
      }
      R(
        'deliveries.failure_kind CHECK',
        update('deliveries', { failure_kind: 'timeout', failure_reason: null }, key)
      )
    })

    it("[ADR-022] deliveries: a failure stores with its kind, confidence only once delivered, a refusal only on an answers record with its reason, 'ask-closed' included; each pairing broken is rejected", () => {
      put(
        insert('deliveries'),
        insert('deliveries', { message_id: ANSWERS_MESSAGE, kind: 'answers-record' })
      )
      const message = { message_id: MESSAGE }
      const record = { message_id: ANSWERS_MESSAGE }
      T(
        "deliveries CHECK ((phase = 'failed') = (failure_kind IS NOT NULL))",
        update('deliveries', { phase: 'failed', failure_kind: 'channel-error' }, message)
      )
      R(
        "deliveries CHECK ((phase = 'failed') = (failure_kind IS NOT NULL))",
        update('deliveries', { failure_kind: null }, message)
      )
      R(
        "deliveries CHECK ((phase = 'failed') = (failure_kind IS NOT NULL))",
        update('deliveries', { phase: 'sending' }, message)
      )
      T(
        "deliveries CHECK (confidence IS NULL OR phase IN ('delivered', 'reacted'))",
        update('deliveries', { phase: 'reacted', confidence: 'confirmed' }, record)
      )
      R(
        "deliveries CHECK (confidence IS NULL OR phase IN ('delivered', 'reacted'))",
        update('deliveries', { phase: 'sending' }, record)
      )
      T(
        "deliveries CHECK (failure_kind <> 'refused' OR (kind = 'answers-record' AND failure_reason IN ('channel-rejected', 'invalid-answer', 'channel-unavailable', 'ask-closed')))",
        update(
          'deliveries',
          {
            phase: 'failed',
            confidence: null,
            failure_kind: 'refused',
            failure_reason: 'ask-closed'
          },
          record
        )
      )
      R(
        "deliveries CHECK (failure_kind <> 'refused' OR (kind = 'answers-record' AND failure_reason IN ('channel-rejected', 'invalid-answer', 'channel-unavailable', 'ask-closed')))",
        update('deliveries', { failure_reason: 'closed' }, record)
      )
      R(
        "deliveries CHECK (failure_kind <> 'refused' OR (kind = 'answers-record' AND failure_reason IN ('channel-rejected', 'invalid-answer', 'channel-unavailable', 'ask-closed')))",
        update('deliveries', { failure_kind: 'refused', failure_reason: 'ask-closed' }, message)
      )
      T(
        "deliveries CHECK (failure_kind NOT IN ('session-closed', 'host-interrupted') OR failure_reason IS NULL)",
        update('deliveries', { failure_kind: 'session-closed', failure_reason: null }, message)
      )
      R(
        "deliveries CHECK (failure_kind NOT IN ('session-closed', 'host-interrupted') OR failure_reason IS NULL)",
        update('deliveries', { failure_reason: 'gone' }, message)
      )
    })

    it('[ADR-010] deliveries_match_message: a delivery stores only for a person or answers-record message of its own dwarf and kind; a mismatched kind, dwarf or role is rejected on insert and on update', () => {
      const ownDwarfReply = newId()
      put(
        insert('messages', {
          id: ownDwarfReply,
          role: 'dwarf',
          origin: 'transcript',
          source_key: 'transcript:7'
        })
      )
      T('trigger deliveries_match_message', insert('deliveries'))
      T(
        'trigger deliveries_match_message',
        insert('deliveries', { message_id: ANSWERS_MESSAGE, kind: 'answers-record' })
      )
      put(remove('deliveries', { message_id: ANSWERS_MESSAGE }))
      R('trigger deliveries_match_message', insert('deliveries', { message_id: ANSWERS_MESSAGE }))
      R(
        'trigger deliveries_match_message',
        insert('deliveries', {
          message_id: ANSWERS_MESSAGE,
          dwarf_id: DWARF2,
          kind: 'answers-record'
        })
      )
      R('trigger deliveries_match_message', insert('deliveries', { message_id: ownDwarfReply }))

      const key = { message_id: MESSAGE }
      T(
        'trigger deliveries_match_message_update',
        update('deliveries', { phase: 'delivered' }, key)
      )
      T(
        'trigger deliveries_match_message_update',
        update('deliveries', { kind: 'message', dwarf_id: DWARF }, key)
      )
      R(
        'trigger deliveries_match_message_update',
        update('deliveries', { kind: 'answers-record' }, key)
      )
      R('trigger deliveries_match_message_update', update('deliveries', { dwarf_id: DWARF2 }, key))
      R(
        'trigger deliveries_match_message_update',
        update('deliveries', { message_id: ANSWERS_MESSAGE }, key)
      )
    })

    it('[ADR-005] deliveries: removing the message or the dwarf removes the delivery; a delivery cannot keep a message or a dwarf id that no longer exists', () => {
      put(insert('deliveries'))
      R('fk deliveries.message_id → messages', update('messages', { id: newId() }, { id: MESSAGE }))
      T('fk deliveries.message_id → messages', remove('messages', { id: MESSAGE }))
      expect(value('SELECT count(*) FROM deliveries')).toBe(0)

      // A delivery whose dwarf is the only remaining reference to that dwarf: the message moves to
      // another dwarf afterwards (messages carry no trigger), so renaming the dwarf's id breaks
      // only deliveries.dwarf_id. An orphan insert cannot reach the FK: the trigger answers first.
      const message = newId()
      put(
        insert('messages', { id: message, dwarf_id: DWARF2 }),
        insert('deliveries', { message_id: message, dwarf_id: DWARF2 }),
        update('messages', { dwarf_id: DWARF }, { id: message })
      )
      R('fk deliveries.dwarf_id → dwarfs', update('dwarfs', { id: newId() }, { id: DWARF2 }))
      T('fk deliveries.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM deliveries WHERE message_id = ?', [message])).toBe(0)
      expect(value('SELECT count(*) FROM messages WHERE id = ?', [message])).toBe(1)
    })

    it('[ADR-005] activity_disclosures: one open disclosure per dwarf and one per turn; flags, counts and JSON out of range, a short id and an open disclosure with a closing instant are rejected; it goes with its dwarf', () => {
      const open = { open: 1, closed_at: null }
      const quiet = newId()
      put(insert('dwarfs', { id: quiet }))
      T('index activity_disclosures_one_open', insert('activity_disclosures', open))
      T(
        'index activity_disclosures_one_open',
        insert('activity_disclosures', { ...open, dwarf_id: DWARF2 })
      )
      R('index activity_disclosures_one_open', insert('activity_disclosures', open))
      T(
        'activity_disclosures UNIQUE (dwarf_id, turn_key)',
        insert('activity_disclosures', { turn_key: 'turn-a' })
      )
      R(
        'activity_disclosures UNIQUE (dwarf_id, turn_key)',
        insert('activity_disclosures', { turn_key: 'turn-a' })
      )
      T(
        'activity_disclosures CHECK ((open = 1) = (closed_at IS NULL))',
        insert('activity_disclosures')
      )
      R(
        'activity_disclosures CHECK ((open = 1) = (closed_at IS NULL))',
        insert('activity_disclosures', { dwarf_id: quiet, open: 1 })
      )
      R(
        'activity_disclosures CHECK ((open = 1) = (closed_at IS NULL))',
        insert('activity_disclosures', { closed_at: null })
      )
      T('activity_disclosures.open CHECK', insert('activity_disclosures', { open: 0 }))
      R('activity_disclosures.open CHECK', insert('activity_disclosures', { open: 2 }))
      T('activity_disclosures.step_count CHECK', insert('activity_disclosures', { step_count: 3 }))
      R('activity_disclosures.step_count CHECK', insert('activity_disclosures', { step_count: -1 }))
      T(
        'activity_disclosures.summaries_json CHECK',
        insert('activity_disclosures', { summaries_json: '["read"]' })
      )
      R(
        'activity_disclosures.summaries_json CHECK',
        insert('activity_disclosures', { summaries_json: 'x' })
      )
      T('activity_disclosures.id CHECK', insert('activity_disclosures', { id: newId() }))
      R('activity_disclosures.id CHECK', insert('activity_disclosures', { id: ID_35 }))
      T('fk activity_disclosures.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM activity_disclosures WHERE dwarf_id = ?', [DWARF2])).toBe(
        0
      )
      R(
        'fk activity_disclosures.dwarf_id → dwarfs',
        insert('activity_disclosures', { dwarf_id: GHOST })
      )
    })

    it('[ADR-005] outcome_lines: a line with up to three parts stores and goes with its dwarf; four parts, a negative count, an unknown reliability and a missing dwarf are rejected', () => {
      T('outcome_lines.parts_json CHECK', insert('outcome_lines', { parts_json: '["a","b","c"]' }))
      R(
        'outcome_lines.parts_json CHECK',
        insert('outcome_lines', { dwarf_id: DWARF2, parts_json: '["a","b","c","d"]' })
      )
      for (const reliability of ['reliable', 'inferred']) {
        T(
          'outcome_lines.reliability CHECK',
          update('outcome_lines', { reliability }, { dwarf_id: DWARF })
        )
      }
      R(
        'outcome_lines.reliability CHECK',
        update('outcome_lines', { reliability: 'guessed' }, { dwarf_id: DWARF })
      )
      T(
        'outcome_lines.step_count CHECK',
        update('outcome_lines', { step_count: 4 }, { dwarf_id: DWARF })
      )
      R(
        'outcome_lines.step_count CHECK',
        update('outcome_lines', { step_count: -1 }, { dwarf_id: DWARF })
      )
      T('fk outcome_lines.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF }))
      expect(value('SELECT count(*) FROM outcome_lines')).toBe(0)
      R('fk outcome_lines.dwarf_id → dwarfs', insert('outcome_lines', { dwarf_id: GHOST }))
    })
  })

  describe('09 §4.5 asking and attention', () => {
    it('[ADR-010] asks: each kind, channel and state stores with its own fields; unknown values, invalid JSON, a negative step, a short id and flags outside 0/1 are rejected', () => {
      for (const kind of ['question', 'permission']) T('asks.kind CHECK', insert('asks', { kind }))
      R('asks.kind CHECK', insert('asks', { kind: 'poll' }))
      for (const channel of ['driver', 'hook-keystroke', 'hook-decision', 'http', 'none']) {
        T('asks.channel CHECK', insert('asks', { channel }))
      }
      R('asks.channel CHECK', insert('asks', { channel: 'email' }))
      const states: readonly Row[] = [
        { state: 'open' },
        { state: 'answering', dwarf_id: DWARF2 },
        { state: 'answered-in-app', closed_at: 2 },
        { state: 'answered-elsewhere', closed_at: 2 },
        { state: 'cancelled', closed_at: 2 },
        { state: 'closed-by-death', closed_at: 2 },
        { state: 'auto-denied', closed_at: 2 }
      ]
      for (const state of states) T('asks.state CHECK', insert('asks', state))
      R('asks.state CHECK', insert('asks', { state: 'expired', closed_at: 2 }))
      T('asks.payload_json CHECK', insert('asks', { payload_json: '{"question":"Proceed?"}' }))
      R('asks.payload_json CHECK', insert('asks', { payload_json: 'x' }))
      T('asks.current_step CHECK', insert('asks', { current_step: 2 }))
      R('asks.current_step CHECK', insert('asks', { current_step: -1 }))
      T('asks.reannounce CHECK', insert('asks', { reannounce: 0 }))
      R('asks.reannounce CHECK', insert('asks', { reannounce: 2 }))
      T('asks.id CHECK', insert('asks', { id: newId() }))
      R('asks.id CHECK', insert('asks', { id: ID_35 }))
    })

    it('[ADR-010] asks: one answering ask per dwarf and one ask per provider request; a live ask with a closing instant, a closed one without it and an answer through channel none are rejected', () => {
      const quiet = newId()
      put(insert('dwarfs', { id: quiet }))
      T('index asks_one_answering', insert('asks', { state: 'answering' }))
      T('index asks_one_answering', insert('asks', { state: 'answering', dwarf_id: DWARF2 }))
      R('index asks_one_answering', insert('asks', { state: 'answering' }))
      const request = String(value('SELECT provider_request_id FROM asks WHERE id = ?', [ASK]))
      T(
        'asks UNIQUE (dwarf_id, provider_request_id)',
        insert('asks', { dwarf_id: DWARF2, provider_request_id: request })
      )
      R(
        'asks UNIQUE (dwarf_id, provider_request_id)',
        insert('asks', { provider_request_id: request })
      )
      T(
        "asks CHECK ((state IN ('open', 'answering')) = (closed_at IS NULL))",
        insert('asks', { state: 'cancelled', closed_at: 3 })
      )
      R(
        "asks CHECK ((state IN ('open', 'answering')) = (closed_at IS NULL))",
        insert('asks', { closed_at: 3 })
      )
      R(
        "asks CHECK ((state IN ('open', 'answering')) = (closed_at IS NULL))",
        insert('asks', { state: 'cancelled' })
      )
      T(
        "asks CHECK (channel <> 'none' OR state NOT IN ('answering', 'answered-in-app'))",
        insert('asks', { channel: 'none', state: 'answered-elsewhere', closed_at: 3 })
      )
      R(
        "asks CHECK (channel <> 'none' OR state NOT IN ('answering', 'answered-in-app'))",
        insert('asks', { channel: 'none', state: 'answering', dwarf_id: quiet })
      )
      R(
        "asks CHECK (channel <> 'none' OR state NOT IN ('answering', 'answered-in-app'))",
        insert('asks', { channel: 'none', state: 'answered-in-app', closed_at: 3 })
      )
    })

    it('[ADR-005] asks: the asks of a removed dwarf go with it; an ask for a missing dwarf is rejected', () => {
      put(insert('asks', { dwarf_id: DWARF2 }))
      T('fk asks.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM asks WHERE dwarf_id = ?', [DWARF2])).toBe(0)
      R('fk asks.dwarf_id → dwarfs', insert('asks', { dwarf_id: GHOST }))
    })

    it('[ADR-010] a second answers-record message for one ask is rejected; ask_answers stores refusal_reason ask-closed', () => {
      T(
        'index messages_one_record_per_ask',
        insert('messages', { role: 'answers-record', ask_id: ASK })
      )
      R(
        'index messages_one_record_per_ask',
        insert('messages', { role: 'answers-record', ask_id: ASK })
      )
      T(
        'ask_answers.refusal_reason CHECK',
        insert('ask_answers', { outcome: 'refused', refusal_reason: 'ask-closed', settled_at: 2 })
      )
    })

    it('[ADR-010] ask_answers: each outcome and refusal reason stores settled; unknown values, a refusal without a reason, a reason without a refusal, a reason before the outcome and an outcome without its settle instant are rejected', () => {
      const outcomes: readonly Row[] = [
        { outcome: 'accepted' },
        { outcome: 'refused', refusal_reason: 'invalid-answer' }
      ]
      for (const outcome of outcomes) {
        T('ask_answers.outcome CHECK', insert('ask_answers', { ...outcome, settled_at: 2 }))
      }
      R('ask_answers.outcome CHECK', insert('ask_answers', { outcome: 'maybe', settled_at: 2 }))
      for (const reason of [
        'channel-rejected',
        'invalid-answer',
        'channel-unavailable',
        'ask-closed'
      ]) {
        T(
          'ask_answers.refusal_reason CHECK',
          insert('ask_answers', { outcome: 'refused', refusal_reason: reason, settled_at: 2 })
        )
      }
      R(
        'ask_answers.refusal_reason CHECK',
        insert('ask_answers', { outcome: 'refused', refusal_reason: 'late', settled_at: 2 })
      )
      T(
        "ask_answers CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL))",
        insert('ask_answers', {
          outcome: 'refused',
          refusal_reason: 'channel-rejected',
          settled_at: 2
        })
      )
      R(
        "ask_answers CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL))",
        insert('ask_answers', { outcome: 'refused', settled_at: 2 })
      )
      R(
        "ask_answers CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL))",
        insert('ask_answers', { outcome: 'accepted', refusal_reason: 'ask-closed', settled_at: 2 })
      )
      T('ask_answers CHECK (outcome IS NOT NULL OR refusal_reason IS NULL)', insert('ask_answers'))
      R(
        'ask_answers CHECK (outcome IS NOT NULL OR refusal_reason IS NULL)',
        insert('ask_answers', { refusal_reason: 'ask-closed' })
      )
      T(
        'ask_answers CHECK ((outcome IS NULL) = (settled_at IS NULL))',
        insert('ask_answers', { outcome: 'accepted', settled_at: 2 })
      )
      R(
        'ask_answers CHECK ((outcome IS NULL) = (settled_at IS NULL))',
        insert('ask_answers', { outcome: 'accepted' })
      )
      R(
        'ask_answers CHECK ((outcome IS NULL) = (settled_at IS NULL))',
        insert('ask_answers', { settled_at: 2 })
      )
    })

    it('[ADR-010] ask_answers: an answer goes with its ask and outlives its answers record; a missing ask or message is rejected', () => {
      const answer = 'answer-linked'
      T(
        'fk ask_answers.message_id → messages',
        insert('ask_answers', { request_id: answer, message_id: ANSWERS_MESSAGE })
      )
      put(remove('messages', { id: ANSWERS_MESSAGE }))
      expect(value('SELECT message_id FROM ask_answers WHERE request_id = ?', [answer])).toBeNull()
      R('fk ask_answers.message_id → messages', insert('ask_answers', { message_id: GHOST }))
      T('fk ask_answers.ask_id → asks', remove('asks', { id: ASK }))
      expect(value('SELECT count(*) FROM ask_answers')).toBe(0)
      R('fk ask_answers.ask_id → asks', insert('ask_answers', { ask_id: GHOST }))
    })

    it("[ADR-018] attention_keys: kind 'turn-finished' with suppressed = 1 stores and an ask key names its ask; 'finished', a flag outside 0/1, a turn key with an ask and an ask key without one are rejected", () => {
      T(
        'attention_keys.kind CHECK',
        insert('attention_keys', { kind: 'turn-finished', suppressed: 1 })
      )
      for (const kind of ['question', 'permission']) {
        T('attention_keys.kind CHECK', insert('attention_keys', { kind, ask_id: ASK }))
      }
      R('attention_keys.kind CHECK', insert('attention_keys', { kind: 'finished' }))
      T('attention_keys.suppressed CHECK', insert('attention_keys', { suppressed: 1 }))
      R('attention_keys.suppressed CHECK', insert('attention_keys', { suppressed: 2 }))
      T(
        "attention_keys CHECK ((kind = 'turn-finished') = (ask_id IS NULL))",
        insert('attention_keys', { kind: 'question', ask_id: ASK })
      )
      R(
        "attention_keys CHECK ((kind = 'turn-finished') = (ask_id IS NULL))",
        insert('attention_keys', { ask_id: ASK })
      )
      R(
        "attention_keys CHECK ((kind = 'turn-finished') = (ask_id IS NULL))",
        insert('attention_keys', { kind: 'permission' })
      )
    })

    it('[ADR-018] attention_keys and attention_announced: a closed ask with a live key deletes cleanly; keys and announcements go with their dwarf; missing references and an announced turn kind are rejected', () => {
      put(insert('attention_keys', { kind: 'question', ask_id: ASK }))
      T('fk attention_keys.ask_id → asks', remove('asks', { id: ASK }))
      expect(value('SELECT count(*) FROM attention_keys')).toBe(0)
      R(
        'fk attention_keys.ask_id → asks',
        insert('attention_keys', { kind: 'question', ask_id: GHOST })
      )
      put(insert('attention_keys', { dwarf_id: DWARF2 }))
      T('fk attention_keys.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM attention_keys')).toBe(0)
      R('fk attention_keys.dwarf_id → dwarfs', insert('attention_keys', { dwarf_id: GHOST }))

      for (const kind of ['question', 'permission']) {
        T('attention_announced.kind CHECK', insert('attention_announced', { kind }))
      }
      R('attention_announced.kind CHECK', insert('attention_announced', { kind: 'turn-finished' }))
      T('fk attention_announced.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF }))
      expect(value('SELECT count(*) FROM attention_announced')).toBe(0)
      R(
        'fk attention_announced.dwarf_id → dwarfs',
        insert('attention_announced', { dwarf_id: GHOST })
      )
    })
  })

  describe('09 §4.6 delegation', () => {
    it('[ADR-013] delegations: each state, failure and handoff value stores with its own fields; unknown values, texts over their caps and a short id are rejected', () => {
      T('delegations.id CHECK', insert('delegations', { id: newId() }))
      R('delegations.id CHECK', insert('delegations', { id: ID_35 }))
      T('delegations.task_text CHECK', insert('delegations', { task_text: 'x'.repeat(4000) }))
      R('delegations.task_text CHECK', insert('delegations', { task_text: 'x'.repeat(4001) }))
      T(
        'delegations.context_text CHECK',
        insert('delegations', { context_text: 'x'.repeat(16000) })
      )
      R(
        'delegations.context_text CHECK',
        insert('delegations', { context_text: 'x'.repeat(16001) })
      )
      const delivered = {
        handoff_via: 'tool-result',
        handoff_phase: 'delivered',
        handoff_phase_at: 4
      }
      const states: readonly Row[] = [
        { state: 'attempted' },
        { state: 'running' },
        { state: 'succeeded', settled_at: 5, ...delivered },
        { state: 'failed', failure: 'worker-failed', settled_at: 5 }
      ]
      for (const state of states) T('delegations.state CHECK', insert('delegations', state))
      R('delegations.state CHECK', insert('delegations', { state: 'queued' }))
      for (const failure of [
        'gate-closed',
        'jev-unreachable',
        'jev-could-not-choose',
        'no-provider',
        'worker-failed',
        'worker-lost',
        'parent-gone'
      ]) {
        T(
          'delegations.failure CHECK',
          insert('delegations', { state: 'failed', failure, settled_at: 5 })
        )
      }
      T(
        'delegations.failure CHECK',
        insert('delegations', {
          state: 'failed',
          failure: 'handoff-failed',
          settled_at: 5,
          handoff_via: 'turn-input',
          handoff_phase: 'failed',
          handoff_phase_at: 4
        })
      )
      R(
        'delegations.failure CHECK',
        insert('delegations', { state: 'failed', failure: 'oops', settled_at: 5 })
      )
      for (const via of ['tool-result', 'turn-input']) {
        T(
          'delegations.handoff_via CHECK',
          insert('delegations', { ...delivered, state: 'running', handoff_via: via })
        )
      }
      R(
        'delegations.handoff_via CHECK',
        insert('delegations', { ...delivered, handoff_via: 'email' })
      )
      for (const phase of ['sending', 'delivered', 'failed']) {
        T(
          'delegations.handoff_phase CHECK',
          insert('delegations', { ...delivered, handoff_phase: phase })
        )
      }
      R(
        'delegations.handoff_phase CHECK',
        insert('delegations', { ...delivered, handoff_phase: 'lost' })
      )
    })

    it('[ADR-013] delegations: the handoff CHECKs hold the three handoff fields together, a succeeded delegation delivered and settled texts cleared; each broken pairing is rejected', () => {
      const delivered = {
        handoff_via: 'tool-result',
        handoff_phase: 'delivered',
        handoff_phase_at: 4
      }
      T(
        "delegations CHECK ((state = 'failed') = (failure IS NOT NULL))",
        insert('delegations', { state: 'failed', failure: 'no-provider', settled_at: 5 })
      )
      R(
        "delegations CHECK ((state = 'failed') = (failure IS NOT NULL))",
        insert('delegations', { state: 'failed', settled_at: 5 })
      )
      R(
        "delegations CHECK ((state = 'failed') = (failure IS NOT NULL))",
        insert('delegations', { failure: 'no-provider' })
      )
      T(
        "delegations CHECK ((state IN ('succeeded', 'failed')) = (settled_at IS NOT NULL))",
        insert('delegations', { state: 'succeeded', settled_at: 5, ...delivered })
      )
      R(
        "delegations CHECK ((state IN ('succeeded', 'failed')) = (settled_at IS NOT NULL))",
        insert('delegations', { state: 'succeeded', ...delivered })
      )
      R(
        "delegations CHECK ((state IN ('succeeded', 'failed')) = (settled_at IS NOT NULL))",
        insert('delegations', { settled_at: 5 })
      )
      T(
        'delegations CHECK ((handoff_via IS NULL) = (handoff_phase IS NULL) AND (handoff_phase IS NULL) = (handoff_phase_at IS NULL))',
        insert('delegations', { state: 'running', ...delivered })
      )
      R(
        'delegations CHECK ((handoff_via IS NULL) = (handoff_phase IS NULL) AND (handoff_phase IS NULL) = (handoff_phase_at IS NULL))',
        insert('delegations', { handoff_via: 'tool-result' })
      )
      R(
        'delegations CHECK ((handoff_via IS NULL) = (handoff_phase IS NULL) AND (handoff_phase IS NULL) = (handoff_phase_at IS NULL))',
        insert('delegations', { handoff_via: 'tool-result', handoff_phase: 'sending' })
      )
      T(
        "delegations CHECK (state <> 'succeeded' OR handoff_phase IS 'delivered')",
        insert('delegations', { state: 'succeeded', settled_at: 5, ...delivered })
      )
      R(
        "delegations CHECK (state <> 'succeeded' OR handoff_phase IS 'delivered')",
        insert('delegations', {
          state: 'succeeded',
          settled_at: 5,
          ...delivered,
          handoff_phase: 'sending'
        })
      )
      R(
        "delegations CHECK (state <> 'succeeded' OR handoff_phase IS 'delivered')",
        insert('delegations', { state: 'succeeded', settled_at: 5 })
      )
      T(
        "delegations CHECK (state IN ('attempted', 'running') OR (task_text IS NULL AND context_text IS NULL))",
        insert('delegations', {
          state: 'running',
          task_text: 'Review the diff',
          context_text: 'PR 12'
        })
      )
      R(
        "delegations CHECK (state IN ('attempted', 'running') OR (task_text IS NULL AND context_text IS NULL))",
        insert('delegations', {
          state: 'failed',
          failure: 'worker-lost',
          settled_at: 5,
          task_text: 'Review the diff'
        })
      )
      T(
        'delegations CHECK (worker_dwarf_id IS NULL OR worker_dwarf_id <> parent_dwarf_id)',
        insert('delegations', { worker_dwarf_id: DWARF2 })
      )
      R(
        'delegations CHECK (worker_dwarf_id IS NULL OR worker_dwarf_id <> parent_dwarf_id)',
        insert('delegations', { worker_dwarf_id: DWARF })
      )
    })

    it('[ADR-013] delegations: one delegation per worker and per ticket; removing the parent removes it and removing the worker clears the link; missing dwarfs are rejected', () => {
      const delegation = newId()
      T(
        'delegations UNIQUE (worker_dwarf_id)',
        insert('delegations', { id: delegation, worker_dwarf_id: DWARF2 })
      )
      R('delegations UNIQUE (worker_dwarf_id)', insert('delegations', { worker_dwarf_id: DWARF2 }))
      T('delegations UNIQUE (ticket)', insert('delegations', { ticket: 'ticket-a' }))
      R('delegations UNIQUE (ticket)', insert('delegations', { ticket: 'ticket-a' }))
      T('fk delegations.worker_dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT worker_dwarf_id FROM delegations WHERE id = ?', [delegation])).toBeNull()
      R(
        'fk delegations.worker_dwarf_id → dwarfs',
        insert('delegations', { worker_dwarf_id: GHOST })
      )
      T('fk delegations.parent_dwarf_id → dwarfs', remove('dwarfs', { id: DWARF }))
      expect(value('SELECT count(*) FROM delegations')).toBe(0)
      R(
        'fk delegations.parent_dwarf_id → dwarfs',
        insert('delegations', { parent_dwarf_id: GHOST })
      )
    })

    it('[ADR-013] delegation_tokens: each mechanism stores, a ticket file with its 64-character credential hash; an unknown mechanism, a short hash, a ticket file without a hash and a hash on another mechanism are rejected; a token goes with its launch or its parent', () => {
      put(insert('delegation_tokens'))
      const key = { launch_id: LAUNCH }
      for (const mechanism of ['in-process', 'protocol']) {
        T('delegation_tokens.mechanism CHECK', update('delegation_tokens', { mechanism }, key))
      }
      R('delegation_tokens.mechanism CHECK', update('delegation_tokens', { mechanism: 'env' }, key))
      T(
        "delegation_tokens CHECK ((mechanism = 'ticket-file') = (credential_hash IS NOT NULL))",
        update('delegation_tokens', { mechanism: 'ticket-file', credential_hash: hex64(9) }, key)
      )
      R(
        "delegation_tokens CHECK ((mechanism = 'ticket-file') = (credential_hash IS NOT NULL))",
        update('delegation_tokens', { credential_hash: null }, key)
      )
      R(
        "delegation_tokens CHECK ((mechanism = 'ticket-file') = (credential_hash IS NOT NULL))",
        update('delegation_tokens', { mechanism: 'protocol' }, key)
      )
      T(
        'delegation_tokens.credential_hash CHECK',
        update('delegation_tokens', { credential_hash: hex64(10) }, key)
      )
      R(
        'delegation_tokens.credential_hash CHECK',
        update('delegation_tokens', { credential_hash: 'abc' }, key)
      )

      R(
        'fk delegation_tokens.launch_id → launches',
        insert('delegation_tokens', { launch_id: GHOST })
      )
      T('fk delegation_tokens.launch_id → launches', remove('launches', { id: LAUNCH }))
      expect(value('SELECT count(*) FROM delegation_tokens')).toBe(0)
      const launch = newId()
      const spare = newId()
      put(
        insert('launches', { id: launch }),
        insert('launches', { id: spare }),
        insert('delegation_tokens', { launch_id: launch, parent_dwarf_id: DWARF2 })
      )
      R(
        'fk delegation_tokens.parent_dwarf_id → dwarfs',
        insert('delegation_tokens', { launch_id: spare, parent_dwarf_id: GHOST })
      )
      T('fk delegation_tokens.parent_dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM delegation_tokens')).toBe(0)
    })
  })

  describe('09 §4.7 ledger', () => {
    it('[ADR-006] usage_units: a sealed unit stores with its instant; a seal flag outside 0/1 and a seal without its instant are rejected; a unit goes with its mine or its dwarf', () => {
      T('usage_units.sealed CHECK', insert('usage_units', { sealed: 1, sealed_at: 3 }))
      R('usage_units.sealed CHECK', insert('usage_units', { sealed: 2 }))
      T(
        'usage_units CHECK ((sealed = 1) = (sealed_at IS NOT NULL))',
        insert('usage_units', { sealed: 1, sealed_at: 3 })
      )
      R(
        'usage_units CHECK ((sealed = 1) = (sealed_at IS NOT NULL))',
        insert('usage_units', { sealed: 1 })
      )
      R(
        'usage_units CHECK ((sealed = 1) = (sealed_at IS NOT NULL))',
        insert('usage_units', { sealed_at: 3 })
      )
      R('fk usage_units.mine_id → mines', insert('usage_units', { mine_id: GHOST }))
      R('fk usage_units.dwarf_id → dwarfs', insert('usage_units', { dwarf_id: GHOST }))
      const mine = newId()
      put(insert('mines', { id: mine }), insert('usage_units', { mine_id: mine }))
      T('fk usage_units.mine_id → mines', remove('mines', { id: mine }))
      expect(value('SELECT count(*) FROM usage_units WHERE mine_id = ?', [mine])).toBe(0)
      put(insert('usage_units', { dwarf_id: DWARF2 }))
      T('fk usage_units.dwarf_id → dwarfs', remove('dwarfs', { id: DWARF2 }))
      expect(value('SELECT count(*) FROM usage_units WHERE dwarf_id = ?', [DWARF2])).toBe(0)
    })

    it('[ADR-006] usage_observations: each path, fidelity and count stores; an unknown path, fidelity 3, negative counts and a seal flag outside 0/1 are rejected; an observation goes with its unit', () => {
      for (const path of ['driver', 'transcript'])
        T('usage_observations.path CHECK', insert('usage_observations', { path }))
      R('usage_observations.path CHECK', insert('usage_observations', { path: 'hook' }))
      for (const fidelity of [0, 1, 2]) {
        T('usage_observations.fidelity CHECK', insert('usage_observations', { fidelity }))
      }
      R('usage_observations.fidelity CHECK', insert('usage_observations', { fidelity: 3 }))
      T('usage_observations.input_net CHECK', insert('usage_observations', { input_net: 5 }))
      R('usage_observations.input_net CHECK', insert('usage_observations', { input_net: -1 }))
      T('usage_observations.output CHECK', insert('usage_observations', { output: 5 }))
      R('usage_observations.output CHECK', insert('usage_observations', { output: -1 }))
      T('usage_observations.cache_read CHECK', insert('usage_observations', { cache_read: 5 }))
      R('usage_observations.cache_read CHECK', insert('usage_observations', { cache_read: -1 }))
      T('usage_observations.cache_write CHECK', insert('usage_observations', { cache_write: 5 }))
      R('usage_observations.cache_write CHECK', insert('usage_observations', { cache_write: -1 }))
      T('usage_observations.reasoning CHECK', insert('usage_observations', { reasoning: 5 }))
      R('usage_observations.reasoning CHECK', insert('usage_observations', { reasoning: -1 }))
      T('usage_observations.sealed CHECK', insert('usage_observations', { sealed: 1 }))
      R('usage_observations.sealed CHECK', insert('usage_observations', { sealed: 2 }))
      R(
        'fk usage_observations.unit_key → usage_units',
        insert('usage_observations', { unit_key: 'usage-unknown' })
      )
      T(
        'fk usage_observations.unit_key → usage_units',
        remove('usage_units', { unit_key: USAGE_UNIT })
      )
      expect(value('SELECT count(*) FROM usage_observations')).toBe(0)
    })

    it('[INV-93] ledger_entries: coal with kind live is rejected; an update of a ledger entry is rejected; material_totals equals SUM(ledger_entries) after inserts and deletes', () => {
      const totals = (): SqliteRow[] =>
        rows(
          'SELECT material, tokens, units FROM material_totals WHERE mine_id = ? ORDER BY material',
          [MINE]
        )
      const sums = (): SqliteRow[] =>
        rows(
          'SELECT material, sum(tokens) AS tokens, sum(units) AS units FROM ledger_entries WHERE mine_id = ? GROUP BY material ORDER BY material',
          [MINE]
        )
      T(
        "ledger_entries CHECK ((kind = 'coal-backfill') = (material = 'coal'))",
        insert('ledger_entries', { material: 'coal', kind: 'coal-backfill', tokens: 7 })
      )
      R(
        "ledger_entries CHECK ((kind = 'coal-backfill') = (material = 'coal'))",
        insert('ledger_entries', { material: 'coal', kind: 'live' })
      )
      R(
        "ledger_entries CHECK ((kind = 'coal-backfill') = (material = 'coal'))",
        insert('ledger_entries', { material: 'gold', kind: 'coal-backfill' })
      )

      const first = newId()
      T(
        'trigger ledger_entries_accumulate',
        insert('ledger_entries', { id: first, tokens: 10, units: 1 })
      )
      T('trigger ledger_entries_accumulate', insert('ledger_entries', { tokens: 25, units: 2 }))
      T(
        'trigger ledger_entries_accumulate',
        insert('ledger_entries', { material: 'gold', tokens: 4, units: 1 })
      )
      expect(totals()).toEqual(sums())
      expect(totals()).toEqual([
        { material: 'bronze', tokens: 35, units: 3 },
        { material: 'coal', tokens: 7, units: 1 },
        { material: 'gold', tokens: 4, units: 1 }
      ])

      R('trigger ledger_entries_immutable', update('ledger_entries', { tokens: 99 }, { id: first }))
      // Even an update that changes nothing is refused: the trigger guards the row, not the values.
      R('trigger ledger_entries_immutable', {
        sql: 'UPDATE ledger_entries SET tokens = tokens WHERE id = ?',
        params: [first]
      })
      T('trigger ledger_entries_withdraw', remove('ledger_entries', { id: first }))
      expect(totals()).toEqual(sums())
      expect(totals()).toContainEqual({ material: 'bronze', tokens: 25, units: 2 })
      T('trigger ledger_entries_immutable', remove('ledger_entries', { material: 'gold' }))
      expect(totals()).toContainEqual({ material: 'gold', tokens: 0, units: 0 })
    })

    it('[INV-93] ledger_entries: an insert that fails part-way adds nothing to material_totals; a withdrawal that would drive a total below zero is rejected and keeps the entry', () => {
      put(insert('ledger_entries', { unit_key: 'ledger-a', tokens: 10, units: 1 }))
      R(
        'trigger ledger_entries_accumulate',
        insertRows('ledger_entries', [
          { unit_key: 'ledger-b', tokens: 5, units: 1 },
          { unit_key: 'ledger-a', tokens: 5, units: 1 }
        ]),
        'UNIQUE constraint failed: ledger_entries.unit_key'
      )
      expect(rows("SELECT tokens, units FROM material_totals WHERE material = 'bronze'")).toEqual([
        { tokens: 10, units: 1 }
      ])
      put("UPDATE material_totals SET tokens = 4 WHERE material = 'bronze'")
      R(
        'trigger ledger_entries_withdraw',
        remove('ledger_entries', { unit_key: 'ledger-a' }),
        'CHECK constraint failed: tokens >= 0'
      )
      expect(value("SELECT count(*) FROM ledger_entries WHERE unit_key = 'ledger-a'")).toBe(1)
    })

    it('[ADR-006] ledger_entries: each material and kind stores, coal only by the backfill; unknown values, negative amounts, a repeated unit key, a short id and a missing mine are rejected; entries and totals go with their mine', () => {
      T(
        'ledger_entries.material CHECK',
        insert('ledger_entries', { material: 'coal', kind: 'coal-backfill' })
      )
      for (const material of ['bronze', 'copper', 'silver', 'gold', 'uranium']) {
        T('ledger_entries.material CHECK', insert('ledger_entries', { material }))
      }
      R('ledger_entries.material CHECK', insert('ledger_entries', { material: 'iron' }))
      T('ledger_entries.kind CHECK', insert('ledger_entries', { kind: 'live' }))
      R('ledger_entries.kind CHECK', insert('ledger_entries', { kind: 'bonus' }))
      T('ledger_entries.tokens CHECK', insert('ledger_entries', { tokens: 0 }))
      R('ledger_entries.tokens CHECK', insert('ledger_entries', { tokens: -1 }))
      T('ledger_entries.units CHECK', insert('ledger_entries', { units: 0 }))
      R('ledger_entries.units CHECK', insert('ledger_entries', { units: -1 }))
      T('ledger_entries UNIQUE (unit_key)', insert('ledger_entries', { unit_key: 'ledger-x' }))
      R('ledger_entries UNIQUE (unit_key)', insert('ledger_entries', { unit_key: 'ledger-x' }))
      T('ledger_entries.id CHECK', insert('ledger_entries', { id: newId() }))
      R('ledger_entries.id CHECK', insert('ledger_entries', { id: ID_35 }))
      R('fk ledger_entries.mine_id → mines', insert('ledger_entries', { mine_id: GHOST }))
      const mine = newId()
      put(insert('mines', { id: mine }), insert('ledger_entries', { mine_id: mine }))
      T('fk ledger_entries.mine_id → mines', remove('mines', { id: mine }))
      expect(value('SELECT count(*) FROM ledger_entries WHERE mine_id = ?', [mine])).toBe(0)
      expect(value('SELECT count(*) FROM material_totals WHERE mine_id = ?', [mine])).toBe(0)
    })

    it('[ADR-006] material_totals: a total per mine and material stores; an unknown material, negative amounts and a missing mine are rejected; totals go with their mine', () => {
      T('material_totals.material CHECK', insert('material_totals', { material: 'uranium' }))
      R('material_totals.material CHECK', insert('material_totals', { material: 'iron' }))
      T(
        'material_totals.tokens CHECK',
        insert('material_totals', { material: 'copper', tokens: 3 })
      )
      R('material_totals.tokens CHECK', insert('material_totals', { material: 'gold', tokens: -1 }))
      T('material_totals.units CHECK', insert('material_totals', { material: 'gold', units: 3 }))
      R('material_totals.units CHECK', insert('material_totals', { material: 'bronze', units: -1 }))
      R('fk material_totals.mine_id → mines', insert('material_totals', { mine_id: GHOST }))
      const mine = newId()
      put(insert('mines', { id: mine }))
      T('fk material_totals.mine_id → mines', insert('material_totals', { mine_id: mine }))
      put(remove('mines', { id: mine }))
      expect(value('SELECT count(*) FROM material_totals WHERE mine_id = ?', [mine])).toBe(0)
    })
  })

  describe('09 §4.8 preferences and local trust', () => {
    it('[ADR-005] host_preferences: the single row keeps id 1; each routing profile and flag stores; a default model or effort without a provider and unknown values are rejected', () => {
      T('host_preferences.id CHECK', update('host_preferences', { id: 1 }, { id: 1 }))
      R('host_preferences.id CHECK', insert('host_preferences', { id: 2 }))
      for (const profile of ['economy', 'balanced', 'premium']) {
        T(
          'host_preferences.routing_profile CHECK',
          update('host_preferences', { routing_profile: profile }, { id: 1 })
        )
      }
      R(
        'host_preferences.routing_profile CHECK',
        update('host_preferences', { routing_profile: 'cheap' }, { id: 1 })
      )
      T(
        'host_preferences.subagent_delegation_on CHECK',
        update('host_preferences', { subagent_delegation_on: 1 }, { id: 1 })
      )
      R(
        'host_preferences.subagent_delegation_on CHECK',
        update('host_preferences', { subagent_delegation_on: 2 }, { id: 1 })
      )
      T(
        'host_preferences.system_notifications_on CHECK',
        update('host_preferences', { system_notifications_on: 0 }, { id: 1 })
      )
      R(
        'host_preferences.system_notifications_on CHECK',
        update('host_preferences', { system_notifications_on: 2 }, { id: 1 })
      )
      T(
        'host_preferences CHECK (default_provider IS NOT NULL OR (default_model IS NULL AND default_effort IS NULL))',
        update(
          'host_preferences',
          { default_provider: 'provider-a', default_model: 'model-a', default_effort: 'high' },
          { id: 1 }
        )
      )
      R(
        'host_preferences CHECK (default_provider IS NOT NULL OR (default_model IS NULL AND default_effort IS NULL))',
        update('host_preferences', { default_provider: null }, { id: 1 })
      )
    })

    it('[ADR-016] integration_settings and config_writes store first-run for claude-hooks and reject add-panel for claude-hooks', () => {
      T(
        "integration_settings CHECK (id = 'opencode-permissions' OR consent_origin IS NULL OR consent_origin IN ('settings', 'first-run'))",
        update(
          'integration_settings',
          { state: 'on-unverified', consent_origin: 'first-run' },
          { id: 'claude-hooks' }
        )
      )
      T(
        "integration_settings CHECK (id = 'opencode-permissions' OR consent_origin IS NULL OR consent_origin IN ('settings', 'first-run'))",
        update(
          'integration_settings',
          { state: 'on-verified', consent_origin: 'add-panel' },
          { id: 'opencode-permissions' }
        )
      )
      R(
        "integration_settings CHECK (id = 'opencode-permissions' OR consent_origin IS NULL OR consent_origin IN ('settings', 'first-run'))",
        update('integration_settings', { consent_origin: 'add-panel' }, { id: 'claude-hooks' })
      )
      T(
        "config_writes CHECK (kind = 'opencode-plugin' OR consent_origin IN ('settings', 'first-run'))",
        insert('config_writes', { consent_origin: 'first-run' })
      )
      T(
        "config_writes CHECK (kind = 'opencode-plugin' OR consent_origin IN ('settings', 'first-run'))",
        insert('config_writes', { kind: 'opencode-plugin', consent_origin: 'add-panel' })
      )
      R(
        "config_writes CHECK (kind = 'opencode-plugin' OR consent_origin IN ('settings', 'first-run'))",
        insert('config_writes', { consent_origin: 'add-panel' })
      )
    })

    it("[ADR-016] integration_settings: only the two integrations exist; each state and consent origin stores; 'off' with a consent origin, 'on' without one and unknown values are rejected", () => {
      put(remove('integration_settings', { id: 'claude-hooks' }))
      T('integration_settings.id CHECK', insert('integration_settings', { id: 'claude-hooks' }))
      R('integration_settings.id CHECK', insert('integration_settings', { id: 'slack-hooks' }))
      const key = { id: 'opencode-permissions' }
      for (const state of ['on-unverified', 'on-verified']) {
        T(
          'integration_settings.state CHECK',
          update('integration_settings', { state, consent_origin: 'settings' }, key)
        )
      }
      R('integration_settings.state CHECK', update('integration_settings', { state: 'on' }, key))
      for (const origin of ['settings', 'add-panel', 'first-run']) {
        T(
          'integration_settings.consent_origin CHECK',
          update('integration_settings', { consent_origin: origin }, key)
        )
      }
      R(
        'integration_settings.consent_origin CHECK',
        update('integration_settings', { consent_origin: 'wizard' }, key)
      )
      T(
        "integration_settings CHECK ((state = 'off') = (consent_origin IS NULL))",
        update('integration_settings', { state: 'off', consent_origin: null }, key)
      )
      R(
        "integration_settings CHECK ((state = 'off') = (consent_origin IS NULL))",
        update('integration_settings', { consent_origin: 'settings' }, key)
      )
      R(
        "integration_settings CHECK ((state = 'off') = (consent_origin IS NULL))",
        update('integration_settings', { state: 'on-verified' }, key)
      )
    })

    it('[ADR-016] config_writes: each kind and consent origin stores; one active write per kind and target; unknown values and a short id are rejected', () => {
      for (const kind of ['claude-hooks', 'opencode-plugin'])
        T('config_writes.kind CHECK', insert('config_writes', { kind }))
      R('config_writes.kind CHECK', insert('config_writes', { kind: 'other' }))
      for (const origin of ['settings', 'add-panel', 'first-run']) {
        T(
          'config_writes.consent_origin CHECK',
          insert('config_writes', { kind: 'opencode-plugin', consent_origin: origin })
        )
      }
      R('config_writes.consent_origin CHECK', insert('config_writes', { consent_origin: 'wizard' }))
      T('config_writes.id CHECK', insert('config_writes', { id: newId() }))
      R('config_writes.id CHECK', insert('config_writes', { id: ID_35 }))
      const target = { target_path: '/config/settings.json' }
      T('index config_writes_one_active', insert('config_writes', target))
      T('index config_writes_one_active', insert('config_writes', { ...target, reverted_at: 3 }))
      T(
        'index config_writes_one_active',
        insert('config_writes', { ...target, kind: 'opencode-plugin' })
      )
      R('index config_writes_one_active', insert('config_writes', target))
    })

    it('[ADR-016] channel_tokens: one active token per channel and one row per token hash; unknown channels, a short hash and a short id are rejected', () => {
      for (const channel of ['claude-hooks', 'opencode-plugin']) {
        T('channel_tokens.channel CHECK', insert('channel_tokens', { channel }))
      }
      R(
        'channel_tokens.channel CHECK',
        insert('channel_tokens', { channel: 'other', revoked_at: 2 })
      )
      T('index channel_tokens_one_active', insert('channel_tokens', { revoked_at: 2 }))
      R('index channel_tokens_one_active', insert('channel_tokens'))
      T(
        'channel_tokens UNIQUE (token_sha256)',
        insert('channel_tokens', { token_sha256: hex64(5000), revoked_at: 2 })
      )
      R(
        'channel_tokens UNIQUE (token_sha256)',
        insert('channel_tokens', { token_sha256: hex64(5000), revoked_at: 2 })
      )
      T(
        'channel_tokens.token_sha256 CHECK',
        insert('channel_tokens', { token_sha256: hex64(5001), revoked_at: 2 })
      )
      R(
        'channel_tokens.token_sha256 CHECK',
        insert('channel_tokens', { token_sha256: 'f'.repeat(63), revoked_at: 2 })
      )
      T('channel_tokens.id CHECK', insert('channel_tokens', { id: newId(), revoked_at: 2 }))
      R('channel_tokens.id CHECK', insert('channel_tokens', { id: ID_35, revoked_at: 2 }))
    })
  })
})
