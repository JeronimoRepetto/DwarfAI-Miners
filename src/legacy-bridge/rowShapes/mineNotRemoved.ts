// A-32's failure shape while `LegacyEndFirstAdapter` ends a mine's legacy-launched sessions first (21 §3 row
// `LegacyEndFirstAdapter`): 14 §2.1 A-32 maps the `dwarf-could-not-be-ended` outcome of B-M18 `mines.remove` to today's
// `MineUndeclareResult` "unchanged" shape, `{ outcome: 'unchanged', reason }`. The reason is the contract's outcome
// code, not new copy; the one danger toast arrives as a frame (14 §2.1 A-32 Notes).
//
// Deleted with the adapter at the end of cut 4 (later: ISSUE-241).
import type { MineUndeclareResult } from '../../main/domain/types'

/** A-32 when a legacy-launched session of the mine could not be ended: nothing removed, nothing relayed. */
export const MINE_DWARF_NOT_ENDED: MineUndeclareResult = {
  outcome: 'unchanged',
  reason: 'dwarf-could-not-be-ended'
}
