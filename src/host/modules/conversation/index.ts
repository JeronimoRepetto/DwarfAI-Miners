// The conversation module (05 §3.6): a dwarf's message log, owned by the Host (ADR-007 item 1). So far
// (ISSUE-098) the storage floor: `ingest` writes one batch of entries in one transaction with
// once-only keys (INV-60), drops control-plane records and hand-off echoes with their key kept
// (INV-68), merges echoes of DwarfAI-sent rows, keeps at most 50 stored rows per dwarf in the same
// transaction (INV-61, ISSUE-105), and publishes `MessagesAppended` after the commit.
// Conversation imports only suppliers and crew (05 §1.3, R4).
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteMessageLog } from './adapters/SqliteMessageLog'
import { ConversationIngest, type ConversationCommands } from './application/ingest'
import type { ConversationEvent } from './domain/events'

export type { ConversationEvent, MessagesAppended } from './domain/events'
export type {
  ActivitySummary,
  AttachmentMeta,
  Delivery,
  DeliveryFailure,
  DeliveryPhase,
  Message,
  MessageOrigin,
  MessageRole,
  MessageView
} from './domain/messages'
export type { ConversationCommands }

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

export interface Conversation {
  commands: ConversationCommands
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
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  return { commands }
}
