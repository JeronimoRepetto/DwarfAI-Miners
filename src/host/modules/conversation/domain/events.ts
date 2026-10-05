// The conversation module's domain events (08 §0, §2.6), over the kernel envelope (08 §1.2). Each is
// published after the transaction that wrote its rows committed, and only for new keys (08 §5.1).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import type { MessageView } from './messages'

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

export type ConversationEvent = MessagesAppended | TurnEndedEvent
