// The AnswerRecords double (16 §4.6 doubles row: `FakeAnswerRecords`), for asking's application
// tests. Never imported by production code (R14). conversation's real `AnswerRecords` runs over its
// `MessageLog` contract in conversation's own tests; asking reaches conversation only through its
// index (05 R4), so this double keeps the rules asking relies on, as conversation states them:
//
// - every call joins the caller's open transaction; with none it throws `HostInvariantError`;
// - one record per ask (`messages_one_record_per_ask`): a second insert for the ask is refused;
// - `write` with `existing` updates that record in place — new text, restamped, `sending` again,
//   attempts + 1, no failure (ADR-010 item 13);
// - `settle` settles a `sending` delivery, delivered or failed with its failure (ADR-022).
//
// `snapshot` / `restore` let the test's transaction roll it back with the asks.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { AskId, DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { AnswerRecords, DeliveryFailure } from '../../conversation'

/** One stored "Answers:" record with its delivery, as the feed would show it. */
export interface FakeAnswerRecord {
  id: MessageId
  dwarfId: DwarfId
  askId: AskId
  text: string
  createdAt: Instant
  delivery: {
    phase: 'sending' | 'delivered' | 'failed'
    failure?: DeliveryFailure
    attempts: number
    phaseAt: Instant
  }
}

export class FakeAnswerRecords implements AnswerRecords {
  private stored: FakeAnswerRecord[] = []

  constructor(private readonly deps: { scope: TransactionScope; clock: Clock; ids: IdGenerator }) {}

  write(dwarfId: DwarfId, askId: AskId, text: string, existing?: MessageId): MessageId {
    this.requireTransaction('write')
    const now = this.deps.clock.now()
    if (existing !== undefined) {
      const record = this.stored.find(
        (r) => r.id === existing && r.askId === askId && r.dwarfId === dwarfId
      )
      if (record === undefined) {
        throw new HostInvariantError(`no answers-record ${existing} of ask ${askId} to update`)
      }
      record.text = text
      record.createdAt = now
      record.delivery = { phase: 'sending', attempts: record.delivery.attempts + 1, phaseAt: now }
      return existing
    }
    if (this.stored.some((r) => r.askId === askId)) {
      throw new HostInvariantError(`ask ${askId} already has an answers-record`)
    }
    const id = this.deps.ids.uuidv7() as MessageId
    this.stored.push({
      id,
      dwarfId,
      askId,
      text,
      createdAt: now,
      delivery: { phase: 'sending', attempts: 1, phaseAt: now }
    })
    return id
  }

  settle(
    messageId: MessageId,
    result: { phase: 'delivered' } | { phase: 'failed'; failure: DeliveryFailure }
  ): void {
    this.requireTransaction('settle')
    const record = this.stored.find((r) => r.id === messageId && r.delivery.phase === 'sending')
    if (record === undefined) {
      throw new HostInvariantError(`no sending delivery of message ${messageId}`)
    }
    record.delivery = {
      phase: result.phase,
      ...(result.phase === 'failed' ? { failure: result.failure } : {}),
      attempts: record.delivery.attempts,
      phaseAt: this.deps.clock.now()
    }
  }

  /** The dwarf's records, in insertion order. */
  of(dwarfId: DwarfId): FakeAnswerRecord[] {
    return structuredClone(this.stored.filter((r) => r.dwarfId === dwarfId))
  }

  snapshot(): FakeAnswerRecord[] {
    return structuredClone(this.stored)
  }

  restore(snapshot: FakeAnswerRecord[]): void {
    this.stored = structuredClone(snapshot)
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(`AnswerRecords.${method} joins the caller's open transaction`)
    }
  }
}
