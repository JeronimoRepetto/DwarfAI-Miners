import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The read-only path to Host state for E2E assertions (testing strategy `17` §1.9).
 *
 * After the Host of a case exited, a case may open the test profile's `dwarfai.db` read-only and
 * query it; it never pokes the Host's internal state and never writes. The database lives in
 * `hostDataDir`, the profile's `userData` + `/host` (`src/host/platform/paths/EnvAppPaths.ts`).
 * Open it only after the Host exited: the Host is the single writer (ADR-002 D1).
 */

/** The Host database of an isolated profile, relative to its `userData`. */
export const HOST_DB = path.join('host', 'dwarfai.db')

/** Opens the profile's `dwarfai.db` read-only; the caller closes it. */
export function openHostDatabaseReadOnly(profile: { readonly userDataDir: string }): DatabaseSync {
  const file = path.join(profile.userDataDir, HOST_DB)
  if (!existsSync(file)) {
    throw new Error(`The profile has no Host database (${file}); did its Host run and exit?`)
  }
  return new DatabaseSync(file, { readOnly: true })
}
