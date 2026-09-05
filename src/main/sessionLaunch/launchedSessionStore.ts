import type { AppDatabase } from '../appDatabase/appDatabase'
import { isDwarfProvider, type DwarfProvider } from '../domain/types'

/**
 * The launch register on disk — what this panel started, kept so the exit
 * survives a restart (#231).
 *
 * A STORE, not a rule. Nothing here decides whether a launch may be ended:
 * that judgement is LaunchedSessionRegistry's, and it is made against a live
 * probe of the machine rather than against these rows. This module only turns
 * one launch into a row and back, which is what lets the whole re-adoption rule
 * be unit-tested without a database at all.
 *
 * ROW BY ROW, unlike the vault beside it. The ledger rewrites both its tables
 * on every save because the state handed in IS the state; a launch register is
 * the opposite shape — one row appears when a session is claimed and one row
 * disappears when its process is gone, minutes or hours apart, and a
 * whole-table rewrite would make every one of those a rewrite of everything
 * this app has ever launched.
 *
 * ERROR CONTRACT, the same as the other two tenants'. A database that will not
 * open has not said the register is empty, and answering "nothing was launched"
 * would silently retire an exit the user still has. So list() rejects, and the
 * caller decides what a rejection means.
 */

/** One launch this panel made, as it survives between runs. */
export interface PersistedLaunch {
  /** The id `end` names, minted by the register that retained the process. */
  launchId: string
  provider: DwarfProvider
  /** The provider's own id for the session that launch became. */
  sessionId: string
  /** The mine's folder, exactly as the launch was given it. */
  minePath: string
  pid: number
  /**
   * When the OS says that pid's process was created, read while this panel
   * still held the handle — the one fact that tells the launched process apart
   * from whatever inherits its number later. Without it a row is a bare pid,
   * which is precisely what must never be signalled.
   */
  processStartTimeMs: number
}

export interface LaunchedSessionStore {
  /** Every launch written down, in no particular order. Rejects; never lies with []. */
  list(): Promise<PersistedLaunch[]>
  /** Write one launch down, replacing whatever stood under its id. */
  put(launch: PersistedLaunch): Promise<void>
  /** Forget one launch, whether or not it was ever there. */
  remove(launchId: string): Promise<void>
}

export interface SqliteLaunchedSessionStoreOptions {
  /** The one app database, shared with the projects list and the vault. */
  database: AppDatabase
}

const SELECT_ALL =
  'SELECT launch_id, provider, session_id, mine_path, pid, proc_start_ms FROM launched_sessions'

const UPSERT =
  'INSERT OR REPLACE INTO launched_sessions ' +
  '(launch_id, provider, session_id, mine_path, pid, proc_start_ms) VALUES (?, ?, ?, ?, ?, ?)'

export function createSqliteLaunchedSessionStore(
  options: SqliteLaunchedSessionStoreOptions
): LaunchedSessionStore {
  return {
    async list(): Promise<PersistedLaunch[]> {
      const db = await options.database.connect()
      const launches: PersistedLaunch[] = []
      for (const row of db.all(SELECT_ALL)) {
        const launch = toLaunch(row)
        if (launch !== null) launches.push(launch)
      }
      return launches
    },

    async put(launch: PersistedLaunch): Promise<void> {
      const db = await options.database.connect()
      db.run(UPSERT, [
        launch.launchId,
        launch.provider,
        launch.sessionId,
        launch.minePath,
        launch.pid,
        launch.processStartTimeMs
      ])
    },

    async remove(launchId: string): Promise<void> {
      const db = await options.database.connect()
      db.run('DELETE FROM launched_sessions WHERE launch_id = ?', [launchId])
    }
  }
}

/**
 * One row -> one launch, or nothing.
 *
 * Read with more suspicion than the vault's rows, because every field here is
 * an ingredient of a decision to KILL a process tree: a row missing any of them
 * is not a launch with a gap, it is a row this build must not act on. A
 * provider this build does not know is dropped rather than coerced, and a pid
 * of zero or below is refused here as well as in buildEndProcessTreeCommand —
 * `kill -TERM -1` signals every process the user owns, and group 0 is the
 * panel's own.
 */
function toLaunch(row: Record<string, unknown>): PersistedLaunch | null {
  const launchId = asText(row.launch_id)
  const provider = asProvider(row.provider)
  const sessionId = asText(row.session_id)
  const minePath = asText(row.mine_path)
  const pid = asPositive(row.pid)
  const processStartTimeMs = asPositive(row.proc_start_ms)
  if (launchId === null || provider === null || sessionId === null) return null
  if (minePath === null || pid === null || processStartTimeMs === null) return null
  return { launchId, provider, sessionId, minePath, pid, processStartTimeMs }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asProvider(value: unknown): DwarfProvider | null {
  const name = asText(value)
  return name !== null && isDwarfProvider(name) ? name : null
}

function asPositive(value: unknown): number | null {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number') return null
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}
