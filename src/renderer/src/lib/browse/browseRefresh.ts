/*
 * When the Mines list on screen must be read again (#635, PANEL-QUESTIONS 29 live check).
 *
 * The list is store rows read on panel open and on entering Mines, and nothing pushes them: a
 * walk that answered while the page stayed open never reached its card, so a new mine stayed
 * without its tier after the mine column had it. The board is what the Host pushes, and since
 * AMENDMENT-26 (owner-approved 2026-10-23) each measured mine on it carries its reading
 * (`MineWire.score`) with the tier that reading decided. The card already draws the ore, the
 * score and the measuring state off the board (mineCard.ts); the row's own part is the tier
 * (`mines.list`, 14 B-M19), which the tier chip, the tier filter and the tier order read. So the
 * list is behind exactly where a board mine it has a row for has a reading whose tier the row
 * does not show: a first walk answering, a re-measure moving the tier, a folder walked empty.
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
  // The board reading (score, in KB) each mine last asked a re-read for.
  const asked = new Map<string, number>()
  return {
    due(board, rows) {
      const rowById = new Map(rows.map((row) => [row.id, row]))
      let due = false
      for (const mine of board) {
        const row = rowById.get(mine.id)
        // No row: the list draws that mine off the board itself. No reading: nothing to catch.
        if (row === undefined || mine.score === undefined) continue
        // A reading's tier is measured, never the placeholder: a board mine with a score has one.
        if (row.knownTier === mine.tier) continue
        if (asked.get(mine.id) === mine.score.kb) continue
        asked.set(mine.id, mine.score.kb)
        due = true
      }
      return due
    }
  }
}
