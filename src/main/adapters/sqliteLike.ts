/**
 * Tiny read-only SQLite port.
 *
 * Codex 0.150+ keeps its authoritative session registry in SQLite databases
 * under CODEX_HOME (state_5.sqlite, logs_2.sqlite — see docs/codex-v2-format.md).
 * Everything that reads them goes through this interface so the Codex provider
 * stays unit-testable without touching a real Codex install.
 *
 * Error contract: openReadOnly() resolves to null when the database is missing
 * or unreadable, and all() resolves a failing query to [] — a Codex build with
 * a different schema must degrade to "no rows", never throw inside a poll tick.
 */

/** Value accepted as a bound query parameter. */
export type SqliteParam = string | number | null

/** One result row, keyed by column name. */
export type SqliteRow = Record<string, unknown>

/** One open read-only database handle. */
export interface SqliteDb {
  all(sql: string, params?: readonly SqliteParam[]): SqliteRow[]
  close(): void
}

export interface SqliteLike {
  /** Open `path` read-only; null when it is missing or cannot be opened. */
  openReadOnly(path: string): Promise<SqliteDb | null>
}

/**
 * Loader for node:sqlite, resolved once and cached.
 *
 * node:sqlite is built into Node 22+ and into the Node that Electron 44
 * bundles (verified on this machine: Electron 44.0.0 / Node 24.18.1 /
 * SQLite 3.53.1 reads Codex's live WAL databases read-only with no native
 * dependency). It is still imported lazily so a runtime without it degrades
 * to "no Codex SQLite data" instead of failing at module load.
 */
type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean }
) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

let databaseSync: DatabaseSyncCtor | null | undefined

async function loadDatabaseSync(): Promise<DatabaseSyncCtor | null> {
  if (databaseSync !== undefined) return databaseSync
  try {
    const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: DatabaseSyncCtor }
    databaseSync = typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    databaseSync = null
  }
  return databaseSync
}

function toRows(raw: unknown[]): SqliteRow[] {
  return raw.filter((row): row is SqliteRow => typeof row === 'object' && row !== null)
}

/** Real node:sqlite implementation used by the running app. */
export class NodeSqlite implements SqliteLike {
  async openReadOnly(path: string): Promise<SqliteDb | null> {
    const Ctor = await loadDatabaseSync()
    if (Ctor === null) return null
    try {
      const db = new Ctor(path, { readOnly: true })
      return {
        all(sql, params = []) {
          try {
            return toRows(db.prepare(sql).all(...params))
          } catch {
            return []
          }
        },
        close() {
          try {
            db.close()
          } catch {
            // A handle that is already gone needs no closing.
          }
        }
      }
    } catch {
      return null
    }
  }
}
