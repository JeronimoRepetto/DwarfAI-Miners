/*
 * When the Mines list on screen must be read again (#635, PANEL-QUESTIONS 29 live check).
 *
 * The list is store rows read on panel open and on entering Mines, and nothing pushes them: a
 * walk that answered while the page stayed open never reached its card, so a new mine stayed
 * "Measuring…" after the mine column had its tier, and a re-measured one never showed its score.
 * The board is what main pushes, and it carries each mine's measured weight (`Mine.weightBytes`,
 * this run's reading off the same cache as `ProjectSummary.weightBytes`). So the list is behind
 * exactly where a board mine it has a row for carries a weight the row does not: a first walk
 * answering, a re-measure moving the score or the tier, a folder gone and walked empty.
 *
 * Bounded twice over: nothing is due while the two agree, which is every poll once a re-read has
 * landed; and each reading is asked for once, so a row that never catches up (a refused read, a
 * store that lags) is not re-read on every poll. A burst of readings is one re-read.
 */
import type { Mine, ProjectSummary } from '../../types'

export interface BrowseRefresh {
  /** Whether the list is behind the board on a reading no re-read has been asked for yet. */
  due(board: readonly Mine[], rows: readonly ProjectSummary[]): boolean
}

export function createBrowseRefresh(): BrowseRefresh {
  // The board weight each mine last asked a re-read for.
  const asked = new Map<string, number>()
  return {
    due(board, rows) {
      const rowById = new Map(rows.map((row) => [row.id, row]))
      let due = false
      for (const mine of board) {
        const row = rowById.get(mine.id)
        // No row: the list draws that mine off the board itself. No weight: nothing to catch.
        if (row === undefined || mine.weightBytes === undefined) continue
        if (row.weightBytes === mine.weightBytes) continue
        if (asked.get(mine.id) === mine.weightBytes) continue
        asked.set(mine.id, mine.weightBytes)
        due = true
      }
      return due
    }
  }
}
