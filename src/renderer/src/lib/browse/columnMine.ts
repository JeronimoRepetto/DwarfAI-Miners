/*
 * The mine the mine column draws (#635, PANEL-QUESTIONS 5, design lead ruling 2026-09-27).
 *
 * A remembered mine with no dwarf and no live session is an ordinary card: it reads "No dwarfs" and
 * opens, onto the empty roster "No dwarfs here yet." and + Dwarf, which is where dwarfs are
 * launched. The board does not carry such a mine, so the column is drawn from the store row the
 * card was built from, claiming only what that row knows: no crew, no ore it has not recorded, and
 * the tier on the Bronze placeholder until a walk has measured one. That placeholder is for drawing
 * (tierOf's rule, #41); nothing the column draws records a decision.
 *
 * Only a missing folder makes a mine not enterable (PANEL-QUESTIONS 6), so only that row is left
 * out.
 */
import { MINE_TIERS } from '../../types'
import type { Mine, ProjectSummary } from '../../types'

/** Whether a remembered row may be opened: every one but a folder that is gone. */
function openable(project: ProjectSummary): boolean {
  return project.folderMissing !== true
}

/** The board's mine by id, or else the remembered one, drawn with no crew. */
export function columnMine(
  mineId: string,
  board: readonly Mine[],
  projects: readonly ProjectSummary[]
): Mine | undefined {
  const onBoard = board.find((mine) => mine.id === mineId)
  if (onBoard !== undefined) return onBoard
  const project = projects.find((one) => one.id === mineId)
  if (project === undefined || !openable(project)) return undefined
  return {
    id: project.id,
    path: project.path,
    name: project.name,
    tier: project.knownTier ?? MINE_TIERS[0]!,
    dwarfs: [],
    tokensObserved: 0,
    ...(project.materials === undefined ? {} : { materials: project.materials }),
    updatedAt: 0
  }
}

/** Every mine the column may hold open: the board's, and every remembered one it could draw. */
export function openableMineIds(
  board: readonly Mine[],
  projects: readonly ProjectSummary[]
): string[] {
  return [
    ...board.map((mine) => mine.id),
    ...projects.filter(openable).map((project) => project.id)
  ]
}
