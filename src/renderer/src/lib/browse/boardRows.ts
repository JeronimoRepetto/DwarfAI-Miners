/**
 * One world for the map and the Mines list (#165).
 *
 * ## The disagreement
 *
 * The map draws the BOARD — every project a session is working right now, plus
 * the ones the user declared — and the Mines list draws STORE ROWS. Those are
 * two different questions, and the third acceptance run photographed the gap
 * between them: a mine standing on the map with no card anywhere in the list.
 *
 * It is not a bug in either half. The project observer deliberately records
 * only a project with a WORKING crew (a resting or leaving one is not a
 * sighting), a newly discovered project has no row for the poll or two before
 * its first write, and a simulated valley never touches the store at all (#42).
 * All three are honest board mines with nothing behind them.
 *
 * ## The rule
 *
 * **Every mine on the map has a card in the list.** Where the store answered
 * with a row, that row is the card, exactly as before. Where main can say the
 * store holds no row (`Mine.unrecorded` — see stampUnrecorded in main), the
 * panel builds the card from the board itself and marks it unrecorded.
 *
 * The direction matters: the LIST gains an identity, the map does not gain a
 * label. A marker is already the smallest thing on screen and the tooltip
 * already spends its three lines; a card has room to say what it does not know.
 *
 * ## What an unrecorded row may claim
 *
 * Only what the board can see: the project's name, its path, and that a session
 * is in it. Never a tier — the board's `tier` is `tierOf()`'s provisional
 * placeholder and #41 forbids stating it as a fact — never a weight, never a
 * material breakdown, and never a date it was added, because it was not.
 */
import type { BrowseRow, Mine, MineTier, ProjectSummary } from '../../types'

/** What the list is filtering by, as much of it as this join can honour. */
export interface BoardRowFilters {
  search: string
  tier: MineTier | null
}

/**
 * The searchable form of a name: NFD-decomposed, diacritics dropped, lowercased.
 *
 * A deliberate copy of `normalizeProjectName` in main/projects/projectName.ts,
 * which the renderer cannot import. It has to be the same fold or a search that
 * finds a stored `Cafetería` would miss the live one standing beside it — the
 * user typed one term and would get two different answers from one list.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * One board mine as the list would draw it, claiming only what the board saw.
 *
 * `addedAt: 0` is the one field with no honest answer: the row does not exist,
 * so there is no date it was added. Zero is what the list sorts unadded things
 * to the end by, and nothing on the card prints it.
 */
function rowFor(mine: Mine): BrowseRow {
  return {
    id: mine.id,
    path: mine.path,
    name: mine.name,
    // A mine the store has no row for cannot be a declared one: declaring a
    // folder is what writes the row.
    declared: false,
    addedAt: 0,
    // It is on the board this poll produced, which is exactly what live means.
    live: true,
    unrecorded: true
  }
}

/**
 * The cards the board contributes that the answered page does not carry.
 *
 * A mine main did not flag is left alone — absent is not false, and a store
 * that never answered says nothing about any mine, so reading its silence as
 * "none of these are recorded" would list the entire board a second time.
 *
 * A tier filter excludes every unrecorded row, because an unrecorded mine has
 * no measured tier and may claim none. That is the rule an unmeasured stored
 * project already lives under: All is the only chip it appears under (#92).
 */
export function unrecordedRows(
  mines: readonly Mine[],
  projects: readonly ProjectSummary[],
  filters: BoardRowFilters
): BrowseRow[] {
  if (filters.tier !== null) return []
  const listed = new Set(projects.map((project) => project.id))
  const term = foldForSearch(filters.search)
  return mines
    .filter((mine) => mine.unrecorded === true && !listed.has(mine.id))
    .filter((mine) => term === '' || foldForSearch(mine.name).includes(term))
    .map(rowFor)
}

/**
 * The whole list: the board's own mines first, then the page the store
 * answered with.
 *
 * First because they are the freshest thing the panel holds — a session working
 * right now — while the page behind them is ordered by the date each project
 * was added, which an unrecorded mine has no answer for at all.
 */
export function browseRows(
  projects: readonly ProjectSummary[],
  mines: readonly Mine[],
  filters: BoardRowFilters
): BrowseRow[] {
  return [...unrecordedRows(mines, projects, filters), ...projects]
}
