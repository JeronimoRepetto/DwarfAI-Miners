// The snapshot's `mines` section (14 §4.1, frozen; ADR-003 item 7): every mine on the board — not
// removed — as `MineWire`, with its six material totals (INV-93), read from the mines public
// queries and the ledger totals within the one event-loop turn the snapshot is built in (14 §4.2;
// the provider is synchronous by type, sectionRegistry.ts). `ui` only. Registered by the
// composition root over the wired module (later: ISSUE-093), it is advertised as `section:mines`
// from then on (14 §4.4). Live updates: `mine.changed` (frames/board.ts), `mine.removed` (later:
// ISSUE-080), `ledger.changed` (later: ISSUE-076).
//
// Board order: by name, ties by id (the order of `MinesQueries.list`, total, 16 §4.1); a removed
// mine is never listed (09 §4.11), and one removed between the list and its read is left out.
import type { MinesQueries, MineView } from '../../../modules/mines'
import { toMineWire, type MineTotalsReader } from '../../mappers/wire'
import type { SectionProvider, SectionRegistry } from '../sectionRegistry'

export interface MinesSectionDeps {
  mines: Pick<MinesQueries, 'list' | 'get'>
  /** The ledger's totals (`WiredLedger.totals`, ISSUE-096; `NO_LEDGER_TOTALS` without a ledger). */
  ledger: MineTotalsReader
}

/** Every mine on the board now, in board order. */
export function minesOnBoard(mines: Pick<MinesQueries, 'list' | 'get'>): MineView[] {
  const onBoard: MineView[] = []
  for (const summary of mines.list({ sortBy: 'name', direction: 'asc' })) {
    const view = mines.get(summary.mineId)
    if (view !== null) onBoard.push(view)
  }
  return onBoard
}

/** The `mines` provider over `deps`. */
export function minesSection(deps: MinesSectionDeps): SectionProvider<'mines'> {
  return () =>
    minesOnBoard(deps.mines).map((view) => toMineWire(view, deps.ledger.totalsOf(view.id)))
}

/** Registers the `mines` section (`ui` only), so it is advertised as `section:mines`. */
export function registerMinesSection(sections: SectionRegistry, deps: MinesSectionDeps): void {
  sections.registerSection('mines', ['ui'], minesSection(deps))
}
