/**
 * The map's own population: every live mine on the board, plus a drawable
 * stand-in for every remembered project the board has no entry for (#197).
 *
 * ## The gap this closes
 *
 * `mergeDeclaredMines` (main/domain/aggregate.ts) already folds a DECLARED
 * project with no running session into the board, so it reaches `state.mines`
 * and therefore the map. A project the app merely DISCOVERED before — no
 * declaration, nobody working it today — gets no such placeholder: it has a
 * row in the store and therefore a card in the Mines list (`browseRows`,
 * lib/browse/boardRows.ts, reading `queryProjects`), but the map, fed only
 * `state.mines`, never heard of it. The acceptance run's own words: the map
 * draws fewer mines than the list.
 *
 * `boardRows.ts` solved the mirror-image gap (#165): a live mine the STORE has
 * no row for still needs a card. This module is that fix run the other way —
 * a STORE row with no live mine still needs a marker — which is why it lives
 * beside `boardRows.ts` in spirit but not in the same folder: that module
 * builds `BrowseRow[]` for a list, keyed by whatever filters the panel has set;
 * this one builds `Mine[]` for `MapView`, which draws every remembered project
 * regardless of any search or tier the Mines panel happens to be showing.
 *
 * ## Matched by id, never by the `live` flag
 *
 * `ProjectSummary.live` is this poll's own reading and could in principle lag
 * a poll behind `state.mines` — matching against the ACTUAL live list rather
 * than trusting the flag is what keeps a live mine and its remembered project
 * from ever drawing as two markers for one project (#197's second half).
 */
import type { Mine, MineTier, ProjectSummary } from '../../types'

/**
 * A remembered project with nobody working it right now, drawn exactly as an
 * idle `mergeDeclaredMines` placeholder would be: no crew, nothing produced
 * this instant, and a tier that is a DRAWING placeholder rather than a sealed
 * fact (`tierOf()`'s own rule, #41) — `knownTier` is absent exactly when no
 * walk has measured this path, and bronze is what an unmeasured project draws
 * as everywhere else in the app. Nothing here records that placeholder
 * anywhere, which is what makes it safe to invent on every call.
 */
function idleMineFor(project: ProjectSummary): Mine {
  const tier: MineTier = project.knownTier ?? 'bronze'
  return {
    id: project.id,
    path: project.path,
    name: project.name,
    tier,
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 0,
    ...(project.materials === undefined ? {} : { materials: project.materials }),
    ...(project.declared ? { declared: true } : {}),
    ...(project.mapSite === undefined ? {} : { mapSite: project.mapSite })
  }
}

/**
 * Every mine the map should draw: the board unchanged, plus one idle stand-in
 * per remembered project the board has no entry for.
 *
 * The board's own mines are returned untouched — a live mine's crew, tokens
 * and `unrecorded` flag are never second-guessed here, only ever added to.
 */
export function mapMines(mines: readonly Mine[], projects: readonly ProjectSummary[]): Mine[] {
  const liveIds = new Set(mines.map((mine) => mine.id))
  const idle = projects.filter((project) => !liveIds.has(project.id)).map(idleMineFor)
  return [...mines, ...idle]
}
