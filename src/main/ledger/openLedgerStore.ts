import { readFile } from 'node:fs/promises'
import { SqliteWriteError } from '../adapters/sqliteWritable'
import { LEDGER_TABLES_SINCE, type AppDatabase } from '../appDatabase/appDatabase'
import { migrateLedgerJson, type LedgerMigrationOutcome } from './ledgerMigration'
import {
  createLedgerStore,
  nullLedgerStore,
  type LedgerFsLike,
  type LedgerStore
} from './ledgerStore'
import { createSqliteLedgerStore } from './sqliteLedgerStore'

/**
 * Decide which vault this run gets, and say so once (#93).
 *
 * Three backings, and the app opens on any of them. The panel's actual job —
 * showing the sessions running right now — needs no vault at all, so nothing
 * here may fail a launch.
 */
export type VaultBacking =
  /** The app's database. The ordinary case, and the only one that persists ore. */
  | 'database'
  /** material-ledger-v1.json, still the current copy. Persists, as it always did. */
  | 'json'
  /** Nothing. This session's accrual is shown and then forgotten. */
  | 'memory'

export interface OpenedLedgerStore {
  store: LedgerStore
  backing: VaultBacking
  /** What the migration found, or null when the database could not be asked. */
  migration: LedgerMigrationOutcome | null
}

export interface OpenLedgerStoreOptions {
  /** The one app database, shared with the projects list. */
  database: AppDatabase
  /** Injected for tests; the JSON fallback needs the real filesystem in production. */
  fs?: LedgerFsLike
  /** Full path of material-ledger-v1.json. */
  jsonPath: string
  now: () => number
  /** Where a degraded run is reported; defaults to swallowing it. */
  warn?: (message: string) => void
  /** Where the ordinary one-line outcome goes; defaults to swallowing it. */
  log?: (message: string) => void
}

/**
 * ---------------------------------------------------------------------------
 * WHAT THE JSON DOCUMENT IS WORTH, AND WHEN
 * ---------------------------------------------------------------------------
 * The document is only trustworthy while the database has NOT taken over. Once
 * it has, the document is a snapshot of the moment before — and its session
 * marks are baselines the database has since moved past. Loading a stale mark
 * makes the very next poll's delta span everything mined in between and credit
 * it a second time, permanently (domain/ledger.ts:33-41). So a stale document
 * is not a lesser backup; reading it is a corruption.
 *
 * The migration marker is the only proof either way, which leaves three
 * answers rather than two:
 *
 * | What the database says              | Vault this run | Why                                    |
 * | ----------------------------------- | -------------- | -------------------------------------- |
 * | no marker, migration succeeded      | database       | it has taken over, cleanly             |
 * | marker present                      | database       | it took over on an earlier boot        |
 * | no marker, the write failed         | json           | nothing took over; document is current |
 * | no driver at all ('unavailable')    | json           | it could never have taken over         |
 * | stamped below LEDGER_TABLES_SINCE   | json           | the vault's tables have never existed  |
 * | anything else it will not answer    | memory         | cannot prove the document is current   |
 *
 * The last row is the honest shape of an unanswerable question, and it is
 * deliberately the poorer-looking option. The two ways of guessing wrong are a
 * history double-credited forever, or tokens quietly written to a file the next
 * healthy boot will ignore. Both are silent and both are permanent. Showing
 * this session's accrual only, saying so in the log, and writing nothing is
 * neither. The document keeps sitting there, intact, and the next boot tries
 * again.
 *
 * A memory backing needs no new module: nullLedgerStore() already remembers
 * nothing, and MaterialLedger holds the running state in memory regardless. The
 * vault chip therefore shows what this session has accrued, and invents no
 * totals in front of it.
 */
export async function openLedgerStore(options: OpenLedgerStoreOptions): Promise<OpenedLedgerStore> {
  let migration: LedgerMigrationOutcome
  try {
    migration = await migrateLedgerJson({
      database: options.database,
      // The one read of the document in the whole path, and the only filesystem
      // capability the migration is handed. Nothing there can write to it.
      readJson: (path) =>
        options.fs === undefined ? readFile(path, 'utf8') : options.fs.readFile(path, 'utf8'),
      jsonPath: options.jsonPath,
      now: options.now
    })
  } catch (error) {
    return await unopenable(options, error)
  }

  if (migration.status === 'failed') {
    options.warn?.(
      `[ledger] The vault could not be moved into the database (${migration.reason ?? 'unknown'}). ` +
        `Using ${basename(options.jsonPath)} for this run; the next launch will try again.`
    )
    return { store: json(options), backing: 'json', migration }
  }

  // A genuine probe, not a formality: the store connects lazily, and a database
  // that answered the marker can still fail on the vault itself. Without this
  // the first news would arrive inside whichever poll happened to touch it,
  // long after the log line anyone would read.
  const store = createSqliteLedgerStore({ database: options.database })
  try {
    await store.load()
  } catch (error) {
    return { store: forgetful(options, reasonOf(error)), backing: 'memory', migration }
  }

  options.log?.(
    migration.status === 'migrated'
      ? `[ledger] Vault migrated into the database: ${migration.mines} mine(s), ` +
          `${migration.sessions} session mark(s). ${basename(options.jsonPath)} is kept as a backup and ignored from now on.`
      : `[ledger] Vault read from the database (${migration.mines} mine(s)).`
  )
  return { store, backing: 'database', migration }
}

/**
 * The database refused before it could even be asked about the marker.
 *
 * Two of its refusals still prove the document is current — see the table
 * above — and the schema stamp is what separates them from the rest, so it is
 * worth one throwaway read on a path that is already failing.
 */
async function unopenable(
  options: OpenLedgerStoreOptions,
  error: unknown
): Promise<OpenedLedgerStore> {
  const failure = error instanceof SqliteWriteError ? error.failure : null
  const version = failure === 'unavailable' ? null : await options.database.schemaVersion()

  if (failure === 'unavailable' || (version !== null && version < LEDGER_TABLES_SINCE)) {
    options.warn?.(
      `[ledger] The database is not usable (${reasonOf(error)}); the vault stays in ` +
        `${basename(options.jsonPath)} for this run.`
    )
    return { store: json(options), backing: 'json', migration: null }
  }

  return { store: forgetful(options, reasonOf(error)), backing: 'memory', migration: null }
}

function json(options: OpenLedgerStoreOptions): LedgerStore {
  return createLedgerStore({ filePath: options.jsonPath, fs: options.fs })
}

function forgetful(options: OpenLedgerStoreOptions, reason: string): LedgerStore {
  options.warn?.(
    `[ledger] The vault database will not open (${reason}), and ${basename(options.jsonPath)} ` +
      'may be older than what it holds. This session will show only what it mines from now on, ' +
      'and will not be saved; nothing has been changed on disk. The next launch will try again.'
  )
  return nullLedgerStore()
}

function reasonOf(error: unknown): string {
  if (error instanceof SqliteWriteError) return `${error.failure}: ${error.message}`
  return error instanceof Error ? error.message : 'unknown'
}

/** The file name alone, for a log line that must not carry a home directory. */
function basename(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? path
}
