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

/** One project the user declared (#85), as the merge below needs to draw it. */
export interface DeclaredProject {
  path: string
  /**
   * The tier a walk has actually MEASURED for this project, when the store
   * holds one. Omitted means never walked, and the merge falls back to the
   * provisional placeholder for DRAWING only — nothing here records a decision,
   * so the #41 rule is satisfied by asking for a known tier and accepting none.
   */
  knownTier?: MineTier
}

/**
 * Fold the projects the user declared into the mines discovery produced (#85).
 *
 * A SECOND function rather than a second argument to aggregateMines, because
 * that function's contract is that a mine is a projection of the snapshots and
 * nothing else — it exists to answer "who is working where right now", and a
 * mine it emitted for a project nobody is in would make its own doc a lie and
 * every one of its callers ask a question it no longer answers. Composed
 * instead: aggregation stays single-source and pure, this step is single-source
 * over the declared list and pure, and the runtime is the one place that knows
 * the board is both.
 *
 * A declared project that IS being worked merges into the discovered mine
 * rather than doubling it — same path, same `mineIdForPath`, one mine — and the
 * live reading wins on everything except the declaration itself. The input
 * mines are never mutated; a stamped copy takes the original's place.
 */
export function mergeDeclaredMines(
  mines: Mine[],
  declared: readonly DeclaredProject[],
  tierOf: (path: string) => MineTier,
  platform: Platform = currentPlatform()
): Mine[] {
  if (declared.length === 0) return mines

  const output = [...mines]
  const indexByKey = new Map<string, number>()
  output.forEach((mine, index) => indexByKey.set(normalizeKey(mine.path, platform), index))

  for (const project of declared) {
    const displayPath = trimTrailingSlashes(project.path)
    const key = normalizeKey(displayPath, platform)
    const index = indexByKey.get(key)
    if (index !== undefined) {
      output[index] = { ...output[index]!, declared: true }
      continue
    }
    indexByKey.set(key, output.length)
    output.push({
      id: mineIdForPath(displayPath, platform),
      path: displayPath,
      name: lastSegment(displayPath),
      // A measured tier when there is one, the provisional bronze otherwise:
      // an unwalked mine is drawn as the poorest thing it could be, which is
      // exactly what that placeholder is for.
      tier: project.knownTier ?? tierOf(displayPath),
      dwarfs: [],
      tokensObserved: 0,
      // Nothing has happened in it. The board sorts by activity, so a crewless
      // declared mine belongs behind every project that has any.
      updatedAt: 0,
      declared: true
    })
  }

  return output.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Stamp each mine with the spawn location the projects store remembers for it
 * (#136).
 *
 * A third composed step, for the same reason `mergeDeclaredMines` is a second
 * one: where a mine STANDS is a remembered fact off disk, and aggregation is a
 * projection of this poll's snapshots. Folding a store lookup into either would
 * make both answer a question they do not own.
 *
 * A mine the store has not placed is left with no `mapSite` at all rather than
 * a zero or a -1. Absent is a state the panel already knows how to draw — it
 * places that mine itself, deterministically — and it is the only reading that
 * stays true for a simulated valley, which never touches the store (#42).
 *
 * The input mines are never mutated; stamped copies take their place, and a
 * list with nothing to stamp comes back as itself.
 */
export function stampMapSites(mines: Mine[], siteByMineId: ReadonlyMap<string, number>): Mine[] {
  if (siteByMineId.size === 0) return mines
  return mines.map((mine) => {
    const site = siteByMineId.get(mine.id)
    return site === undefined ? mine : { ...mine, mapSite: site }
  })
}

/**
 * Mark every mine the projects store holds no row for (#165).
 *
 * A fourth composed step, for the reason `stampMapSites` is a third one: what
 * the STORE knows is a remembered fact off disk, and aggregation is a
 * projection of this poll's snapshots.
 *
 * The correction it exists for: the map draws the board and the Mines list
 * draws store rows, so a mine could stand on the map with no card beside it —
 * the third acceptance run photographed exactly that. They are one world, and
 * this is the join. Three kinds of mine reach it honestly: one whose crew is
 * only leaving or waiting, which the project observer deliberately does not
 * count as a sighting; one in the poll or two before its first row is written;
 * and a simulated valley, which never touches the store at all (#42).
 *
 * `recorded` is `null` when the store has never answered. That is not an empty
 * store — it is no reading at all, and treating it as "none of these are
 * recorded" would put the whole board in the list a second time. Nothing is
 * stamped, and the panel goes on drawing what it always did.
 *
 * Absent means recorded, exactly like every other optional fact on the wire:
 * only a mine main can positively say is missing carries the flag. The input is
 * never mutated; stamped copies take its place.
 */
export function stampUnrecorded(mines: Mine[], recorded: ReadonlySet<string> | null): Mine[] {
  if (recorded === null) return mines
  return mines.map((mine) => (recorded.has(mine.id) ? mine : { ...mine, unrecorded: true }))
}

/**
 * One mine per project id, whatever the board was assembled from (#156).
 *
 * The second acceptance run photographed four markers over three projects. The
 * board is assembled from four sources — the provider snapshots, the projects
 * the user declared, the placement stamp, and the lifecycle tracker's memory of
 * a session that has just ended — and every one of them derives its id through
 * `mineIdForPath`. So two mines that reach the same board under one id ARE one
 * project, and drawing both is never right: the map keys its markers by mine id
 * and places an unplaced mine itself, so a double shows up as one project
 * standing in two places at once.
 *
 * The last step of the assembly rather than a fifth rule inside each join: an
 * invariant checked where the whole board is in one list cannot be broken by the
 * next join somebody adds.
 *
 * A MERGE, never a pick. Dropping the second mine would take a live agent off
 * the board, which is a worse failure than the double it fixes — so the crews
 * are concatenated (a dwarf that reached the board twice is still listed once),
 * the observed tokens are summed because they are counted per dwarf, and the
 * facts only one side is likely to carry — a persisted location, a declaration —
 * survive from whichever side has them. The input is never mutated, and a board
 * with nothing to collapse comes back as itself.
 */
export function collapseDuplicateMines(mines: Mine[]): Mine[] {
  const byId = new Map<string, Mine>()
  for (const mine of mines) {
    const seen = byId.get(mine.id)
    if (seen === undefined) {
      byId.set(mine.id, mine)
      continue
    }
    const dwarfIds = new Set(seen.dwarfs.map((dwarf) => dwarf.id))
    byId.set(mine.id, {
      ...seen,
      dwarfs: [...seen.dwarfs, ...mine.dwarfs.filter((dwarf) => !dwarfIds.has(dwarf.id))],
      tokensObserved: seen.tokensObserved + mine.tokensObserved,
      updatedAt: Math.max(seen.updatedAt, mine.updatedAt),
      ...(seen.mapSite === undefined && mine.mapSite !== undefined
        ? { mapSite: mine.mapSite }
        : {}),
      ...(seen.declared === true || mine.declared === true ? { declared: true } : {})
    })
  }
  return byId.size === mines.length ? mines : [...byId.values()]
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

/**
 * A path without the trailing separators a picker or a shell may hand over —
 * unless that is the whole of it.
 *
 * The nameless mine of the third acceptance run (#165). A live session whose
 * cwd is a filesystem root (`/`, and `\` on a UNC-rooted shell) is all
 * separator: trimming leaves the empty string, which then has no last segment
 * either, so the mine reached the panel with an empty path AND an empty name
 * and the card drew nothing where a project belongs. A root is a real place a
 * session can run, so it keeps its own characters; `C:\` still trims to `C:`,
 * because there the drive letter is the segment.
 */
function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? path : trimmed
}

function normalizeKey(path: string, platform: Platform): string {
  return normalizePathKey(trimTrailingSlashes(path), platform)
}

function lastSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}
