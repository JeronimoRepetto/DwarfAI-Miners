import type { Mine, MineTier, ProviderSnapshot } from './types'

/**
 * Group provider snapshots into mines: one mine per real project path,
 * compared case-insensitively (win32). The tier callback must never block
 * (TierService serves cached values), and is asked once per mine.
 */
export function aggregateMines(
  snapshots: ProviderSnapshot[],
  tierOf: (path: string) => MineTier
): Mine[] {
  const byPath = new Map<string, Mine>()

  for (const snapshot of snapshots) {
    const key = normalizeKey(snapshot.cwd)
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

function normalizeKey(path: string): string {
  return trimTrailingSlashes(path).replace(/\//g, '\\').toLowerCase()
}

function lastSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}
