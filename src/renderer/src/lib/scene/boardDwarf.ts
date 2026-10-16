/*
 * The board's dwarf as the Host feeds it (ISSUE-254; ADR-032, ADR-033 item 3): today's `Dwarf`, plus
 * the status the Host computed for it. Today's three-state `status` cannot say idle apart from asleep,
 * so the Host's own word rides beside it, read first wherever the scene draws a dwarf
 * (sceneDwarfStatus). Absent on the feed of today, which falls back to today's mapping.
 *
 * A renderer-side extension rather than a new field on the shared `Dwarf`: `src/shared/**` is legacy
 * and takes no new code (AGENTS §3.2), and the extension goes with today's board.
 */
import type { DwarfStatus } from '@dwarfai/contracts'
import type { Dwarf } from '../../types'

export interface BoardDwarf extends Dwarf {
  /** The Host's status for this dwarf (ADR-032 D2), never derived here. Absent off the Host. */
  hostStatus?: DwarfStatus
}
