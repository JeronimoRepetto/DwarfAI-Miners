// The conversation module's wiring (05 §3.6, §4; 16 §4.6, §8.2, §8.3; ISSUE-108, ISSUE-166), in
// two parts, as routes/crew.ts:
//
// - `serveConversation`, run by the composition root before the boot binds the endpoint: B-M24
//   `conversation.send` (ISSUE-166), B-M26 `conversation.feed` and B-M27 `conversation.mineHistory`
//   (14 §2.3), and the `tails` and `marks` snapshot sections (14 §3.7, §4.1), so every `hello.ok`
//   lists them (14 §1.3). They forward to the one instance boot step 4 constructs; until then the
//   dispatcher answers HOST_NOT_READY before any handler runs (14 §3.3), and the sections are never
//   read before `ready`.
// - `wire`, run by boot step 4 before observation (whose batch sink holds the module's half):
//   `createConversation` over the Host database (`SqliteMessageLog`, `SqliteActivityLog`) and the one
//   kernel `LifecycleFactLog` crew shares (05 §4 item 1; 16 §3), and the conversation half of the
//   `ObservedBatchSink` bridge (bridges/observedBatchSink.ts, AMENDMENT-10).
// - `route`, run by boot step 4 once crew and mines exist: the mine history over crew's public
//   queries (the conversation → crew edge, 05 §1.3), the `tails` and `marks` sections over mines'
//   and crew's, the frames of conversation's events (routes/conversationFrames.ts), subscribed
//   before step 7's catch-up publishes the first of them (16 §8.2), and the send path (ISSUE-166):
//   `ConversationCommands.send` over crew's `canReceiveMessages` (INV-33) and the `TurnSender`
//   bridge to suppliers' sessions (bridges/turnSender.ts; AMENDMENT-16, owner, 2026-10-15), with its
//   `message.delivery` frames (B-F12, `ui` only): each of `MessageSent`, `MessageHandedOver`,
//   `MessageReactedTo` and `MessageDeliveryFailed` — the person's messages and asking's
//   answers-records alike — sends the `Delivery` the Host stored, read after the commit, never one
//   computed for the frame (ADR-022 item 6). The composition root passes suppliers' channels as
//   `sessions`; without them every hand-over answers `session-closed`. Crew answers
//   `canReceiveMessages` false until a delivery route is wired (main.ts `links`, later: EPIC-10),
//   so a send is refused `cannot-receive` before any row: nothing is offered that is not built.
// - Attachments (ISSUE-169): B-M28 `conversation.describeAttachments` is served with the others,
//   and `route` passes the `AttachmentReader` the composition root built (`FsAttachmentReader`) to
//   both describe and `send`, which re-validates every path before any row (16 §4.6; ADR-019
//   item 9). Without one, every path is `unreadable` and a send with files `attachment-refused`.
//
// Not routed here, and why:
// - `ObservedTurnEnded` (observation) → `recordTurnEnd`, `TurnEnded` → crew and attention,
//   `DwarfDeparted` → `recordSessionEnd` (05 §4): the cut-1 routes (routes/cut1Routes.ts,
//   ISSUE-120). The ask routes → `noteAsk`: routes/askingRoutes.ts (ISSUE-140).
// - The Reset saga's conversation step (`createConversationResetStep`): ISSUE-121.
// - `retry` (ISSUE-168); the observed-session relay (ISSUE-167); driver events → `ingest` and
//   `recordTurnEnd` (ISSUE-182), which brings the echo merge and the turn ends ✓✓ waits for.
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import {
  createConversation,
  type Conversation,
  type ConversationCommands,
  type ConversationEvent,
  type AttachmentReader,
  type ConversationAttachmentCommand,
  type ConversationQueries,
  type SendEvent
} from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import type { SessionChannels } from '../../modules/suppliers'
import type { Dispatcher } from '../../transport/dispatcher'
import type { ConversationFramePublisher } from '../../transport/frames/conversationAppended'
import { toMessageWire } from '../../transport/mappers/wire'
import { registerConversationDescribeAttachments } from '../../transport/methods/conversationDescribeAttachments'
import { registerConversationFeed } from '../../transport/methods/conversationFeed'
import { registerConversationMineHistory } from '../../transport/methods/conversationMineHistory'
import { registerConversationSend } from '../../transport/methods/conversationSend'
import { registerMarksSection } from '../../transport/snapshot/marksSection'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { registerTailsSection } from '../../transport/snapshot/tailsSection'
import { conversationBatchHalf, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import { launchedTurnSender } from '../bridges/turnSender'
import { publishConversationReadFrames } from './conversationFrames'

/** The events the conversation wiring publishes or projects: one Host bus carries them all (16 §2.3). */
export type ConversationRouteEvent = ConversationEvent | SendEvent

export interface ConversationServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M24, B-M26, B-M27 and B-M28 join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where `tails` and `marks` join (after the board's, 14 §4.2). */
  sections: SectionRegistry
}

export interface ConversationWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The one `SqliteLifecycleFactLog`, shared with crew (05 §4 item 1; 16 §3). */
  lifecycleFacts: LifecycleFactLog
  /** The Host's one event bus (16 §2.3). */
  bus: DomainEventBus<ConversationEvent> & DomainEventBus<SendEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** Where the frames go: the connection registry. */
  frames: ConversationFramePublisher
}

/** Crew's, mines' and suppliers' halves of the conversation routes, through their public doors. */
export interface ConversationCrewRoute {
  crew: Pick<CrewQueries, 'get' | 'crewOf'>
  mines: Pick<MinesQueries, 'list'>
  /** Suppliers' live sessions, the send path's only door to a driver (16 §4.4). */
  sessions?: Pick<SessionChannels, 'sessionFor'>
  /**
   * Where the send path records a failed delivery write (ADR-026 allowlist). The composition root
   * passes the Host log; a harness that never sends may leave it out.
   */
  diagnostics?: DiagnosticsLog
  /**
   * The Host's check of every attachment path a UI sends (ISSUE-169): the composition root passes
   * `FsAttachmentReader`. Without one, nothing is offered that is not built: every path is refused.
   */
  attachments?: AttachmentReader
}

/** No log: for harnesses that wire the read side only. */
const NO_DIAGNOSTICS: DiagnosticsLog = { record: () => undefined }

/** No session reachable: every hand-over answers `session-closed` (FM-078). */
const NO_SESSIONS: Pick<SessionChannels, 'sessionFor'> = { sessionFor: () => null }

export interface WiredConversation {
  /** The one instance. */
  conversation: Conversation
  /** The conversation half of the `ObservedBatchSink` bridge. */
  batchHalf: ObservedBatchHalf
  /** Boot step 4, once crew and mines are wired: the history, the tails, the send path, the frames. */
  route(deps: ConversationCrewRoute): void
}

export interface ServedConversation {
  /** Boot step 4: constructs the module the served members forward to. */
  wire(deps: ConversationWiringDeps): WiredConversation
}

/** The members the served methods and sections forward to. */
type ServedMembers = {
  conversation: Pick<ConversationQueries, 'feed' | 'mineHistory'> &
    Pick<ConversationCommands, 'send'> &
    ConversationAttachmentCommand
  crew: Pick<CrewQueries, 'crewOf'>
  mines: Pick<MinesQueries, 'list'>
}

/** Serves the module's seam-B members before it exists; `wire` constructs it at boot step 4. */
export function serveConversation(serve: ConversationServeDeps): ServedConversation {
  let served: ServedMembers | undefined
  const current = (): ServedMembers => {
    if (served === undefined) {
      throw new HostInvariantError('conversation is served from boot step 4 on')
    }
    return served
  }
  registerConversationSend(serve.dispatcher, {
    conversation: {
      send: (dwarfId, text, attachments, requestId) =>
        current().conversation.send(dwarfId, text, attachments, requestId)
    }
  })
  registerConversationDescribeAttachments(serve.dispatcher, {
    conversation: {
      describeAttachments: (paths) => current().conversation.describeAttachments(paths)
    }
  })
  registerConversationFeed(serve.dispatcher, {
    conversation: { feed: (dwarfId, page) => current().conversation.feed(dwarfId, page) }
  })
  registerConversationMineHistory(serve.dispatcher, {
    conversation: { mineHistory: (mineId) => current().conversation.mineHistory(mineId) }
  })
  const boardReads = {
    mines: { list: (query: Parameters<MinesQueries['list']>[0]) => current().mines.list(query) },
    crew: {
      crewOf: (...args: Parameters<CrewQueries['crewOf']>) => current().crew.crewOf(...args)
    },
    conversation: {
      feed: (...args: Parameters<ConversationQueries['feed']>) =>
        current().conversation.feed(...args)
    }
  }
  registerTailsSection(serve.sections, boardReads)
  // 14 §4.2: each dwarf's marks follow its tail.
  registerMarksSection(serve.sections, boardReads)
  let wired = false
  return {
    wire: (deps) => {
      if (wired) throw new HostInvariantError('conversation is wired once')
      wired = true
      const conversation = createConversation(deps)
      return {
        conversation,
        batchHalf: conversationBatchHalf(conversation),
        route: ({ crew, mines, sessions, diagnostics, attachments }) => {
          if (served !== undefined) throw new HostInvariantError('conversation is routed once')
          publishConversationReadFrames({ events: deps.bus, crew, frames: deps.frames })
          publishDeliveryFrames({ events: deps.bus, conversation, frames: deps.frames })
          const history = conversation.history({ crew })
          const sending = conversation.sending({
            turns: launchedTurnSender({
              dwarfs: {
                identityOf: (dwarfId) => {
                  const dwarf = crew.get(dwarfId)
                  return dwarf === null || dwarf.departed ? null : dwarf.identity
                }
              },
              sessions: sessions ?? NO_SESSIONS
            }),
            recipients: {
              canReceiveMessages: (dwarfId) => crew.get(dwarfId)?.canReceiveMessages ?? false
            },
            bus: deps.bus,
            diagnostics: diagnostics ?? NO_DIAGNOSTICS,
            ...(attachments === undefined ? {} : { attachments })
          })
          served = {
            conversation: {
              feed: (dwarfId, page) => conversation.queries.feed(dwarfId, page),
              mineHistory: (mineId) => history.mineHistory(mineId),
              send: (dwarfId, text, paths, requestId) =>
                sending.send(dwarfId, text, paths, requestId),
              describeAttachments: (paths) => sending.describeAttachments(paths)
            },
            crew,
            mines
          }
        }
      }
    }
  }
}

/**
 * B-F12 `message.delivery` (14 §2.4; ADR-022 item 6): after each delivery event's commit, the
 * `Delivery` the Host stored for that message, read from the log (the newest 50 rows of its dwarf,
 * where a row still moving is always kept, INV-61). A row no longer stored sends nothing.
 */
function publishDeliveryFrames(deps: {
  events: Pick<DomainEventBus<SendEvent>, 'subscribe'>
  conversation: Pick<Conversation, 'queries'>
  frames: ConversationFramePublisher
}): void {
  const send = ({ messageId, dwarfId }: { messageId: string; dwarfId: DwarfId }): void => {
    const row = deps.conversation.queries
      .feed(dwarfId, { limit: 50 })
      .messages.find((message) => message.id === messageId)
    const delivery = row === undefined ? undefined : toMessageWire(row).delivery
    if (delivery !== undefined) deps.frames.publishFrame('message.delivery', { delivery })
  }
  deps.events.subscribe('MessageSent', ({ payload }) => send(payload))
  deps.events.subscribe('MessageHandedOver', ({ payload }) => send(payload))
  deps.events.subscribe('MessageReactedTo', ({ payload }) => send(payload))
  deps.events.subscribe('MessageDeliveryFailed', ({ payload }) => send(payload))
}
