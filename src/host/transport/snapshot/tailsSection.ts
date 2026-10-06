// The snapshot's `tails` section (14 §3.7, §4.1, frozen; ADR-003 item 7; ADR-007 item 6): for each
// present dwarf of the board, its newest `SNAPSHOT_TAIL = 20` stored messages as `MessageView`,
// newest first, with `reachedStart` true once the oldest stored row is among them. Read from the
// Host's message log through `ConversationQueries.feed` — the same read `conversation.feed` pages
// (methods/conversationFeed.ts) — never from a provider, so a reopened chat paints at once and
// pages the rest on demand (ADR-007 item 6). `ui` only. Live updates: `conversation.appended`
// (frames/conversationAppended.ts). Registered before the bind by the conversation wiring
// (host/wiring/routes/conversation.ts, ISSUE-108), it is advertised as `section:tails` (14 §4.4).
//
// - Present dwarfs only, in the `dwarfs` section's order (sections/dwarfs.ts: the mines in board
//   order, each mine's crew in `crewOf` order), so a tail is never sent for a dwarf the board does
//   not show. The SnapshotService places the tails after the board chunks, interleaved per dwarf
//   with `marks` (14 §4.2; `marks` is ISSUE-166's).
// - Synchronous like every provider (sectionRegistry.ts): each feed read runs within the one
//   event-loop turn the snapshot is built in, so the tails reflect exactly the frames up to the
//   snapshot's `seq` (14 §4.2), and a later `conversation.appended` has a greater seq.
//
// Nothing here logs: the tails carry message text (14 §3.5 SENSITIVE_METHODS `session.snapshot`).
import type { DwarfId } from '../../kernel/domain/values'
import type { ConversationQueries } from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import { toMessageWire } from '../mappers/wire'
import { SNAPSHOT_TAIL } from './metaSection'
import type { SectionProvider, SectionRegistry } from './sectionRegistry'

export interface TailsSectionDeps {
  mines: Pick<MinesQueries, 'list'>
  crew: Pick<CrewQueries, 'crewOf'>
  conversation: Pick<ConversationQueries, 'feed'>
}

/** The present dwarfs of the board, in the `dwarfs` section's order. */
function presentDwarfs(deps: TailsSectionDeps): DwarfId[] {
  return deps.mines
    .list({ sortBy: 'name', direction: 'asc' })
    .flatMap((mine) => deps.crew.crewOf(mine.mineId))
    .filter((dwarf) => !dwarf.departed)
    .map((dwarf) => dwarf.id)
}

/** The `tails` provider over `deps`. */
export function tailsSection(deps: TailsSectionDeps): SectionProvider<'tails'> {
  return () =>
    presentDwarfs(deps).map((dwarfId) => {
      const page = deps.conversation.feed(dwarfId, { limit: SNAPSHOT_TAIL })
      return {
        dwarfId,
        messages: page.messages.map(toMessageWire),
        reachedStart: page.reachedStart
      }
    })
}

/** Registers the `tails` section (`ui` only), so it is advertised as `section:tails`. */
export function registerTailsSection(sections: SectionRegistry, deps: TailsSectionDeps): void {
  sections.registerSection('tails', ['ui'], tailsSection(deps))
}
