// `ConversationCommands.retry` (16 §4.6; 14 B-M25; ADR-022 item 5; 07 machine 7 S7.09, S7.12;
// ISSUE-168): Retry of a message that failed to deliver, as the same message.
//
// - One transaction (16 §2.2): `MessageLog.resend` (AMENDMENT-20, owner, 2026-10-17) puts the row's
//   delivery back to `sending` and answers the delivery it had before; machine 7 then decides
//   (`advance(previous, { t: 'retry', canReceiveMessages })`, S7.09). A refusal throws inside the
//   transaction, so its rollback leaves the row exactly as it was.
// - Only `failed{channel-error | host-interrupted}` of a person's message, and only while the dwarf
//   can receive (INV-33): a retryable failure of a dwarf that cannot receive answers
//   `cannot-receive` (S7.12, Retry disappears); anything else — a message already `sending` (a
//   second retry in a row), delivered, `session-closed` (Copy alone, S7.07), an answers-record, an
//   unknown id — answers `not-failed` and changes nothing.
// - Accepted: the same `messageId`, `attempts + 1`, restamped with the retry's own time (INV-64,
//   US-MSG-003.AC06). It answers at acceptance like `send` (14 §1.7), and the hand-over continues
//   with no caller through the sender (`ConversationSender.resume`). A driver that dedupes by id can
//   drop a duplicate; a resend after `host-interrupted` on a channel without id dedupe is ADR-022
//   item 5's accepted residual risk. Nothing ever retries by itself (BR-17).
// - The `requestId` dedupes at the transport (16 §4.6 retry row; 14 §1.6, `conversation.retry` is
//   no durable-key method): a repeat on the connection answers the first outcome without reaching
//   this command.
import type { Instant, MessageId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { advance } from '../domain/delivery'
import type { Delivery } from '../domain/messages'
import type { MessageLog } from '../ports/messageLog'
import type { MessageRecipients } from './send'

export interface ConversationRetryDeps {
  log: Pick<MessageLog, 'resend'>
  /** One transaction per retry (16 §2.2). */
  transactions: TransactionRunner
  recipients: MessageRecipients
  clock: Clock
  /** The sender that walks the retried message's marks again. */
  sender: { resume(delivery: Delivery, text: string): void }
}

class Refused extends Error {
  constructor(readonly outcome: 'cannot-receive' | 'not-failed') {
    super(outcome)
  }
}

export class ConversationRetry {
  constructor(private readonly deps: ConversationRetryDeps) {}

  async retry(
    messageId: MessageId,
    requestId: string
  ): Promise<Result<void, 'cannot-receive' | 'not-failed'>> {
    void requestId
    const { log, transactions, recipients, clock, sender } = this.deps
    const at = clock.now()
    let resent: { delivery: Delivery; text: string }
    try {
      resent = transactions.inTransaction(() => {
        const row = log.resend(messageId, at)
        if (row === null) throw new Refused('not-failed')
        const canReceiveMessages = recipients.canReceiveMessages(row.dwarfId)
        const step = advance(row.delivery, { t: 'retry', canReceiveMessages }, at)
        if (!step.ok) throw new Refused(refusalOf(row.delivery, at))
        return { delivery: step.delivery, text: row.text }
      })
    } catch (error) {
      if (error instanceof Refused) return { ok: false, error: error.outcome }
      throw error
    }
    sender.resume(resent.delivery, resent.text)
    return { ok: true, value: undefined }
  }
}

/**
 * Why machine 7 refused: a delivery it would retry for a dwarf that can receive is S7.12
 * (`cannot-receive`); any other is no retryable failure (`not-failed`).
 */
function refusalOf(previous: Delivery, at: Instant): 'cannot-receive' | 'not-failed' {
  return advance(previous, { t: 'retry', canReceiveMessages: true }, at).ok
    ? 'cannot-receive'
    : 'not-failed'
}
