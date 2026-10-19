// The crew events of the Host-requested ends (08 §0; 16 §4.2 `stop` / `endAllIn` / `endOwned`), over
// the kernel envelope (08 §1.2). The machine events (arrival, status, presence, departure) are
// `domain/events.ts`'s `CrewEvent`; these two belong to the end commands, which publish them around
// an outside call (`SessionTerminator.end`, 16 §2.2), on the Host bus `host/wiring` hands them
// (`Crew.ends`), so they sit with those use cases as their own union. Each is published after the
// transaction that set or cleared `stopInFlight` committed (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId } from '../../../kernel/domain/values'
import type { EndReason } from '../domain/presence'

/**
 * The Host is about to end the dwarf's session (08 §0; 07 S4.05, S15.02). Its one required handler,
 * launching's `markStoppedByPerson`, runs before the end (16 §2.3, AR-24).
 */
export type DwarfStopRequested = DomainEvent<
  'DwarfStopRequested',
  { dwarfId: DwarfId; requestId: string; why: EndReason }
>

/**
 * The end failed and the dwarf stays with its real status (08 §0; 07 S2.15, S4.07, S15.15). A toast
 * names it only for `why = 'stop-dwarf'`; a Remove mine or a stop-all tells it in its one grouped
 * message (ADR-014 items 6, 9).
 */
export type DwarfStopFailed = DomainEvent<
  'DwarfStopFailed',
  { dwarfId: DwarfId; requestId: string; why: EndReason; reason: 'could-not-end' }
>

/** The events of the end commands. */
export type CrewEndEvent = DwarfStopRequested | DwarfStopFailed
