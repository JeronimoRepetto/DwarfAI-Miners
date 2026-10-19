// The Panel's reveal of a dwarf's chat (ISSUE-114; ADR-018 item 6 "Panel"; ADR-025 item 8; 14 §2.2 A-N16): UI main
// pushes `onRevealDwarfChat {mineId, dwarfId | null}` to the Panel window, and the Panel's renderer selects the mine,
// brings the dwarf's card into view and opens its chat, or opens the mine with no chat when `dwarfId` is null (the
// dwarf left, `'mine-only'`). The payload is the registry's (14 §3.8): ids only, a fresh object, never more fields.
//
// The windows the push reaches are the composition's: the Panel windows while the route table routes A-N16, none
// before (unrouted until the cut-1 switch, ISSUE-123; `src/contracts/ipc/unrouted.ts`), as every UI-main push is
// composed (A-N04, A-N12, A-N19).
import type { ChannelKey } from '@dwarfai/contracts'
import type { ModeReveal } from '../application/revealDwarfChat'
import type { ModeWindowSender } from '../application/uiPreferences'

/** A-N16 `onRevealDwarfChat` (14 §2.2): the successor of A-P5 `onShowMine`; the Host never pushes a "show". */
export const REVEAL_DWARF_CHAT_PUSH = 'mode:revealDwarfChat' satisfies ChannelKey

/** The Panel's `ModeReveal`: one A-N16 push to each Panel window `panels()` answers. */
export function createPanelReveal(panels: () => readonly ModeWindowSender[]): ModeReveal {
  return {
    reveal({ mineId, dwarfId }) {
      for (const panel of panels()) panel.send(REVEAL_DWARF_CHAT_PUSH, { mineId, dwarfId })
    }
  }
}
