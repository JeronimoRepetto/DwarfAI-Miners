// Where OpenCode keeps its store (15 §5 OpenCode row; docs/opencode-format.md Row 1): one SQLite
// file, `opencode.db`, under `~/.local/share/opencode/`, the same POSIX-shaped path under the home
// folder on Windows, macOS and Linux (measured on 1.18.31). Nothing else of the folder is read: not
// `auth.json` (ADR-008 item 2), not `log/`, and no legacy `storage/` JSON tree (a store without a
// database is "not observed").
//
// Reimplemented from the candidate `src/main/providers/opencode/store.ts` (R16): pure
// `node:path` joins, never a hand-written separator.
import { join } from 'node:path'

/** The database file under the store root. */
export const OPENCODE_DB_FILE = 'opencode.db'

/** `~/.local/share/opencode` for the home folder `home`, on every OS. */
export function openCodeStoreRootOf(home: string): string {
  return join(home, '.local', 'share', 'opencode')
}

/** The database file of the store at `storeRoot`. */
export function openCodeDbPath(storeRoot: string): string {
  return join(storeRoot, OPENCODE_DB_FILE)
}
