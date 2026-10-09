// The snapshot's `asks` section (14 §3.7, §4.1, frozen; ADR-010 items 6, 9; ADR-003 item 7): every
// `open` or `answering` ask as ADR-010's `AskRecord`, on its `currentStep`, oldest first, with the
// needs-you queue (06 §0.2 `NeedsYouQueue`; ADR-032 D6). Read through the asking module's
// `AskQueries` read model from the stored rows (`asks_live`, `asks_needs_you`; owner amendment L
// `AskRepository.live`), never from the frames this Host sent, so the open asks survive the window
// closing and the Host restarting. `ui` only: a notifier or a viewer never reads it. Live updates:
// `ask.opened`, `ask.closed`, `ask.step` (frames/askFrames.ts). Registered by the asking wiring
// (later: ISSUE-140), it is advertised as `section:asks` (14 §4.4).
//
// - A closed ask is never listed: the read keeps the two live states only.
// - Synchronous like every provider (sectionRegistry.ts): the read runs within the one event-loop
//   turn the snapshot is built in, so the section reflects exactly the frames up to the snapshot's
//   `seq` (14 §4.2), and an ask opened later arrives as an `ask.opened` with a greater seq.
// - The asks and the queue come from one read, so the queue never names an ask the list lacks.
//
// Nothing here logs: the asks carry question text and tool summaries (14 §3.5 SENSITIVE_METHODS
// `session.snapshot`).
import type { AskSnapshotQueries } from '../../modules/asking'
import { toAskWire } from '../frames/askFrames'
import type { SectionProvider, SectionRegistry } from './sectionRegistry'

export interface AsksSectionDeps {
  asks: Pick<AskSnapshotQueries, 'snapshot'>
}

/** The `asks` provider over `deps`. */
export function asksSection(deps: AsksSectionDeps): SectionProvider<'asks'> {
  return () => {
    const { asks, needsYou } = deps.asks.snapshot()
    return {
      asks: asks.map(toAskWire),
      needsYou: needsYou.map(({ dwarfId, mineId, askedAt }) => ({ dwarfId, mineId, askedAt }))
    }
  }
}

/** Registers the `asks` section (`ui` only), so it is advertised as `section:asks`. */
export function registerAsksSection(sections: SectionRegistry, deps: AsksSectionDeps): void {
  sections.registerSection('asks', ['ui'], asksSection(deps))
}
