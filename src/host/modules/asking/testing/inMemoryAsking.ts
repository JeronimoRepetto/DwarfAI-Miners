// The asking module as the Host composes it — the broker's `open` (`createAskOpening`) and its answer
// paths and resolutions (`createAsking`) over one `InMemoryAskRepository` — with the channels a test
// gives it, for L2 flow tests outside the module (17 §1.2; host/wiring reaches a module through its
// index or its testing helpers, 05 R15): a `FakeSessionCapabilities`, the `FakeAnswerRecords` and
// `FakeConversationLines` doubles of conversation, a `RecordingEventBus` that refuses a publish
// inside a transaction (16 §2.3), and a `FakeClock` driving a `FakeScheduler`. Never imported by
// production code (R14).
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AnswerRecordEvent } from '../../conversation'
import type { AskChannel } from '../domain/ask'
import type { AskingEvent } from '../domain/events'
import { createAsking, createAskOpening } from '../index'
import type { AskAnswerChannel } from '../ports/askAnswerChannel'
import { FakeSessionCapabilities } from '../ports/fakes/FakeSessionCapabilities'
import { InMemoryAskRepository } from '../ports/fakes/InMemoryAskRepository'
import { FakeAnswerRecords } from './FakeAnswerRecords'
import { FakeConversationLines } from './FakeConversationLines'

export const ASKING_T0 = 1_790_000_000_000
export const ASKING_EPOCH = 'epoch-0134' as HostEpoch

export interface InMemoryAskingChannels {
  /** The answer channel of an ask's `channel` kind, or null when none is composed. */
  channelFor(channel: AskChannel): AskAnswerChannel | null
  /** The composed channel's capability record `staleAnswerSafe`. */
  staleAnswerSafe(channel: AskChannel): boolean
}

export function inMemoryAsking(channels: InMemoryAskingChannels) {
  let open = false
  const scope = { isInTransaction: () => open }
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const clock = new FakeClock(ASKING_T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<AskingEvent | AnswerRecordEvent>({ transactionScope: scope })
  const asks = new InMemoryAskRepository()
  const sessions = new FakeSessionCapabilities()
  const lines = new FakeConversationLines(scope)
  const opening = createAskOpening({
    asks,
    sessions,
    lines,
    joinedLines: lines,
    channelFor: channels.channelFor,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch: ASKING_EPOCH
  })
  const asking = createAsking({
    asks,
    records: new FakeAnswerRecords({ scope, clock, ids }),
    channelFor: channels.channelFor,
    staleAnswerSafe: channels.staleAnswerSafe,
    transactions,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: ASKING_EPOCH
  })
  return { opening, asking, asks, sessions, bus, clock }
}
