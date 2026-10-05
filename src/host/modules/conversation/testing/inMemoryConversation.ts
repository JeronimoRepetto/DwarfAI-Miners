// The conversation module over its in-memory doubles, for application tests (L2, 17 §1.2). Never
// imported by production code (R14). Its transaction runner joins an open transaction, rolls the
// log, the activity runs and the lifecycle facts back when the outermost work throws, and counts the transactions it
// opened. `reboot` stands for a Host restart: new commands over the same stored rows.
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { InMemoryLifecycleFactLog } from '../../../kernel/fakes/InMemoryLifecycleFactLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { ConversationIngest, type ConversationCommands } from '../application/ingest'
import { AskNoter } from '../application/noteAsk'
import { SessionEndRecorder } from '../application/recordSessionEnd'
import { TurnEndRecorder } from '../application/recordTurnEnd'
import type { ConversationEvent } from '../domain/events'
import { InMemoryActivityLog } from './InMemoryActivityLog'
import { InMemoryMessageLog } from './InMemoryMessageLog'

export const CONVERSATION_T0 = 1_790_000_000_000
export const CONVERSATION_EPOCH = 'epoch-0098'
export const CONVERSATION_DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId

/** The commands, plus the held-event hand-off of a caller's transaction (`joinedEvents`). */
export interface InMemoryConversationCommands extends ConversationCommands {
  recordSessionEnd(dwarfId: DwarfId, at: Instant): void
  publishJoined(): void
  discardJoined(): void
}

/**
 * `guardedBus: false` gives a bus without the in-transaction assertion (16 §2.3), so a test can
 * observe what a command would publish before its commit instead of the guard refusing it.
 */
export function inMemoryConversation(options: { guardedBus?: boolean } = {}) {
  let open = false
  const scope = { isInTransaction: () => open }
  const clock = new FakeClock(CONVERSATION_T0)
  const ids = new SequenceIdGenerator()
  const log = new InMemoryMessageLog({ scope, clock, ids })
  const facts = new InMemoryLifecycleFactLog(scope)
  const activity = new InMemoryActivityLog({ scope })
  let transactions = 0
  const transactionRunner: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      const before = { log: log.snapshot(), facts: facts.snapshot(), activity: activity.snapshot() }
      open = true
      transactions += 1
      try {
        return work()
      } catch (error) {
        log.restore(before.log)
        facts.restore(before.facts)
        activity.restore(before.activity)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<ConversationEvent>(
    options.guardedBus === false ? {} : { transactionScope: scope }
  )

  let boots = 0
  const boot = (): InMemoryConversationCommands => {
    boots += 1
    const hostEpoch = boots === 1 ? CONVERSATION_EPOCH : `${CONVERSATION_EPOCH}-${boots}`
    const ingest = new ConversationIngest({
      log,
      activity,
      transactions: transactionRunner,
      scope,
      bus,
      clock,
      ids,
      hostEpoch
    })
    const turnEnds = new TurnEndRecorder({
      facts,
      activity,
      transactions: transactionRunner,
      scope,
      emit: (event, joined) => ingest.emit(event, joined),
      clock,
      ids,
      hostEpoch
    })
    const sessionEnds = new SessionEndRecorder({
      activity,
      transactions: transactionRunner,
      scope,
      emit: (event, joined) => ingest.emit(event, joined),
      clock,
      ids,
      hostEpoch
    })
    const asks = new AskNoter({
      activity,
      transactions: transactionRunner,
      scope,
      emit: (event, joined) => ingest.emit(event, joined),
      clock,
      ids,
      hostEpoch
    })
    return {
      ingest: (dwarfId, entries, origin) => ingest.ingest(dwarfId, entries, origin),
      noteAsk: (dwarfId, change) => asks.noteAsk(dwarfId, change),
      recordTurnEnd: (end) => turnEnds.recordTurnEnd(end),
      recordSessionEnd: (dwarfId, at) => sessionEnds.recordSessionEnd(dwarfId, at),
      publishJoined: () => ingest.publishJoined(),
      discardJoined: () => ingest.discardJoined()
    }
  }
  let commands = boot()

  return {
    get commands(): InMemoryConversationCommands {
      return commands
    },
    log,
    facts,
    activity,
    bus,
    clock,
    scope,
    /** The runner the commands use: a caller's transaction that they join. */
    runner: transactionRunner,
    transactions: () => transactions,
    /** A Host restart: new commands, with nothing held, over the same stored rows and bus. */
    reboot() {
      commands = boot()
    }
  }
}
