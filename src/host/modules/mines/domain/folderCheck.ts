// What a folder check found (05 §3.1 "Folder check", AMENDMENT-2 SC-AR-04; 16 §4.1
// `MinesCommands.checkFolder`; 07 S3.12…S3.14; 13 FM-095, FM-096). Pure: the reads behind it are
// the use case's (`application/checkFolder.ts`), passed in as their typed outcomes.
//
// - A folder is `missing` only for a cause the OS states: nothing at the path, or something that
//   is not a folder (`not-found`), or the folder cannot be reached or read (`access-denied`).
// - Any other failure (`busy`, `io`, `no-space`, a read that threw) is `unknown`: it proves
//   nothing about the folder, so the mine stays as it is and no false unenterable is published.

/**
 * Why a mine is not enterable, as stored in `Mine.unenterableReason` and carried by
 * `MineBecameUnenterable` and `MineWire.unenterableReason`: a typed code, the same codes the
 * scoring walk gives a root it cannot list (S3.11). The person reads a sentence the renderer
 * picks by this code (later: ISSUE-253): `not-found` → FM-095's "Folder not found. It was moved
 * or deleted."; `access-denied` → ⟦COPY NEEDED: unreadable-folder reason sentence⟧ (FM-096).
 */
export type FolderUnenterableReason = 'not-found' | 'access-denied'

export type FolderFinding =
  | { readonly folder: 'present' }
  | { readonly folder: 'missing'; readonly reason: FolderUnenterableReason }
  | { readonly folder: 'unknown' }

/** The kernel file system's typed failure causes (16 §3 `FileSystem`), as this module reads them. */
export type FolderReadError = 'not-found' | 'access-denied' | 'busy' | 'io' | 'no-space'

/** The folder's stat: `null` when the stat found nothing or failed, which it does not tell apart. */
export type FolderStat = { readonly isDirectory: boolean } | null

/**
 * What the stat alone proves: a folder (`present`), something else in its place (`missing`), or
 * nothing yet (`ask-listing`), when the stat failed and only a typed read can tell why.
 */
export function findingOfStat(stat: FolderStat): FolderFinding | 'ask-listing' {
  if (stat === null) return 'ask-listing'
  return stat.isDirectory ? { folder: 'present' } : { folder: 'missing', reason: 'not-found' }
}

/** What reading the folder's own listing proves: readable, gone, unreadable, or nothing. */
export function findingOfListing(error: FolderReadError | null): FolderFinding {
  if (error === null) return { folder: 'present' }
  if (error === 'not-found' || error === 'access-denied') {
    return { folder: 'missing', reason: error }
  }
  return { folder: 'unknown' }
}
