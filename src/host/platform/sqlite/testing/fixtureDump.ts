// The text dump of a DB fixture ladder rung (17 §1.5 "From every previous version", §1.4
// "Redaction (scrub rules)"; 09 §6.5 "Fixture ladder"; ADR-005 item 6), shared by
// `scripts/db/dump-fixture.mjs` and the ladder test, so the generator and the drift check can
// never render differently. Never imported by production code (R14).
//
// A rung is self-contained SQL text that rebuilds the release's database on an empty file:
//   1. the header comments, ending with `-- schema-version: <n>` (the highest applied version);
//   2. `PRAGMA foreign_keys = OFF` and `BEGIN`;
//   3. every table's `CREATE` text, in creation order;
//   4. every row as an `INSERT`, tables in foreign-key order (parents first), rows in primary-key
//      order; generated columns are left out (SQLite computes them);
//   5. the indexes, then the triggers, so a trigger never fires while the rows are replayed (the
//      ledger's totals trigger would count every credit twice);
//   6. the file's `application_id`, then `COMMIT`.
// `schema_migrations` is a table like any other, so the runner that opens a built rung sees the
// release's exact history and checksums.
//
// Every TEXT value is scrubbed before it is written (17 §1.4): the home directories and the
// account and host names of the given identities, any `Users`/`home` directory path, e-mail
// addresses and secret shapes are replaced with fixed markers. Line breaks inside a value are
// written as `char(10)` / `char(13)` so the file keeps one statement per line and a checkout's
// line-end conversion can never change the data.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import { migrationsFor } from '../migrations/index'
import { openHostDb } from '../migrations/runner'
import { SqliteTransactionRunner } from '../SqliteTransactionRunner'
import { MemoryWritableSqlite } from './MemoryWritableSqlite'

type Queryable = Pick<SqliteDatabase, 'all'>

/** The machine-specific values a dump must not contain (17 §1.4). */
export interface ScrubIdentity {
  home: string
  user: string
  host: string
}

/** The representative rows of one release's rung, written against that release's schema. */
export interface FixtureSeed {
  /** The release the rung belongs to; also its file name (`fixtures/db/<release>.sql`). */
  release: string
  /** The release's final schema version: the rung is migrated up to it, never further. */
  version: number
  /** INSERT statements run in one transaction, foreign keys enforced, after the migrations. */
  statements: readonly string[]
}

export interface DumpOptions {
  identities: readonly ScrubIdentity[]
}

/** The fixed instant every generated rung is migrated and seeded at, so a rung is reproducible. */
export const FIXTURE_EPOCH = 1_750_000_000_000

const HEADER_LINE = /^-- schema-version: (\d+)$/

/** The version of a rung's `-- schema-version: <n>` header line, null when it has none. */
export function readSchemaVersionHeader(text: string): number | null {
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.startsWith('--')) return null
    const match = HEADER_LINE.exec(line)
    if (match !== null) return Number(match[1])
  }
  return null
}

// Scrubbing ---------------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `text` matched case-insensitively, with either path separator, not inside a longer word. */
function identityPattern(text: string): RegExp {
  const body = text.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]')
  return new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, 'gi')
}

/** Any user's home directory: `C:\Users\<name>`, `/Users/<name>`, `/home/<name>`. */
const HOME_DIRECTORY = /(?:\b[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s'"<>]+/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** Secret shapes of ADR-026 with an issuer prefix, and bearer credentials. */
const SECRETS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g
]

/** Replace every machine-specific value of `text` with its marker; scrubbing twice is a no-op. */
export function scrubText(text: string, identities: readonly ScrubIdentity[]): string {
  let result = text
  for (const identity of identities) {
    if (identity.home !== '') result = result.replace(identityPattern(identity.home), '<HOME>')
  }
  result = result.replace(HOME_DIRECTORY, '<HOME>')
  result = result.replace(EMAIL, '<EMAIL>')
  for (const secret of SECRETS) result = result.replace(secret, '<SECRET>')
  for (const identity of identities) {
    if (identity.user !== '') result = result.replace(identityPattern(identity.user), '<USER>')
    if (identity.host !== '') result = result.replace(identityPattern(identity.host), '<HOST>')
  }
  return result
}

// Rendering ---------------------------------------------------------------------------------

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function sqlString(text: string): string {
  const parts = text
    .split(/(\r|\n)/)
    .filter((part) => part !== '')
    .map((part) => {
      if (part === '\n') return 'char(10)'
      if (part === '\r') return 'char(13)'
      return `'${part.replaceAll("'", "''")}'`
    })
  return parts.length === 0 ? "''" : parts.join(' || ')
}

function sqlValue(value: unknown, identities: readonly ScrubIdentity[]): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot dump the non-finite number ${value}`)
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return sqlString(scrubText(value, identities))
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex').toUpperCase()}'`
  throw new Error(`cannot dump a value of type ${typeof value}`)
}

interface SchemaObject {
  type: string
  name: string
  table: string
  sql: string
}

function schemaObjects(db: Queryable): SchemaObject[] {
  return db
    .all(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    )
    .map((row) => ({
      type: String(row['type']),
      name: String(row['name']),
      table: String(row['tbl_name']),
      sql: String(row['sql']).replace(/\r\n?/g, '\n')
    }))
}

/** Tables with their parents first; a self-reference does not order, a cycle keeps creation order. */
function foreignKeyOrder(db: Queryable, tables: readonly string[]): string[] {
  const parents = new Map(
    tables.map((table) => [
      table,
      new Set(
        db
          .all(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`, [table])
          .map((row) => String(row['parent']))
          .filter((parent) => parent !== table && tables.includes(parent))
      )
    ])
  )
  const ordered: string[] = []
  const placed = new Set<string>()
  while (ordered.length < tables.length) {
    const next =
      tables.find(
        (table) => !placed.has(table) && [...(parents.get(table) ?? [])].every((p) => placed.has(p))
      ) ?? tables.find((table) => !placed.has(table))
    if (next === undefined) break
    ordered.push(next)
    placed.add(next)
  }
  return ordered
}

function insertLines(db: Queryable, table: string, identities: readonly ScrubIdentity[]): string[] {
  const info = db.all(`SELECT name, hidden, pk FROM pragma_table_xinfo(?)`, [table])
  const columns = info.filter((row) => row['hidden'] === 0).map((row) => String(row['name']))
  const keys = info
    .filter((row) => Number(row['pk']) > 0)
    .sort((a, b) => Number(a['pk']) - Number(b['pk']))
    .map((row) => quoteIdentifier(String(row['name'])))
  const order = keys.length > 0 ? keys.join(', ') : 'rowid'
  const columnList = columns.map(quoteIdentifier).join(', ')
  return db
    .all(`SELECT ${columnList} FROM ${quoteIdentifier(table)} ORDER BY ${order}`)
    .map((row: SqliteRow) => {
      const values = columns.map((column) => sqlValue(row[column], identities)).join(', ')
      return `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${values});`
    })
}

function scalar(db: Queryable, sql: string): unknown {
  const [row] = db.all(sql)
  return row === undefined ? undefined : Object.values(row)[0]
}

/** Render the database behind `db` as the rung text of `release`. */
export function renderFixtureDump(db: Queryable, release: string, options: DumpOptions): string {
  const version = Number(scalar(db, 'SELECT max(version) FROM schema_migrations'))
  const objects = schemaObjects(db)
  const tables = objects.filter((o) => o.type === 'table').map((o) => o.name)
  const lines = [
    `-- DwarfAI Host database: fixture ladder rung "${release}" (ADR-005 item 6; 17 §1.5).`,
    `-- Generated by scripts/db/dump-fixture.mjs --seed ${release}; never edited by hand: a`,
    '-- regeneration is a reviewed diff. Scrubbed per 17 §1.4 (no home path, user or host name,',
    '-- e-mail address or secret).',
    `-- schema-version: ${version}`,
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;',
    ...objects.filter((o) => o.type === 'table').map((o) => `${o.sql};`),
    ...foreignKeyOrder(db, tables).flatMap((table) => insertLines(db, table, options.identities)),
    ...objects.filter((o) => o.type === 'index').map((o) => `${o.sql};`),
    ...objects.filter((o) => o.type === 'trigger').map((o) => `${o.sql};`),
    ...objects.filter((o) => o.type === 'view').map((o) => `${o.sql};`),
    `PRAGMA application_id = ${Number(scalar(db, 'PRAGMA application_id'))};`,
    'COMMIT;'
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Migrate an empty in-memory database to `seed.version` with the registered migrations, at the
 * fixed fixture instant and ids, run the seed's rows and render the rung text.
 *
 * The runner opens it through `openWriter`, so a dump touches no file: no temp directory, no WAL
 * or checkpoint flush and no wait on a file another process holds, which made the dump take
 * seconds on a slow CI disk. The rung text does not depend on where the database lived: the
 * ladder test checks every committed rung against this function.
 */
export function dumpSeededFixture(seed: FixtureSeed, options: DumpOptions): string {
  const clock = new FakeClock(FIXTURE_EPOCH)
  const migrations = migrationsFor({ clock, ids: new SequenceIdGenerator() })
  if (seed.version < 1 || seed.version > migrations.length) {
    throw new Error(
      `the seed of ${seed.release} is for schema version ${seed.version}; this build knows 1…${migrations.length}`
    )
  }
  // A path the runner only reasons about (it is never created): no file there, so nothing to
  // probe or quarantine, and outside the release data directory.
  const dir = join(tmpdir(), 'dwarfai-dump-fixture-in-memory')
  const opened = openHostDb(join(dir, 'dwarfai.db'), {
    buildKind: 'test',
    releaseDataDir: join(dir, 'release-data'),
    appVersion: seed.release,
    clock,
    log: new RecordingDiagnosticsLog(),
    migrations: migrations.slice(0, seed.version),
    openWriter: () => new MemoryWritableSqlite()
  })
  if (!opened.ok) throw new Error(`the runner refused an empty database: ${opened.error}`)
  const { db } = opened.value
  try {
    new SqliteTransactionRunner(db).inTransaction(() => {
      for (const statement of seed.statements) db.run(statement)
    })
    return renderFixtureDump(db, seed.release, options)
  } finally {
    db.close()
  }
}
