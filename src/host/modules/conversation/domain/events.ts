// The conversation module's domain events (08 §0, §2.6), over the kernel envelope (08 §1.2). Each is
// published after the transaction that wrote its rows committed, and only for new keys (08 §5.1).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId } from '../../../kernel/domain/values'
import type { MessageView } from './messages'

/** 08 §0: the rows one batch inserted, never a merged echo or a dropped record. */
export type MessagesAppended = DomainEvent<
  'MessagesAppended',
  { dwarfId: DwarfId; messages: MessageView[] }
>

export type ConversationEvent = MessagesAppended
