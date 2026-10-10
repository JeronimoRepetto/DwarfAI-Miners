// The conversation module's wiring, its read side (05 §3.6, §4; 16 §4.6, §8.2, §8.3; ISSUE-108), in
// two parts, as routes/crew.ts:
//
// - `serveConversation`, run by the composition root before the boot binds the endpoint: B-M26
//   `conversation.feed` and B-M27 `conversation.mineHistory` (14 §2.3) and the `tails` snapshot
//   section (14 §3.7, §4.1), so every `hello.ok` lists them (14 §1.3). They forward to the one
//   instance boot step 4 constructs; until then the dispatcher answers HOST_NOT_READY before any
//   handler runs (14 §3.3), and the section is never read before `ready`.
// - `wire`, run by boot step 4 before observation (whose batch sink holds the module's half):
//   `createConversation` over the Host database (`SqliteMessageLog`, `SqliteActivityLog`) and the one
//   kernel `LifecycleFactLog` crew shares (05 §4 item 1; 16 §3), and the conversation half of the
//   `ObservedBatchSink` bridge (bridges/observedBatchSink.ts, AMENDMENT-10).
// - `route`, run by boot step 4 once crew and mines exist: the mine history over crew's public
//   queries (the conversation → crew edge, 05 §1.3), the `tails` section over mines' and crew's, and
//   the frames of conversation's events (routes/conversationFrames.ts), subscribed before step 7's
//   catch-up publishes the first of them (16 §8.2).
//
// Not routed here, and why:
// - `ObservedTurnEnded` (observation) → `recordTurnEnd`, `TurnEnded` → crew and attention,
//   `DwarfDeparted` → `recordSessionEnd` (05 §4): the cut-1 routes (routes/cut1Routes.ts,
//   ISSUE-120). The ask routes → `noteAsk`: routes/askingRoutes.ts (ISSUE-140).
// - The Reset saga's conversation step (`createConversationResetStep`): ISSUE-121.
// - The write side (`send`, `retry`, `AnswerRecords`, `message.delivery`): EPIC-10 (ISSUE-182).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import {
  createConversation,
  type Conversation,
  type ConversationEvent,
  type ConversationQueries
} from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import type { Dispatcher } from '../../transport/dispatcher'
import type { ConversationFramePublisher } from '../../transport/frames/conversationAppended'
import { registerConversationFeed } from '../../transport/methods/conversationFeed'
import { registerConversationMineHistory } from '../../transport/methods/conversationMineHistory'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { registerTailsSection } from '../../transport/snapshot/tailsSection'
import { conversationBatchHalf, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import { publishConversationReadFrames } from './conversationFrames'

/** The events the conversation wiring publishes or projects: one Host bus carries them all (16 §2.3). */
export type ConversationRouteEvent = ConversationEvent

export interface ConversationServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M26 and B-M27 join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where `tails` joins (after the board's, 14 §4.2). */
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
  bus: DomainEventBus<ConversationEvent>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** Where the frames go: the connection registry. */
  frames: ConversationFramePublisher
}

/** Crew's and mines' halves of the conversation routes, through their public doors. */
export interface ConversationCrewRoute {
  crew: Pick<CrewQueries, 'get' | 'crewOf'>
  mines: Pick<MinesQueries, 'list'>
}

export interface WiredConversation {
  /** The one instance. */
  conversation: Conversation
  /** The conversation half of the `ObservedBatchSink` bridge. */
  batchHalf: ObservedBatchHalf
  /** Boot step 4, once crew and mines are wired: the history, the tails and the frames. */
  route(deps: ConversationCrewRoute): void
}

export interface ServedConversation {
  /** Boot step 4: constructs the module the served members forward to. */
  wire(deps: ConversationWiringDeps): WiredConversation
}

/** The members the served methods and section forward to. */
type ServedMembers = {
  conversation: Pick<ConversationQueries, 'feed' | 'mineHistory'>
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
  registerConversationFeed(serve.dispatcher, {
    conversation: { feed: (dwarfId, page) => current().conversation.feed(dwarfId, page) }
  })
  registerConversationMineHistory(serve.dispatcher, {
    conversation: { mineHistory: (mineId) => current().conversation.mineHistory(mineId) }
  })
  registerTailsSection(serve.sections, {
    mines: { list: (query) => current().mines.list(query) },
    crew: { crewOf: (mineId, opts) => current().crew.crewOf(mineId, opts) },
    conversation: { feed: (dwarfId, page) => current().conversation.feed(dwarfId, page) }
  })
  let wired = false
  return {
    wire: (deps) => {
      if (wired) throw new HostInvariantError('conversation is wired once')
      wired = true
      const conversation = createConversation(deps)
      return {
        conversation,
        batchHalf: conversationBatchHalf(conversation),
        route: ({ crew, mines }) => {
          if (served !== undefined) throw new HostInvariantError('conversation is routed once')
          publishConversationReadFrames({ events: deps.bus, crew, frames: deps.frames })
          const history = conversation.history({ crew })
          served = {
            conversation: {
              feed: (dwarfId, page) => conversation.queries.feed(dwarfId, page),
              mineHistory: (mineId) => history.mineHistory(mineId)
            },
            crew,
            mines
          }
        }
      }
    }
  }
}
