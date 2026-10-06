// The conversation module (05 §3.6): a dwarf's message log, owned by the Host (ADR-007 item 1). So far
// (ISSUE-098) the storage floor: `ingest` writes one batch of entries in one transaction with
// once-only keys (INV-60), drops control-plane records and hand-off echoes with their key kept
// (INV-68), merges echoes of DwarfAI-sent rows, keeps at most 50 stored rows per dwarf in the same
// transaction (INV-61, ISSUE-105), and publishes `MessagesAppended` after the commit. ISSUE-099:
// observed entries — the typed-echo merge, and an ingest that joins observation's batch
// transaction and holds its events for `joinedEvents` (AMENDMENT-10). ISSUE-103: `queries.feed`,
// a dwarf's feed from the log (`ConversationQueries`, application/queries.ts). ISSUE-100:
// `recordTurnEnd` records each reported turn end once per `turn:<dwarfId>:<turnKey>` through the
// kernel `LifecycleFactLog` and publishes `TurnEnded` after the commit; `announceable` and
// `downgrade` are the ADR-021 rules its routes and consumers apply (domain/turnEnd.ts). ISSUE-101:
// activity runs (07 machine 11) — `ingest` folds each new entry's tool steps into the dwarf's open
// run and the dwarf speaking closes it, `recordTurnEnd` closes it with a new turn end,
// `recordSessionEnd` with a session end (AMENDMENT-10), all through `SqliteActivityLog`, each
// publishing `ActivityChanged` after its commit. ISSUE-102: the outcome line (06 §9.2) — each of
// `ingest`, `recordTurnEnd`, `recordSessionEnd` and `noteAsk` (amended B2) recomputes it in its
// transaction through `ActivityLog.outcomeOf` / `saveOutcome` (amendment B) and publishes
// `OutcomeLineChanged` after the commit when it changed. ISSUE-107: the Reset-metrics step
// (`createConversationResetStep`), which reaches the saga structurally. ISSUE-104: `mineHistory`
// (`Conversation.history`), over crew's public queries that host/wiring passes (later: ISSUE-108).
// Conversation imports only suppliers and crew (05 §1.3, R4).
import type { DwarfId, HostEpoch, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteActivityLog } from './adapters/SqliteActivityLog'
import { SqliteMessageLog } from './adapters/SqliteMessageLog'
import { ConversationResetStep } from './adapters/sqlite/ConversationResetStep'
import { ConversationIngest, type AskChange, type ConversationCommands } from './application/ingest'
import { AskNoter } from './application/noteAsk'
import {
  ConversationFeedQueries,
  ConversationMineHistory,
  type MineCrew
} from './application/queries'
import { SessionEndRecorder } from './application/recordSessionEnd'
import { TurnEndRecorder } from './application/recordTurnEnd'
import type { ConversationEvent } from './domain/events'
import type { FeedPage, FeedPageRequest, MineHistoryView } from './domain/messages'

export type {
  ActivityChanged,
  ConversationEvent,
  MessagesAppended,
  OutcomeLineChanged,
  TurnEndedEvent
} from './domain/events'
export type { OutcomeLine, OutcomeLinePart, TurnOutcomeKind } from './domain/outcomeLine'
export type { ActivityDisclosure } from './domain/activityRun'
export type { TurnEnded, TurnEndKind } from '../../kernel/domain/sharedContracts'
export { announceable, downgrade, type TurnEndCapability } from './domain/turnEnd'
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
  MessageView,
  MineHistoryView
} from './domain/messages'
export type { MineCrew }
export type { AskChange, ConversationCommands }
/** The feed of an ingested batch (`messages.origin`): what the `ObservedBatchSink` route passes. */
export type IngestOrigin = Parameters<ConversationCommands['ingest']>[2]

/**
 * 16 §4.6 `ConversationQueries` (driving): a dwarf's feed, newest first, at most 50 rows (INV-61),
 * and a mine's history, the same ≤ 50 rows per dwarf, undelivered ones included.
 */
export interface ConversationQueries {
  feed(dwarfId: DwarfId, page?: FeedPageRequest): FeedPage
  mineHistory(mineId: MineId): MineHistoryView
}

export interface ConversationDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2), which also reports whether a transaction is open. */
  transactions: TransactionRunner & TransactionScope
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<ConversationEvent>
  /** The kernel log of `dwarf_lifecycle_facts`, shared with crew (16 §3): the turn-end facts. */
  lifecycleFacts: LifecycleFactLog
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
  /** The feed (ISSUE-103). */
  queries: Pick<ConversationQueries, 'feed'>
  /**
   * `ConversationQueries.mineHistory` (ISSUE-104) over crew's `crewOf` (the conversation → crew
   * edge, 05 §1.3): `host/wiring` passes crew's public queries when it composes both modules
   * (later: ISSUE-108).
   */
  history(deps: { crew: MineCrew }): Pick<ConversationQueries, 'mineHistory'>
  joinedEvents: JoinedEvents
}

/**
 * The conversation step of the Reset-metrics saga (ADR-023; 09 §7.2): the shape of the preferences
 * module's `ResetDbStep` (16 §4.12), stated here so conversation imports nothing from preferences
 * (05 §1.3, R4). It joins the saga's one `db` transaction.
 */
export interface ConversationResetDbStep {
  readonly name: string
  reset(tx: TransactionRunner): void
}

/** `name: 'conversation'`; registered with the saga by host/wiring/resetParticipants.ts. */
export function createConversationResetStep(deps: {
  db: SqliteDatabase
  scope: TransactionScope
}): ConversationResetDbStep {
  return new ConversationResetStep(deps)
}

/** The module over the Host database. */
export function createConversation(deps: ConversationDeps): Conversation {
  const log = new SqliteMessageLog({
    db: deps.db,
    scope: deps.transactions,
    clock: deps.clock,
    ids: deps.ids
  })
  const activity = new SqliteActivityLog({ db: deps.db, scope: deps.transactions })
  const ingest = new ConversationIngest({
    log,
    activity,
    transactions: deps.transactions,
    scope: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const turnEnds = new TurnEndRecorder({
    facts: deps.lifecycleFacts,
    activity,
    transactions: deps.transactions,
    scope: deps.transactions,
    // One held queue for the module: a caller's commit publishes every event it held, in order.
    emit: (event, joined) => ingest.emit(event, joined),
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const sessionEnds = new SessionEndRecorder({
    activity,
    transactions: deps.transactions,
    scope: deps.transactions,
    emit: (event, joined) => ingest.emit(event, joined),
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const asks = new AskNoter({
    activity,
    transactions: deps.transactions,
    scope: deps.transactions,
    emit: (event, joined) => ingest.emit(event, joined),
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const commands: ConversationCommands = {
    ingest: (dwarfId, entries, origin) => ingest.ingest(dwarfId, entries, origin),
    recordTurnEnd: (end) => turnEnds.recordTurnEnd(end),
    recordSessionEnd: (dwarfId, at) => sessionEnds.recordSessionEnd(dwarfId, at),
    noteAsk: (dwarfId, change) => asks.noteAsk(dwarfId, change)
  }
  return {
    commands,
    queries: new ConversationFeedQueries({ log }),
    history: ({ crew }) => new ConversationMineHistory({ log, crew }),
    joinedEvents: {
      publish: () => ingest.publishJoined(),
      discard: () => ingest.discardJoined()
    }
  }
}
