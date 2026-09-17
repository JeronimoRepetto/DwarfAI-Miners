import { join } from 'node:path'

/**
 * Path builders for OpenCode's SQLite store [V, docs/opencode-format.md].
 *
 * Mirrors `antigravity/discovery.ts`'s path builders: pure, `node:path.join`
 * only, never a hand-joined separator, so the same expectation holds whether
 * the host is Windows, macOS or Linux (`pathPortability.test.ts:8-15`).
 *
 * `opencode.db` is the single source this provider reads (maintainer
 * decision, `measurements-2026-09-17.md`): no `storage/` JSON tree is ever
 * listed or read, so a legacy install without a database costs nothing and
 * shows nothing.
 */

const DB_FILE = 'opencode.db'
const WAL_FILE = 'opencode.db-wal'

/** The database file under `storeRoot`. */
export function opencodeDbPath(storeRoot: string): string {
  return join(storeRoot, DB_FILE)
}

/** The WAL file beside it, read whenever it exists ([V], measurements row 2). */
export function opencodeWalPath(storeRoot: string): string {
  return join(storeRoot, WAL_FILE)
}
