// The conversation module over its in-memory doubles, for application tests (L2, 17 §1.2). Never
// imported by production code (R14). Its transaction runner joins an open transaction, rolls the
// log back when the outermost work throws, and counts the transactions it opened.
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { ConversationIngest } from '../application/ingest'
import type { ConversationEvent } from '../domain/events'
import { InMemoryMessageLog } from './InMemoryMessageLog'

export const CONVERSATION_T0 = 1_790_000_000_000
export const CONVERSATION_EPOCH = 'epoch-0098'
export const CONVERSATION_DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId

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
  let transactions = 0
  const transactionRunner: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      const before = log.snapshot()
      open = true
      transactions += 1
      try {
        return work()
      } catch (error) {
        log.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<ConversationEvent>(
    options.guardedBus === false ? {} : { transactionScope: scope }
  )
  const commands = new ConversationIngest({
    log,
    transactions: transactionRunner,
    bus,
    clock,
    ids,
    hostEpoch: CONVERSATION_EPOCH
  })
  return {
    commands,
    log,
    bus,
    clock,
    scope,
    transactions: () => transactions
  }
}
