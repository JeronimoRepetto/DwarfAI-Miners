import { currentPlatform, normalizePathKey, type Platform } from '../platform/platform'
import type { Dwarf, Mine, MineTier, ProviderSnapshot } from './types'

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
        id: mineIdForPath(snapshot.cwd, platform),
        path: displayPath,
        name: lastSegment(displayPath),
        tier: tierOf(displayPath),
        dwarfs: [],
        tokensObserved: 0,
        updatedAt: snapshot.updatedAt
      }
      byPath.set(key, mine)
    }
    mine.dwarfs.push(...snapshot.dwarfs)
    mine.updatedAt = Math.max(mine.updatedAt, snapshot.updatedAt)
  }

  const mines = [...byPath.values()]
  // Computed once the full crew is known, after every snapshot has been folded in.
  for (const mine of mines) mine.tokensObserved = sumDwarfTokens(mine.dwarfs)
  return mines.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The mine id for one project path, using the same platform-aware
 * normalization aggregateMines groups by.
 *
 * Exported because the coal backfill has to name mines for projects it found
 * on disk, with no provider snapshot to group. If the two derivations ever
 * drifted, historical coal would be credited to a mine id that never appears
 * beside the live one and would silently vanish from the per-mine view.
 */
export function mineIdForPath(path: string, platform: Platform = currentPlatform()): string {
  return `mine:${normalizeKey(path, platform)}`
}

function sumDwarfTokens(dwarfs: Dwarf[]): number {
  return dwarfs.reduce((total, dwarf) => total + (dwarf.tokensObserved ?? 0), 0)
}

/**
 * The vault total for the mines-update payload: sum of every mine's
 * tokensObserved. A pure post-processing step over aggregateMines' own
 * output, so the main process and its tests can derive one grand total
 * without re-walking dwarfs.
 */
export function sumTokensObserved(mines: Mine[]): number {
  return mines.reduce((total, mine) => total + mine.tokensObserved, 0)
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
