// The conversation module (05 §3.6): a dwarf's message log, owned by the Host (ADR-007 item 1). So far
// (ISSUE-098) the storage floor: `ingest` writes one batch of entries in one transaction with
// once-only keys (INV-60), drops control-plane records and hand-off echoes with their key kept
// (INV-68), merges echoes of DwarfAI-sent rows, keeps at most 50 stored rows per dwarf in the same
// transaction (INV-61, ISSUE-105), and publishes `MessagesAppended` after the commit. ISSUE-099:
// observed entries — the typed-echo merge, and an ingest that joins observation's batch
// transaction and holds its events for `joinedEvents` (AMENDMENT-10). ISSUE-103: `queries.feed`,
// a dwarf's feed from the log (`ConversationQueries`, application/queries.ts).
// Conversation imports only suppliers and crew (05 §1.3, R4).
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteMessageLog } from './adapters/SqliteMessageLog'
import { ConversationIngest, type ConversationCommands } from './application/ingest'
import { ConversationFeedQueries } from './application/queries'
import type { ConversationEvent } from './domain/events'
import type { FeedPage, FeedPageRequest } from './domain/messages'

export type { ConversationEvent, MessagesAppended } from './domain/events'
export type {
  ActivitySummary,
  AttachmentMeta,
  Delivery,
  DeliveryFailure,
  DeliveryPhase,
  FeedPage,
  FeedPageRequest,
  Message,
  MessageOrigin,
  MessageRole,
  MessageView
} from './domain/messages'
export type { ConversationCommands }
/** The feed of an ingested batch (`messages.origin`): what the `ObservedBatchSink` route passes. */
export type IngestOrigin = Parameters<ConversationCommands['ingest']>[2]

/**
 * 16 §4.6 `ConversationQueries` (driving): a dwarf's feed, newest first, at most 50 rows (INV-61).
 * `mineHistory` joins with its issue (later: ISSUE-104).
 */
export interface ConversationQueries {
  feed(dwarfId: DwarfId, page?: FeedPageRequest): FeedPage
}

export interface ConversationDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2), which also reports whether a transaction is open. */
  transactions: TransactionRunner & TransactionScope
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<ConversationEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

/**
 * The events of `ingest` calls that joined a caller's open transaction (AMENDMENT-10: the observed
 * batch, 16 §4.3). They are held, never published inside that transaction (16 §2.3): the caller
 * publishes them once its transaction committed, or discards them when it rolled back.
 */
export interface JoinedEvents {
  /** After the caller's commit: publishes the held events, in ingest order. */
  publish(): void
  /** After the caller's rollback: drops the held events. */
  discard(): void
}

export interface Conversation {
  commands: ConversationCommands
  queries: ConversationQueries
  joinedEvents: JoinedEvents
}

/** The module over the Host database. */
export function createConversation(deps: ConversationDeps): Conversation {
  const log = new SqliteMessageLog({
    db: deps.db,
    scope: deps.transactions,
    clock: deps.clock,
    ids: deps.ids
  })
  const commands = new ConversationIngest({
    log,
    transactions: deps.transactions,
    scope: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  return {
    commands,
    queries: new ConversationFeedQueries({ log }),
    joinedEvents: {
      publish: () => commands.publishJoined(),
      discard: () => commands.discardJoined()
    }
  }
}
