import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Spike S-030-1: the candidate method that tells whether a folder's file system compares names without case
 * (ADR-030 item 1, `normalizePathKey`; spike register S-030-1).
 *
 * The method needs no write and no spawn: it takes the nearest component of the real path whose name has a cased
 * letter, swaps the case of that name, and stats both spellings in the same parent directory. The same file (device
 * and inode, read as bigint so an NTFS file index never loses precision) means the parent directory folds case; a
 * missing or different file means it does not. A path with no cased letter in any component answers `unknown`, which
 * the gated issues treat as "do not fold" (the S-030-1 fallback, `21` §2 cut 1).
 */

/** What is known about whether a folder's file system compares names without case. */
export type VolumeCase = 'case-insensitive' | 'case-sensitive' | 'unknown'

/** A file's identity on its volume. */
export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

/** Reads a path's identity, or null when the path does not exist or cannot be read. */
export type IdentityReader = (file: string) => Promise<FileIdentity | null>

export interface Detection {
  readonly verdict: VolumeCase
  /** The path whose name was swapped, or null when no component has a cased letter. */
  readonly probed: string | null
  /** How many identity reads the method made. */
  readonly reads: number
}

export async function statIdentity(file: string): Promise<FileIdentity | null> {
  try {
    const stats = await stat(file, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

export function swapCase(name: string): string {
  return [...name]
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join('')
}

/** The candidate detection method, run on `realPath` (an existing absolute real path). */
export async function detectVolumeCase(
  realPath: string,
  identityOf: IdentityReader = statIdentity
): Promise<Detection> {
  const paths = pathFor(process.platform)
  let reads = 0
  const read = (file: string): Promise<FileIdentity | null> => {
    reads += 1
    return identityOf(file)
  }
  for (let current = realPath; ; current = paths.dirname(current)) {
    const name = paths.basename(current)
    const swapped = swapCase(name)
    if (name !== '' && swapped !== name) {
      const original = await read(current)
      if (original === null) return { verdict: 'unknown', probed: current, reads }
      const other = await read(paths.join(paths.dirname(current), swapped))
      const folds = other !== null && other.dev === original.dev && other.ino === original.ino
      return { verdict: folds ? 'case-insensitive' : 'case-sensitive', probed: current, reads }
    }
    if (paths.dirname(current) === current) return { verdict: 'unknown', probed: null, reads }
  }
}

/** The path module that matches how `realPath` is spelled on this OS. */
export function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}
