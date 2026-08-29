import { currentPlatform, normalizePathKey, type Platform } from '../platform/platform'
import type { Mine, MineTier, ProviderSnapshot } from './types'

/**
 * Group provider snapshots into mines: one mine per real project path.
 *
 * Two paths name the same project when their platform-normalized keys match —
 * case-insensitively on Windows and macOS, case-SENSITIVELY on Linux, where
 * /home/j/Proj and /home/j/proj are two different directories and folding them
 * would merge two projects into one mine. The tier callback must never block
 * (TierService serves cached values), and is asked once per mine.
 */
export function aggregateMines(
  snapshots: ProviderSnapshot[],
  tierOf: (path: string) => MineTier,
  platform: Platform = currentPlatform()
): Mine[] {
  const byPath = new Map<string, Mine>()

  for (const snapshot of snapshots) {
    const key = normalizeKey(snapshot.cwd, platform)
    let mine = byPath.get(key)
    if (mine === undefined) {
      const displayPath = trimTrailingSlashes(snapshot.cwd)
      mine = {
        id: `mine:${key}`,
        path: displayPath,
        name: lastSegment(displayPath),
        tier: tierOf(displayPath),
        dwarfs: [],
        updatedAt: snapshot.updatedAt
      }
      byPath.set(key, mine)
    }
    mine.dwarfs.push(...snapshot.dwarfs)
    mine.updatedAt = Math.max(mine.updatedAt, snapshot.updatedAt)
  }

  return [...byPath.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function normalizeKey(path: string, platform: Platform): string {
  return normalizePathKey(trimTrailingSlashes(path), platform)
}

function lastSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}
