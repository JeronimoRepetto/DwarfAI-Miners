// The conversation module's domain events (08 §0, §2.6), over the kernel envelope (08 §1.2). Each is
// published after the transaction that wrote its rows committed, and only for new keys (08 §5.1).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import type { MessageView } from './messages'
import type { OutcomeLine } from './outcomeLine'

/** 08 §0: the rows one batch inserted, never a merged echo or a dropped record. */
export type MessagesAppended = DomainEvent<
  'MessagesAppended',
  { dwarfId: DwarfId; messages: MessageView[] }
>

/**
 * 08 §0, §2.6: a turn end recorded once per `turn:<dwarfId>:<turnKey>`, whichever path reported it
 * (ADR-021 item 3). Its payload `end` is the ADR-021 `TurnEnded`, reliable or inferred.
 */
export type TurnEndedEvent = DomainEvent<'TurnEnded', { dwarfId: DwarfId; end: TurnEnded }>

/**
 * 08 §0, §2.6: an activity run opened, grew or closed (07 §11), keyed (disclosureId, stepCount,
 * open); one per changed run per committed transaction, with the run's final state in it, its
 * one-line step summaries included (never tool output, ADR-007 item 4), so the `activity.changed`
 * frame (14 §3.6 `ActivityWire`) is built from the event alone, also for a closed run.
 */
// Amended: 08 §0 ActivityChanged gains summaries (owner amendment E, 2026-10-06)
export type ActivityChanged = DomainEvent<
  'ActivityChanged',
  { dwarfId: DwarfId; disclosureId: string; open: boolean; stepCount: number; summaries: string[] }
>

/**
 * 08 §0, §2.6: the dwarf's outcome line changed, keyed (dwarfId, at); one per committed change, never
 * for a recompute that left the line as it was (INV-67; frame `dwarf.changed`, ISSUE-108).
 */
export type OutcomeLineChanged = DomainEvent<
  'OutcomeLineChanged',
  { dwarfId: DwarfId; outcome: OutcomeLine }
>

export type ConversationEvent =
  MessagesAppended | TurnEndedEvent | ActivityChanged | OutcomeLineChanged
