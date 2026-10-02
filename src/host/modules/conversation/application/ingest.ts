// `ConversationCommands.ingest` (16 §4.6; 09 §5.2): one batch of entries from a live stream or a
// transcript reader is written in ONE transaction through `MessageLog.append` (steps 1–2; the cap of
// step 3 is ISSUE-105, activity runs of step 4 ISSUE-101, the cursor of step 5 ISSUE-099). Only
// after the commit (step 6; 08 §5.1) is `MessagesAppended` published, with the rows this batch
// inserted and nothing else: a batch whose every key was already claimed publishes nothing, and a
// batch that throws rolls back every row and publishes nothing.
//
// Amendment of 2026-10-02 to 16 §4.6 (ISSUE-098): `ingest` takes the feed of the batch (`origin`).
import type { EventId, DwarfId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ConversationEntry } from '../../suppliers'
import type { ConversationEvent } from '../domain/events'
import { toMessageView } from '../domain/messages'
import type { MessageLog } from '../ports/messageLog'

/**
 * The members of 05 §3.6 `ConversationCommands` built so far. Each later issue adds its member
 * with the types it needs (`send` / `retry` ISSUE-166, `recordTurnEnd` ISSUE-100, …).
 */
export interface ConversationCommands {
  // from live streams + transcript readers
  ingest(dwarfId: DwarfId, entries: ConversationEntry[], origin: 'live-stream' | 'transcript'): void
}

export interface ConversationIngestDeps {
  log: MessageLog
  /** One transaction per batch (16 §2.2). */
  transactions: TransactionRunner
  /** Where `MessagesAppended` goes, after the commit (16 §2.3). */
  bus: DomainEventBus<ConversationEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class ConversationIngest implements ConversationCommands {
  constructor(private readonly deps: ConversationIngestDeps) {}

  ingest(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): void {
    const { log, transactions, bus, clock, ids, hostEpoch } = this.deps
    const { appended } = transactions.inTransaction(() => log.append(dwarfId, entries, origin))
    if (appended.length === 0) return
    bus.publish({
      type: 'MessagesAppended',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: { dwarfId, messages: appended.map(toMessageView) }
    })
  }
}
