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
// (`Conversation.history`), over crew's public queries that host/wiring passes (ISSUE-108).
// Owner amendment E (2026-10-06, ISSUE-108): `ActivityChanged` carries the run's summaries (08 §0),
// and `queries.outcomeOf` reads a dwarf's stored outcome line outside any transaction (16 §4.6).
// ISSUE-128: `AnswerRecords` (16 §4.6), the answers-record writes asking makes inside its critical
// section (edge asking → conversation), over `MessageLog.writeAnswersRecord` / `settleDelivery`
// (owner amendment K, 2026-10-09); asking publishes their `MessageSent` / `MessageHandedOver` /
// `MessageDeliveryFailed` after its commit.
// ISSUE-166: `sending` builds `ConversationCommands.send` over the `TurnSender` and the dwarf's
// `canReceiveMessages` that host/wiring passes (the bridge to suppliers, crew's read): the person's
// row and its `sending` mark before any hand-over, the marks moved only on evidence through machine 7
// (domain/delivery.ts), and the `MessageLog` writes of AMENDMENT-16 (owner, 2026-10-15). Each
// committed `ingest` batch reaches the sender as `transcript-match` evidence (S-022-1); a batch that
// joined a caller's transaction reaches it only after that caller's commit (`joinedEvents`).
// ISSUE-169: `sending` also takes the `AttachmentReader` host/wiring passes (`FsAttachmentReader`)
// and builds `describeAttachments` over it; `send` re-validates every path with the same reader
// before any row and hands the accepted ones over in `TurnInput.attachments`. With no reader,
// every path is refused (`unreadable`), so a send with files stays `attachment-refused`.
// Conversation imports only suppliers and crew (05 §1.3, R4).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DwarfId, HostEpoch, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteActivityLog } from './adapters/SqliteActivityLog'
import { SqliteMessageLog } from './adapters/SqliteMessageLog'
import { ConversationResetStep } from './adapters/sqlite/ConversationResetStep'
import { createAnswerRecords, type AnswerRecords } from './application/answerRecords'
import {
  ConversationIngest,
  type AskChange,
  type ConversationCommands as IngestCommands,
  type ConversationSendCommand
} from './application/ingest'
import { AskNoter } from './application/noteAsk'
import {
  ConversationFeedQueries,
  ConversationMineHistory,
  type MineCrew
} from './application/queries'
import { SessionEndRecorder } from './application/recordSessionEnd'
import {
  describeAttachments,
  type ConversationAttachmentCommand
} from './application/describeAttachments'
import { ConversationSender, type MessageRecipients, type SendEvent } from './application/send'
import { TurnEndRecorder } from './application/recordTurnEnd'
import type { ConversationEvent } from './domain/events'
import type { FeedPage, FeedPageRequest, MineHistoryView } from './domain/messages'
import type { OutcomeLine } from './domain/outcomeLine'
import type { AttachmentReader } from './ports/attachmentReader'
import type { TurnSender } from './ports/turnSender'

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
export type {
  AnswerRecordEvent,
  AnswerRecords,
  AnswerRecordsDeps,
  MessageDeliveryFailed,
  MessageHandedOver,
  MessageSent
} from './application/answerRecords'
export type { AskChange }
/** 16 §4.6 `ConversationCommands`: the members built so far, `send` included (ISSUE-166). */
export type ConversationCommands = IngestCommands & ConversationSendCommand
export type { AttachmentPath } from './application/ingest'
export type { ConversationAttachmentCommand } from './application/describeAttachments'
export {
  MAX_ATTACHMENT_BYTES,
  type AttachmentKind,
  type AttachmentPick,
  type AttachmentPickRefusal,
  type DescribedAttachment
} from './domain/attachments'
export type { AttachmentReader } from './ports/attachmentReader'
export type { MessageReactedTo, MessageRecipients, SendEvent } from './application/send'
export type { TurnHandOver, TurnSender, TurnSendFailure, TurnSendResult } from './ports/turnSender'
export type { ReactionEvidence } from './domain/delivery'
export {
  advance,
  RequestIdOfAnotherDwarfError,
  reconcileDelivery,
  startDelivery,
  type DeliveryFact,
  type DeliveryStep,
  type DeliveryTransitionId,
  type ReconcileEvidence
} from './domain/delivery'
/** The feed of an ingested batch (`messages.origin`): what the `ObservedBatchSink` route passes. */
export type IngestOrigin = Parameters<ConversationCommands['ingest']>[2]

/**
 * 16 §4.6 `ConversationQueries` (driving): a dwarf's feed, newest first, at most 50 rows (INV-61),
 * a mine's history, the same ≤ 50 rows per dwarf, undelivered ones included, and the dwarf's stored
 * outcome line (amendment E), read on the read connection outside any transaction (09 §8.1).
 */
export interface ConversationQueries {
  feed(dwarfId: DwarfId, page?: FeedPageRequest): FeedPage
  mineHistory(mineId: MineId): MineHistoryView
  // Amended: 16 §4.6 ConversationQueries.outcomeOf (owner amendment E, 2026-10-06)
  outcomeOf(dwarfId: DwarfId): OutcomeLine | null
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

/** What `sending` needs from host/wiring (ISSUE-166). */
export interface ConversationSendingDeps {
  /** The bridge to suppliers' sessions (host/wiring/bridges/turnSender.ts). */
  turns: TurnSender
  /** Crew's derived `canReceiveMessages` (INV-33), through the conversation → crew edge. */
  recipients: MessageRecipients
  /** The Host bus, where the delivery events go after their commit (16 §2.3). */
  bus: Pick<DomainEventBus<SendEvent>, 'publish'>
  /** Where a failed delivery write is recorded, allowlisted fields only (ADR-026). */
  diagnostics: DiagnosticsLog
  /** The Host's check of every attachment path (ISSUE-169); absent, every path is refused. */
  attachments?: AttachmentReader
}

/** No reader built: every path is refused, so nothing is offered that is not built (21 §1 item 8). */
const NO_ATTACHMENTS: AttachmentReader = {
  describe: async () => ({ refused: 'unreadable' })
}

export interface Conversation {
  /** Every command but `send`, which `sending` builds once its routes exist. */
  commands: IngestCommands
  /**
   * `ConversationCommands.send` (ISSUE-166), built once by host/wiring when crew and suppliers are
   * wired; a second call is a wiring defect.
   */
  sending(deps: ConversationSendingDeps): ConversationSendCommand & ConversationAttachmentCommand
  /** The feed (ISSUE-103) and the stored outcome line (owner amendment E, ISSUE-108). */
  queries: Pick<ConversationQueries, 'feed' | 'outcomeOf'>
  /**
   * `ConversationQueries.mineHistory` (ISSUE-104) over crew's `crewOf` (the conversation → crew
   * edge, 05 §1.3): `host/wiring` passes crew's public queries when it composes both modules
   * (wiring/routes/conversation.ts, ISSUE-108).
   */
  history(deps: { crew: MineCrew }): Pick<ConversationQueries, 'mineHistory'>
  joinedEvents: JoinedEvents
  /** 16 §4.6 `AnswerRecords`, for asking only: joins asking's open transaction (ISSUE-128). */
  answerRecords: AnswerRecords
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
  const feed = new ConversationFeedQueries({ log })
  let sender: ConversationSender | null = null
  /** The batches of joined ingests, handed to the sender after their caller's commit. */
  const joinedBatches: Array<Parameters<IngestCommands['ingest']>> = []
  const commands: IngestCommands = {
    ingest: (dwarfId, entries, origin) => {
      const joined = deps.transactions.isInTransaction()
      ingest.ingest(dwarfId, entries, origin)
      if (sender === null) return
      if (joined) joinedBatches.push([dwarfId, entries, origin])
      else sender.entriesIngested(dwarfId, entries, origin)
    },
    recordTurnEnd: (end) => turnEnds.recordTurnEnd(end),
    // ISSUE-166: the same route ends the dwarf's held deliveries (S7.07) once the run is closed.
    recordSessionEnd: (dwarfId, at) => {
      sessionEnds.recordSessionEnd(dwarfId, at)
      sender?.sessionEnded(dwarfId)
    },
    noteAsk: (dwarfId, change) => asks.noteAsk(dwarfId, change)
  }
  return {
    commands,
    queries: {
      feed: (dwarfId, page) => feed.feed(dwarfId, page),
      // Amended: 16 §4.6 ConversationQueries.outcomeOf (owner amendment E, 2026-10-06)
      outcomeOf: (dwarfId) => activity.storedOutcomeOf(dwarfId)
    },
    history: ({ crew }) => new ConversationMineHistory({ log, crew }),
    sending: ({ turns, recipients, bus, diagnostics, attachments = NO_ATTACHMENTS }) => {
      if (sender !== null) throw new HostInvariantError('conversation sending is built once')
      sender = new ConversationSender({
        attachments,
        log,
        transactions: deps.transactions,
        bus,
        onTurnEnded: (handler) => {
          deps.bus.subscribe('TurnEnded', ({ payload }) => handler(payload.end))
        },
        turns,
        recipients,
        clock: deps.clock,
        ids: deps.ids,
        hostEpoch: deps.hostEpoch,
        diagnostics
      })
      return {
        send: (...args) => (sender as ConversationSender).send(...args),
        describeAttachments: (paths) => describeAttachments(paths, attachments)
      }
    },
    joinedEvents: {
      publish: () => {
        ingest.publishJoined()
        for (const batch of joinedBatches.splice(0)) sender?.entriesIngested(...batch)
      },
      discard: () => {
        ingest.discardJoined()
        joinedBatches.length = 0
      }
    },
    answerRecords: createAnswerRecords({ log, scope: deps.transactions, clock: deps.clock })
  }
}
