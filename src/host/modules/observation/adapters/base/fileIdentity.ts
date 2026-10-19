// File identity for root dedupe (FM-093; L-08, L-09): the OS's own answer to "is this the same
// file", whatever spelling, overlapping root or reparse point (junction, symlink, MSIX
// redirection) reached it. The kernel `FileSystem` has no realpath and no inode, so this adapter
// reads `node:fs` itself, as `mines/adapters/pathValidation.ts` does.
//
// - `canonicalPath` is `realpath.native`: every link followed to the end.
// - `fileIdentity` is the volume and file index (`dev:ino`, read as bigints so a 64-bit NTFS
//   file index is exact); a file system with no file index (ino 0) falls back to the canonical
//   path. A replaced file has a new identity even at the same path (FM-087).
// Anything unreadable answers null and never throws (INV-38).
import { realpath } from 'node:fs'
import { stat } from 'node:fs/promises'

/** The OS's realpath (`realpath.native`), which `fs/promises` does not offer. */
function nativeRealpath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolved) => (error === null ? resolve(resolved) : reject(error)))
  })
}

export interface IdentifiedFile {
  canonicalPath: string
  fileIdentity: string
  size: number
}

/** How the adapter base identifies a file; injectable for tests that need no disk. */
export type FileIdentifier = (path: string) => Promise<IdentifiedFile | null>

export const nodeFileIdentity: FileIdentifier = async (path) => {
  try {
    const canonicalPath = await nativeRealpath(path)
    const info = await stat(canonicalPath, { bigint: true })
    if (!info.isFile()) return null
    const fileIdentity = info.ino === 0n ? `path:${canonicalPath}` : `${info.dev}:${info.ino}`
    return { canonicalPath, fileIdentity, size: Number(info.size) }
  } catch {
    return null
  }
}

/** The canonical form of a root folder, or null when it does not exist. */
export async function canonicalRoot(path: string): Promise<string | null> {
  try {
    return await nativeRealpath(path)
  } catch {
    return null
  }
}
