import { useMines } from '../composables/useMines'
import type { MaterialTotals, Mine } from '../types'

/**
 * The board a renderer test draws, in the shape `useMines().state` keeps (ADDED for ISSUE-242, cut 5).
 *
 * Until cut 5 a test handed the shell its board through A-12 `getMines` and A-P2 `onMinesUpdated`; both left with
 * `BoardFacadeAdapter`, and the Host read model (`useMines`, A-N01/A-N02) is the board's one writer. Its own tests
 * (`useMines.test.ts`) prove how Host snapshots and frames become this state; a test of what the shell or a component
 * does WITH the board writes the state here instead, as one publish of the read model would.
 */
export interface TestBoard {
  mines: Mine[]
  tokensObserved?: number
  materials?: MaterialTotals
}

/** The empty board a shell shows before any mine is worked. */
export const EMPTY_BOARD: TestBoard = { mines: [], tokensObserved: 0 }

/**
 * Publishes a whole board, as the read model does after a snapshot or a batch of frames. `arrived` is every dwarf not
 * on the board before, unless the board is `fresh` (the first one a test shows, where nobody walks in: S2.03).
 */
export function publishBoard(board: TestBoard, fresh = false): void {
  const { state } = useMines()
  const before = new Set(state.mines.flatMap((mine) => mine.dwarfs.map((dwarf) => dwarf.id)))
  const ids = board.mines.flatMap((mine) => mine.dwarfs.map((dwarf) => dwarf.id))
  state.arrived = fresh ? new Set() : new Set(ids.filter((id) => !before.has(id)))
  state.mines = board.mines
  state.tokensObserved =
    board.tokensObserved ?? board.mines.reduce((sum, mine) => sum + mine.tokensObserved, 0)
  state.materials = board.materials
}

/** Forgets the board a test left behind: the read model is a singleton shared by every test in a file. */
export function resetBoard(): void {
  useMines().stop()
  useMines().clear()
}
