import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { initialMigration } from './migrations/0001-initial'
import { migrationsFor } from './migrations/index'
import { openHostDb, type OpenHostDbOptions, type OpenedHostDb } from './migrations/runner'
import { migrationChecksum, type Migration } from './migrations/types'
import { renderSchemaSnapshot, SCHEMA_QUERY } from './testing/schemaSnapshot'

// L5 (17 §1.5; 09 §6.5 "Schema snapshot", "FK index coverage", "STRICT coverage"): the structural
// contract of migration 1 over a real database file, one temp dir per test. The behavioural
// CHECK / UNIQUE / trigger / FK probes extend this file later (ISSUE-036).

const MIGRATION_SQL = readFileSync(
  new URL('./migrations/0001-initial.sql', import.meta.url),
  'utf8'
)
const SNAPSHOT = readFileSync(new URL('./schema.snapshot.sql', import.meta.url), 'utf8')

const T = 1_750_000_000_000
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
    clock = new FakeClock(T)
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
        created_at: T
      }
    ])
    expect(db.all('SELECT * FROM install_moment')).toEqual([
      {
        id: 1,
        at: T,
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
        updated_at: T
      }
    ])
    expect(db.all('SELECT * FROM integration_settings ORDER BY id')).toEqual([
      { id: 'claude-hooks', state: 'off', consent_origin: null, changed_at: T },
      { id: 'opencode-permissions', state: 'off', consent_origin: null, changed_at: T }
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
