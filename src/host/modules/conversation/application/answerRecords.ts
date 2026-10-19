// `AnswerRecords` (05 §3.6, 16 §4.6): conversation's writes of the "Answers:" record, for asking
// only (the edge asking → conversation, 05 §1.3; conversation never imports asking). Synchronous,
// and only inside the caller's open transaction — asking's critical section (ADR-010 items 4, 13;
// 09 §8.2), which it joins and never opens: called with none, it throws `HostInvariantError` and
// writes nothing. It publishes nothing: asking publishes `MessageSent`, `MessageHandedOver` and
// `MessageDeliveryFailed` after its own commit (16 §4.6 row `AnswerRecords.write` / `settle`).
//
// - `write` inserts the ask's one record with its delivery `sending`, or, given `existing`, updates
//   that record in place (ADR-010 item 13), through `MessageLog.writeAnswersRecord` (owner amendment
//   K), stamped by the `Clock`; a new record then trims the dwarf to its 50 stored rows in the same
//   transaction, and a `sending` row is never the one trimmed (INV-61).
// - `settle` sets the delivery `delivered` or `failed {refused, reason}` (ADR-022) through
//   `MessageLog.settleDelivery`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { AskId, DwarfId, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { DeliveryFailure } from '../domain/messages'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { MessageLog } from '../ports/messageLog'

// verbatim: 05-modules-and-ports.md L789-L793 (16 §4.6; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface AnswerRecords {                             // for asking only (edge asking → conversation, §1.3); synchronous,
  // called INSIDE asking's open transaction (it joins, never opens its own): ADR-010 items 4 and 13, 09 §8.2
  write(dwarfId: DwarfId, askId: AskId, text: string, existing?: MessageId): MessageId   // insert, or update in place after a refusal; delivery 'sending'
  settle(messageId: MessageId, result: { phase: 'delivered' } | { phase: 'failed'; failure: DeliveryFailure }): void   // ADR-022 DeliveryFailure (refused.reason = ADR-010 AnswerRefusalReason)
}
// end verbatim

/** 08 §0 `MessageSent`: a message or answers-record row was written with its delivery `sending`. */
export type MessageSent = DomainEvent<
  'MessageSent',
  { messageId: MessageId; dwarfId: DwarfId; kind: 'message' | 'answers-record' }
>

/** 08 §0 `MessageHandedOver`: the channel took it (✓). */
export type MessageHandedOver = DomainEvent<
  'MessageHandedOver',
  { messageId: MessageId; dwarfId: DwarfId; confidence: 'confirmed' | 'unconfirmed' }
>

/** 08 §0 `MessageDeliveryFailed`: the hand-over failed (✕ with its ADR-022 failure). */
export type MessageDeliveryFailed = DomainEvent<
  'MessageDeliveryFailed',
  { messageId: MessageId; dwarfId: DwarfId; failure: DeliveryFailure }
>

/** The delivery events of an answers-record, which asking publishes after its commit (16 §4.6). */
export type AnswerRecordEvent = MessageSent | MessageHandedOver | MessageDeliveryFailed

export interface AnswerRecordsDeps {
  log: MessageLog
  /** Whether the caller has its transaction open (16 §2.2). */
  scope: TransactionScope
  /** Stamps the record and its delivery. */
  clock: Clock
}

export function createAnswerRecords(deps: AnswerRecordsDeps): AnswerRecords {
  const { log, scope, clock } = deps
  const requireTransaction = (method: string): void => {
    if (!scope.isInTransaction()) {
      throw new HostInvariantError(
        `AnswerRecords.${method} joins the caller's open transaction and never opens one (16 §4.6)`
      )
    }
  }
  return {
    write(dwarfId, askId, text, existing) {
      requireTransaction('write')
      const id = log.writeAnswersRecord(dwarfId, askId, text, clock.now(), existing)
      if (existing === undefined) log.trim(dwarfId, MESSAGES_PER_DWARF)
      return id
    },
    settle(messageId, result) {
      requireTransaction('settle')
      log.settleDelivery(messageId, result, clock.now())
    }
  }
}
