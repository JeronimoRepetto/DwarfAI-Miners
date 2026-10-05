// `ConversationCommands.ingest` (16 §4.6; 09 §5.2): one batch of entries from a live stream or a
// transcript reader is written in ONE transaction through `MessageLog.append` (steps 1–2), then
// `MessageLog.trim` caps the dwarf at `MESSAGES_PER_DWARF` rows in the same transaction (step 3,
// INV-61); activity runs of step 4 are ISSUE-101. Only after the commit (step 6; 08 §5.1) is
// `MessagesAppended` published, with the rows this batch inserted and nothing else: a batch whose
// every key was already claimed publishes nothing, and a batch that throws rolls back every row
// and publishes nothing.
//
// An observed batch (ISSUE-099; AMENDMENT-10, OQ-78) arrives through observation's
// `ObservedBatchSink`, inside observation's batch transaction, so that the stream's cursor commits
// with the rows the batch produced (09 §5.2 step 5). Called while a transaction is open, `ingest`
// joins it (16 §2.2) and holds its event instead of publishing inside it (16 §2.3): the caller
// publishes the held events after its commit (`publishJoined`) or drops them after a rollback
// (`discardJoined`). The dwarf is the one the caller resolved, also for an entry a subagent wrote
// in its parent's session (`providerAgentId`, 15 §1.5): it is never re-resolved here.
//
// Amendment of 2026-10-02 to 16 §4.6 (ISSUE-098): `ingest` takes the feed of the batch (`origin`).
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { EventId, DwarfId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import type { ConversationEvent } from '../domain/events'
import { toMessageView } from '../domain/messages'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { MessageLog } from '../ports/messageLog'

/**
 * The members of 05 §3.6 `ConversationCommands` built so far. Each later issue adds its member
 * with the types it needs (`send` / `retry` ISSUE-166, `recordTurnEnd` ISSUE-100, …).
 */
export interface ConversationCommands {
  // from live streams + transcript readers
  ingest(dwarfId: DwarfId, entries: ConversationEntry[], origin: 'live-stream' | 'transcript'): void
  // ADR-021 payload from a driver turn.ended or ObservedTurnEnded; one transaction; LifecycleFactLog
  // key turn:<dwarfId>:<turnKey>; publishes TurnEnded only when the key is new (08 §4) (AMENDMENT-10)
  recordTurnEnd(end: TurnEnded): void
}

export interface ConversationIngestDeps {
  log: MessageLog
  /** One transaction per batch (16 §2.2), joined when the caller has one open. */
  transactions: TransactionRunner
  /** Whether the caller has a transaction open (16 §2.3). */
  scope: TransactionScope
  /** Where `MessagesAppended` goes, after the commit (16 §2.3). */
  bus: DomainEventBus<ConversationEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class ConversationIngest implements Pick<ConversationCommands, 'ingest'> {
  /** The events of ingests that joined a caller's transaction, until it publishes or drops them. */
  private readonly held: ConversationEvent[] = []

  constructor(private readonly deps: ConversationIngestDeps) {}

  ingest(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): void {
    const { log, transactions, scope, clock, ids, hostEpoch } = this.deps
    const joined = scope.isInTransaction()
    // A batch carries one dwarf's entries, so that dwarf is the only one it can push over the cap.
    const { appended } = transactions.inTransaction(() => {
      const result = log.append(dwarfId, entries, origin)
      log.trim(dwarfId, MESSAGES_PER_DWARF)
      return result
    })
    if (appended.length === 0) return
    const event: ConversationEvent = {
      type: 'MessagesAppended',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: { dwarfId, messages: appended.map(toMessageView) }
    }
    this.emit(event, joined)
  }

  /**
   * After the commit of the transaction that wrote `event`'s rows: published now, or held for the
   * caller whose transaction the write joined (`publishJoined` / `discardJoined`).
   */
  emit(event: ConversationEvent, joined: boolean): void {
    if (joined) {
      this.held.push(event)
      return
    }
    this.deps.bus.publish(event)
  }

  /** After the caller's commit: publishes the events its joined ingests held, in order. */
  publishJoined(): void {
    for (const event of this.held.splice(0)) this.deps.bus.publish(event)
  }

  /** After the caller's rollback: the held events describe rows that no longer exist. */
  discardJoined(): void {
    this.held.length = 0
  }
}
