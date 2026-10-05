// Driven port of observation (05 §3.3, 16 §4.3 `CursorStore`): the stream positions of
// `source_cursors` (09 §4.2). Type-only (05 §2.2).
//
// - A cursor only moves forward (INV-35; ADR-006 item 3): `advance` with a lower value, or with
//   another kind, throws, so the batch transaction it runs in rolls back whole (09 §4.2 trigger
//   `source_cursors_never_regress`). The same value again changes nothing.
// - `advance` runs inside the batch transaction, after the facts the batch produced (16 §4.3
//   "Ordering"); outside a transaction it is a programming error (`HostInvariantError`).
// - A file that shrank or was replaced is a new stream id (FM-087), never a lower value.
import type { SourceKey } from '../../suppliers'
import type { Cursor } from './observationAdapter'

export interface CursorStore {
  get(source: SourceKey): Cursor | null
  advance(source: SourceKey, c: Cursor): void
} // never regresses

/** The message of the throw that aborts a batch whose cursor would move back (09 §4.2). */
export const CURSOR_REGRESSION = 'CURSOR_REGRESSION'
