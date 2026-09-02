import {
  SqliteWriteError,
  type SqliteFailure,
  type SqliteRow,
  type WritableSqliteDb,
  type WritableSqliteLike
} from '../adapters/sqliteWritable'
import {
  UnsupportedSchemaError,
  createAppDatabase,
  type AppDatabase
} from '../appDatabase/appDatabase'
import { mineIdForPath } from '../domain/aggregate'
import { isMineTier, type DwarfProvider, type MineTier, type ProjectQuery } from '../domain/types'
import { currentPlatform, type Platform } from '../platform/platform'
import { normalizeProjectName, projectNameForPath } from './projectName'
import { buildProjectQuery } from './projectQuery'

/**
 * Every project this app has been shown — declared by the user (#85) or
 * discovered from a running session — with when it arrived, when it was last
 * worked, and by which agent. None of this existed in any form before #93.
 *
 * Storage is a SQLite database under userData rather than another hand-rolled
 * JSON document, because #92 asks for filtering, two sort orders and a
 * substring search over a list with no bound on its length. The path is
 * INJECTED, exactly as the ledger's is (src/main/index.ts:256-258): this module
 * never imports Electron, so it is unit-testable with no app instance.
 *
 * THE FILE IS SHARED. Since the ledger migrated into it (#93) the projects
 * table is one tenant of two, and the schema, the version stamp and the one
 * open handle all belong to appDatabase/appDatabase.ts. This module owns the
 * projects table's statements and nothing else — a store that opened its own
 * handle would take turns at SQLITE_BUSY with the ledger's saves.
 *
 * One seam is still open, and it is not an oversight: **the browse surface
 * itself is unbuilt.** query() answers #92's question and the runtime carries
 * it over IPC, but no renderer view calls it and nothing in the panel chrome
 * opens one — that waits on the interface rebuild (#90), which is also where
 * being reachable at all gets decided.
 *
 * On the main thread: node:sqlite is synchronous, so every statement here runs
 * on it. That is affordable for one row per observed project per poll, and it
 * is why the API is async even though the driver is not — moving the writes
 * behind a throttle or a worker later (the pattern materialLedger.ts:34 already
 * uses for the same reason) changes this file and no caller.
 */

/** How the app came to know about a project (#85). */
export type ProjectOrigin = 'declared' | 'discovered'

export interface ProjectRecord {
  /** mineIdForPath, never a second id scheme — this is what joins to the ledger. */
  id: string
  /** As the user or the session spelled it; the display form, never lowercased. */
  path: string
  /** The last path segment, derived rather than remembered. */
  name: string
  /** The accent-folded, lowercased name the search in #92 matches against. */
  nameNorm: string
  addedAt: number
  /** null until an agent has actually been seen working here; declaring is not opening. */
  lastOpenedAt: number | null
  origin: ProjectOrigin
  lastProvider: DwarfProvider | null
  /**
   * Only ever a MEASURED tier (#41). tierOf() returns a provisional 'bronze'
   * indistinguishable from a real one and must never reach this column, or a
   * filter for bronze fills up with projects nobody has walked. Callers pass
   * knownTierOf(), which is undefined until a walk has produced an answer, and
   * an observation carrying none leaves whatever was measured before intact.
   */
  knownTier: MineTier | null
}

/** One sighting of a project: a session was seen working in it. */
export interface ProjectObservation {
  path: string
  /** When it was seen, in epoch milliseconds. */
  at: number
  provider?: DwarfProvider
  /** From knownTierOf() only — omitted while the first walk is still pending. */
  knownTier?: MineTier
}

export interface ProjectDeclaration {
  path: string
  /** When the user added it, in epoch milliseconds. */
  at: number
}

/**
 * What removing a declaration did (#85).
 *
 * 'demoted' is the case that matters: a project the user declared AND has
 * worked in keeps its dates, its provider and its measured tier, and simply
 * stops being user-declared. Deleting the row would throw away history the
 * user never asked to lose. 'unchanged' covers both a project that was never
 * declared and an id the store has never held — neither changes the declared
 * list, and the caller has nothing different to do about them.
 */
export type ProjectRemoval = 'removed' | 'demoted' | 'unchanged'

/** Every way this store can fail to answer. */
export type ProjectsFailure = SqliteFailure | 'unsupported-schema'

/**
 * An answer or an explicit failure — never a silent default.
 *
 * The JSON stores degrade a broken document to an empty one, and that is right
 * for a pin preference. It is wrong here: an empty project list is a truthful
 * answer for a new install, so returning it for a locked or corrupt database
 * would tell the user their projects are gone. Every caller has to look.
 */
export type ProjectsResult<T> =
  { ok: true; value: T } | { ok: false; failure: ProjectsFailure; message: string }

export interface ProjectsStore {
  /** Record a project the user added; promotes one that was already discovered. */
  declare(declaration: ProjectDeclaration): Promise<ProjectsResult<ProjectRecord>>
  /** Record a sighting; creates the project as discovered when it is new. */
  upsertObserved(observation: ProjectObservation): Promise<ProjectsResult<ProjectRecord>>
  /** Undo a declaration. Never touches a project that was only ever discovered. */
  removeDeclared(id: string): Promise<ProjectsResult<ProjectRemoval>>
  get(id: string): Promise<ProjectsResult<ProjectRecord | null>>
  /** Every project, newest-added first — the whole table, and the only unfiltered read. */
  list(): Promise<ProjectsResult<ProjectRecord[]>>
  /**
   * One filtered, ordered page of projects (#92).
   *
   * Every part of the question is answered in SQL — see projectQuery.ts for
   * why, and for the rules the query itself carries. This method exists so no
   * caller has to read list() and filter it in JavaScript, which would use none
   * of the three indexes the schema was given for exactly this.
   */
  query(query: ProjectQuery): Promise<ProjectsResult<ProjectRecord[]>>
  close(): Promise<void>
}

/**
 * Either the shared database, or the path to build a private one from.
 *
 * Production always passes `database`: the ledger is in the same file and the
 * two must share one handle. The `filePath` form is what every test in this
 * directory uses, and what keeps a store constructible without a caller having
 * to assemble the database first.
 */
export type ProjectsStoreOptions =
  | {
      /** The one app database, shared with the material ledger. */
      database: AppDatabase
      /** Injected so the win32 id rules are assertable on any host. */
      platform?: Platform
    }
  | {
      /** Full path of the database file (under userData in production). */
      filePath: string
      /** Injected for tests; defaults to the real node:sqlite driver. */
      sqlite?: WritableSqliteLike
      platform?: Platform
    }

const COLUMNS =
  'id, path, name, name_norm, added_at, last_opened_at, origin, last_provider, known_tier'

/**
 * The providers a stored row may name.
 *
 * Read back defensively because the database is a file on the user's disk: a
 * value this build does not recognise reads as "unknown", never as a guess.
 */
const KNOWN_PROVIDERS: readonly string[] = ['claude', 'codex']

export function createProjectsStore(options: ProjectsStoreOptions): ProjectsStore {
  const database = 'database' in options ? options.database : createAppDatabase(options)
  const platform = options.platform ?? currentPlatform()

  /**
   * Run one unit of work against the database, turning any failure into an
   * explicit result. A failed handle is dropped rather than reused, so a
   * database that was locked for a moment can be answered properly on the next
   * call instead of staying broken for the life of the process.
   */
  async function withDb<T>(work: (db: WritableSqliteDb) => T): Promise<ProjectsResult<T>> {
    let db: WritableSqliteDb
    try {
      db = await database.connect()
    } catch (error) {
      return toFailure(error)
    }
    try {
      return { ok: true, value: work(db) }
    } catch (error) {
      database.invalidate()
      return toFailure(error)
    }
  }

  function readOne(db: WritableSqliteDb, id: string): ProjectRecord | null {
    const [row] = db.all(`SELECT ${COLUMNS} FROM projects WHERE id = ?`, [id])
    return row === undefined ? null : toRecord(row)
  }

  return {
    async declare(declaration) {
      const id = mineIdForPath(declaration.path, platform)
      const name = projectNameForPath(declaration.path)
      return withDb((db) => {
        // Declaring a project that is already known upgrades its origin and
        // refreshes how it is spelled, but touches neither date: it was first
        // seen when it was first seen, and declaring it is not opening it.
        db.run(
          `INSERT INTO projects (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, NULL, 'declared', NULL, NULL)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             name = excluded.name,
             name_norm = excluded.name_norm,
             origin = 'declared'`,
          [id, declaration.path, name, normalizeProjectName(name), declaration.at]
        )
        return required(readOne(db, id))
      })
    },

    async upsertObserved(observation) {
      const id = mineIdForPath(observation.path, platform)
      const name = projectNameForPath(observation.path)
      return withDb((db) => {
        // origin and added_at are absent from the UPDATE on purpose: a sighting
        // must not demote a declared project, and must not rewrite when the
        // project was first seen. last_opened_at only ever moves forward, so a
        // snapshot that arrives late cannot rewind the recency #92 sorts by,
        // and COALESCE keeps a measured tier that this sighting did not carry.
        db.run(
          `INSERT INTO projects (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             name = excluded.name,
             name_norm = excluded.name_norm,
             last_opened_at = MAX(COALESCE(projects.last_opened_at, 0), excluded.last_opened_at),
             last_provider = COALESCE(excluded.last_provider, projects.last_provider),
             known_tier = COALESCE(excluded.known_tier, projects.known_tier)`,
          [
            id,
            observation.path,
            name,
            normalizeProjectName(name),
            observation.at,
            observation.at,
            observation.provider ?? null,
            observation.knownTier ?? null
          ]
        )
        return required(readOne(db, id))
      })
    },

    async removeDeclared(id) {
      return withDb((db): ProjectRemoval => {
        const existing = readOne(db, id)
        if (existing === null || existing.origin !== 'declared') return 'unchanged'
        if (existing.lastOpenedAt === null) {
          db.run('DELETE FROM projects WHERE id = ?', [id])
          return 'removed'
        }
        db.run("UPDATE projects SET origin = 'discovered' WHERE id = ?", [id])
        return 'demoted'
      })
    },

    async get(id) {
      return withDb((db) => readOne(db, id))
    },

    async list() {
      // One stable order, not a chosen one: newest-added first matches the only
      // project ordering the app has today (aggregate.ts:43 sorts by recency),
      // and the id breaks ties so the list cannot shuffle between reads.
      return withDb((db) =>
        db
          .all(`SELECT ${COLUMNS} FROM projects ORDER BY added_at DESC, id ASC`)
          .map((row) => toRecord(row))
      )
    },

    async query(query) {
      const { sql, params } = buildProjectQuery(query)
      return withDb((db) =>
        db.all(`SELECT ${COLUMNS} FROM projects${sql}`, params).map((row) => toRecord(row))
      )
    },

    async close() {
      // Only a database this store built is this store's to close. The shared
      // one belongs to whoever composed it, and closing it here would pull the
      // file out from under the ledger's forced final save (runtime.ts:446),
      // which is deliberately not awaited.
      if (!('database' in options)) database.close()
    }
  }
}

function toFailure<T>(error: unknown): ProjectsResult<T> {
  if (error instanceof UnsupportedSchemaError) {
    return { ok: false, failure: 'unsupported-schema', message: error.message }
  }
  if (error instanceof SqliteWriteError) {
    return { ok: false, failure: error.failure, message: error.message }
  }
  return { ok: false, failure: 'io', message: error instanceof Error ? error.message : 'unknown' }
}

/** A row this statement just wrote is always there; its absence is a bug, not a state. */
function required(record: ProjectRecord | null): ProjectRecord {
  if (record === null) throw new Error('projects store: wrote a row that read back missing')
  return record
}

function toRecord(row: SqliteRow): ProjectRecord {
  const provider = asText(row.last_provider)
  const tier = asText(row.known_tier)
  return {
    id: asText(row.id) ?? '',
    path: asText(row.path) ?? '',
    name: asText(row.name) ?? '',
    nameNorm: asText(row.name_norm) ?? '',
    addedAt: asNumber(row.added_at) ?? 0,
    lastOpenedAt: asNumber(row.last_opened_at),
    origin: asText(row.origin) === 'declared' ? 'declared' : 'discovered',
    lastProvider:
      provider !== null && KNOWN_PROVIDERS.includes(provider) ? (provider as DwarfProvider) : null,
    // Checked against the shared tier list, so a value this build does not
    // recognise reads as unmeasured rather than as a guess.
    knownTier: tier !== null && isMineTier(tier) ? tier : null
  }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}
