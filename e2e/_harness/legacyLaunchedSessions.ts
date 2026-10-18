import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Writes one launch into the legacy runtime's `launched_sessions` table, exactly as today's runtime writes a launch it
 * made (`src/main/sessionLaunch/launchedSessionStore.ts` `put`), before the app starts (21 §3 `LegacyEndFirstAdapter`
 * cases of cut 0 and cut 1). Through its own SQL rather than the legacy store, so no e2e case imports the legacy
 * `src/main` tree (05 §5.1 R16) and the cut-5 deletions can remove it whole.
 *
 * The file is the legacy app database in the profile's `userData`. A file that does not exist yet gets the
 * `launched_sessions` table alone, unstamped (`user_version` 0): today's runtime converges such a file at its first
 * open by creating every missing table and stamping its floor (`prepareAppSchema`), as it does a fresh one.
 */
export interface LegacyLaunchRow {
  readonly launchId: string
  readonly provider: string
  readonly sessionId: string
  readonly minePath: string
  readonly pid: number
  readonly processStartTimeMs: number
  readonly routedByJev: boolean
}

/** Today's app database file name (`src/main/appDatabase/appDatabase.ts` `APP_DB_FILENAME`). */
export const LEGACY_APP_DB_FILENAME = 'projects-v1.db'

/** The table as today's runtime creates it (`CREATE_LAUNCHED_SESSIONS`), column for column. */
const CREATE_LAUNCHED_SESSIONS = `
CREATE TABLE launched_sessions (
  launch_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mine_path TEXT NOT NULL,
  pid INTEGER NOT NULL,
  proc_start_ms INTEGER NOT NULL,
  routed_by_jev INTEGER
);
`

const UPSERT =
  'INSERT OR REPLACE INTO launched_sessions ' +
  '(launch_id, provider, session_id, mine_path, pid, proc_start_ms, routed_by_jev) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)'

export function seedLegacyLaunch(userDataDir: string, launch: LegacyLaunchRow): void {
  mkdirSync(userDataDir, { recursive: true })
  const db = new DatabaseSync(path.join(userDataDir, LEGACY_APP_DB_FILENAME))
  try {
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launched_sessions'")
      .all()
    if (present.length === 0) db.exec(CREATE_LAUNCHED_SESSIONS)
    db.prepare(UPSERT).run(
      launch.launchId,
      launch.provider,
      launch.sessionId,
      launch.minePath,
      launch.pid,
      launch.processStartTimeMs,
      // SQLite has no boolean: 0/1, as today's store writes it.
      launch.routedByJev ? 1 : 0
    )
  } finally {
    db.close()
  }
}
