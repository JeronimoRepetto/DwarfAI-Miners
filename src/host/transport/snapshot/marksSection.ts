// The snapshot's `marks` section (14 §4.1, §4.2, frozen; ADR-022 item 6; ISSUE-166): the `Delivery`
// of every message in the `tails` that has one — the Host's current phase, confidence, hold and
// failure of each — so a window that closes and reopens shows exactly the phase the Host recorded
// meanwhile, never one it computed (OQ-25, PO #86; 07 S7.18). `ui` only. Live updates:
// `message.delivery` (B-F12).
//
// - Read from the same rows as `tails` (tailsSection.ts: the present dwarfs in the `dwarfs`
//   section's order, the newest `SNAPSHOT_TAIL` rows of each, through `ConversationQueries.feed`),
//   synchronously within the snapshot's one event-loop turn, so a mark matches its tail row at the
//   snapshot's `seq` (14 §4.2). The SnapshotService interleaves it per dwarf after that dwarf's tail.
// - A row with no delivery (a provider row) has no mark.
//
// Nothing here logs.
import type { DwarfId } from '../../kernel/domain/values'
import { toMessageWire } from '../mappers/wire'
import { SNAPSHOT_TAIL } from './metaSection'
import type { SectionProvider, SectionRegistry } from './sectionRegistry'
import type { TailsSectionDeps } from './tailsSection'

export type MarksSectionDeps = TailsSectionDeps

/** The present dwarfs of the board, in the `dwarfs` section's order, as `tails` reads them. */
function presentDwarfs(deps: MarksSectionDeps): DwarfId[] {
  return deps.mines
    .list({ sortBy: 'name', direction: 'asc' })
    .flatMap((mine) => deps.crew.crewOf(mine.mineId))
    .filter((dwarf) => !dwarf.departed)
    .map((dwarf) => dwarf.id)
}

/** The `marks` provider over `deps`. */
export function marksSection(deps: MarksSectionDeps): SectionProvider<'marks'> {
  return () =>
    presentDwarfs(deps).flatMap((dwarfId) =>
      deps.conversation.feed(dwarfId, { limit: SNAPSHOT_TAIL }).messages.flatMap((message) => {
        const delivery = toMessageWire(message).delivery
        return delivery === undefined ? [] : [delivery]
      })
    )
}

/** Registers the `marks` section (`ui` only), so it is advertised as `section:marks`. */
export function registerMarksSection(sections: SectionRegistry, deps: MarksSectionDeps): void {
  sections.registerSection('marks', ['ui'], marksSection(deps))
}
