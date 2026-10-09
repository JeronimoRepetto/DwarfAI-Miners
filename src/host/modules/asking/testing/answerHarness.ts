// The asking answer paths over in-memory doubles, for application tests (L2, 17 §1.2): the
// `InMemoryAskRepository`, the `FakeAnswerRecords` double of conversation's `AnswerRecords` (asking
// reaches conversation only through its index, 05 R4), the `FakeAskAnswerChannel`, a `RecordingEventBus` that refuses a publish inside a transaction (16
// §2.3), and a `FakeClock` driving a `FakeScheduler`. Never imported by production code (R14).
//
// Its transaction runner joins an open transaction and, when the outermost work throws, rolls the
// asks, the `ask_answers` rows and the answers-records back together — the one transaction of 09 §8.2.
// `faults.link` makes the next `linkRecord` throw, to fail the first transaction at its last write.
// `reboot()` builds new answer paths over the same rows: a Host restart.
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { AskId, DwarfId, MessageId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AnswerRecordEvent } from '../../conversation'
import { createAsking } from '../index'
import type { Ask } from '../domain/ask'
import type { AskingEvent } from '../domain/events'
import type { AskAnswerChannel } from '../ports/askAnswerChannel'
import { FakeAskAnswerChannel } from '../ports/fakes/FakeAskAnswerChannel'
import { InMemoryAskRepository, InMemoryAskRows } from '../ports/fakes/InMemoryAskRepository'
import { askId, permissionAsk, questionAsk } from './askRepository.contract'
import { FakeAnswerRecords } from './FakeAnswerRecords'

export const ANSWER_T0 = 1_790_000_000_000
export const ANSWER_EPOCH = 'epoch-0128'
export const ANSWER_DWARF = '00000000-0000-7000-8000-0000000128d1' as DwarfId
export const OTHER_DWARF = '00000000-0000-7000-8000-0000000128d2' as DwarfId

export type AnswerPathsEvent = AskingEvent | AnswerRecordEvent

/** `InMemoryAskRepository` whose next `linkRecord` throws while `faults.link` is set. */
class FaultyAskRepository extends InMemoryAskRepository {
  constructor(
    rows: InMemoryAskRows,
    private readonly faults: { link: boolean }
  ) {
    super(rows)
  }

  override linkRecord(requestId: string, messageId: MessageId): void {
    if (this.faults.link) {
      this.faults.link = false
      throw new Error('linkRecord failed')
    }
    super.linkRecord(requestId, messageId)
  }
}

export function answerHarness() {
  let open = false
  const scope = { isInTransaction: () => open }
  const clock = new FakeClock(ANSWER_T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const rows = new InMemoryAskRows()
  const faults = { link: false }
  const asks = new FaultyAskRepository(rows, faults)
  const records = new FakeAnswerRecords({ scope, clock, ids })
  /** Messages sent through "Other thing…" (the send path's rows; `conversation.send` is ISSUE-166). */
  const otherThings: { dwarfId: DwarfId; text: string }[] = []
  const channel = new FakeAskAnswerChannel()
  /** Whether a transaction was open at each channel call (it must never be). */
  const callsInTransaction: boolean[] = []
  const guarded: AskAnswerChannel = {
    answerQuestion: (ref, providerRequestId, answers) => {
      callsInTransaction.push(open)
      return channel.answerQuestion(ref, providerRequestId, answers)
    },
    answerPermission: (ref, providerRequestId, decision) => {
      callsInTransaction.push(open)
      return channel.answerPermission(ref, providerRequestId, decision)
    },
    declineQuestion: (ref, providerRequestId) => channel.declineQuestion(ref, providerRequestId)
  }
  let transactions = 0
  const transactionRunner: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      const before = {
        asks: structuredClone([...rows.asks]),
        settlements: structuredClone(rows.settlements),
        records: records.snapshot()
      }
      open = true
      transactions += 1
      try {
        return work()
      } catch (error) {
        rows.asks.clear()
        for (const [id, ask] of before.asks) rows.asks.set(id, ask)
        rows.settlements.splice(0, rows.settlements.length, ...before.settlements)
        records.restore(before.records)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<AnswerPathsEvent>({ transactionScope: scope })

  const boot = () =>
    createAsking({
      asks,
      records,
      channelFor: (kind) => (kind === 'none' ? null : guarded),
      transactions: transactionRunner,
      bus,
      clock,
      scheduler,
      ids,
      hostEpoch: ANSWER_EPOCH
    }).answers

  /** Saves `ask` as the broker's `open` would have (ISSUE-127's repository; `open` is later work). */
  const seed = (ask: Ask): Ask => {
    transactionRunner.inTransaction(() => asks.save(ask))
    return ask
  }

  return {
    paths: boot(),
    reboot: boot,
    asks,
    rows,
    otherThings,
    channel,
    callsInTransaction,
    bus,
    clock,
    faults,
    transactions: () => transactions,
    seed,
    permission: (n: number, overrides: Partial<Ask> = {}) =>
      seed(permissionAsk(n, ANSWER_DWARF, overrides)),
    question: (n: number, overrides: Partial<Ask> = {}) =>
      seed(questionAsk(n, ANSWER_DWARF, overrides)),
    askId: (n: number): AskId => askId(n),
    /** The dwarf's "Answers:" records with their deliveries. */
    records: (dwarfId: DwarfId = ANSWER_DWARF) => records.of(dwarfId),
    /**
     * A message sent through "Other thing…": an ordinary person message on the send path (its
     * writer, `conversation.send`, is later: ISSUE-166), which never reaches the broker (INV-69).
     */
    sendOtherThing: (text: string, dwarfId: DwarfId = ANSWER_DWARF) => {
      otherThings.push({ dwarfId, text })
    },
    /** The published event types, in order. */
    eventTypes: () => bus.published.map((event) => event.type)
  }
}
