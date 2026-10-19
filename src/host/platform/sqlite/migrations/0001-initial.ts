// Migration 1 (09 §4; ADR-005 items 3 and 8): schema v1 of the Host database, its seed rows, the
// install moment `(1, now, 'fresh-install')` and the DwarfAI application_id, all inside the
// runner's one migration transaction on an empty file (NFR-PERS-15: born empty, nothing
// imported). Never rewritten once the first internal build has been installed (21 §5.1): the
// checksum of `0001-initial.sql` is recorded in `schema_migrations` and verified at every open.
//
// `up` executes the DDL of the eight schema blocks as written, then runs each statement of the
// seed block (09 §4.9) with `:install_id` (a UUIDv7 of the `IdGenerator`) and `:now` (the
// `Clock`) bound, and finally the application_id pragma that closes the file. The `SqliteDatabase`
// port binds positional values only, so each named parameter is rewritten to its numbered form
// (`?1`, `?2`) for the statement it appears in; the checksum stays that of the SQL text.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteParam } from '../../../kernel/ports/sqliteDatabase'
import sql from './0001-initial.sql?raw'
import { defineMigration, type Migration } from './types'

export interface InitialMigrationPorts {
  clock: Clock
  ids: IdGenerator
}

/** The first line of the seed block (09 §4.9); everything before it is DDL. */
const SEED_BLOCK = '-- schema-v1 · 4.9 seed'

/** The seed block's named parameters, in the order of their numbered form (`?1`, `?2`). */
const SEED_PARAMETERS = ['install_id', 'now'] as const

function splitAtSeedBlock(text: string): { ddl: string; seed: string } {
  const at = text.indexOf(SEED_BLOCK)
  if (at < 0) {
    throw new HostInvariantError(`0001-initial.sql has no "${SEED_BLOCK}" block (09 §4.9)`)
  }
  return { ddl: text.slice(0, at), seed: text.slice(at) }
}

/** The seed block's statements (one per `;`), comment lines dropped. */
function seedStatements(seed: string): string[] {
  return seed
    .split(';')
    .map((statement) =>
      statement
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((statement) => statement !== '')
}

/** A statement with its named parameters numbered, and the values it needs, in order. */
function bindNamed(
  statement: string,
  values: Readonly<Record<(typeof SEED_PARAMETERS)[number], SqliteParam>>
): { sql: string; params: SqliteParam[] } {
  let highest = 0
  const numbered = statement.replace(/:([a-z_]+)/g, (_match, name: string) => {
    const index = (SEED_PARAMETERS as readonly string[]).indexOf(name) + 1
    if (index === 0) {
      throw new HostInvariantError(`0001-initial.sql binds an unknown parameter :${name}`)
    }
    highest = Math.max(highest, index)
    return `?${index}`
  })
  return { sql: numbered, params: SEED_PARAMETERS.slice(0, highest).map((name) => values[name]) }
}

/** Migration 1 over the Host's id generator and clock. */
export function initialMigration(ports: InitialMigrationPorts): Migration {
  const { ddl, seed } = splitAtSeedBlock(sql)
  return defineMigration({
    version: 1,
    name: '0001-initial',
    sql,
    up: (db: SqliteDatabase) => {
      db.exec(ddl)
      const values = { install_id: ports.ids.uuidv7(), now: ports.clock.now() }
      for (const statement of seedStatements(seed)) {
        const bound = bindNamed(statement, values)
        db.run(bound.sql, bound.params)
      }
    }
  })
}
