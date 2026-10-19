// The `ObservedBatchSink` bridge (05 §4 item 1, AMENDMENT-10, OQ-78; 16 §4.3): an observed batch's
// messages go to `conversation.ingest` and its usage to `ledger.creditUsage`, both inside the
// batch's transaction (16 §2.2: a nested call joins it), so a batch's facts, ledger rows and cursor
// advance commit together or not at all (09 §5.2 step 5, §5.3). `apply` publishes nothing.
//
// Each module holds the events of what it wrote in a caller's transaction (`JoinedEvents`, ledger
// ISSUE-076, conversation ISSUE-099), because nothing is published inside a transaction (16 §2.3).
// The port gives the bridge no commit hook, so the bridge also hands observation the runner its
// batches run in: the Host's runner, which after an outermost transaction commits publishes every
// half's held events, conversation's first, and after a rollback drops them. A call made inside an
// open transaction joins it and leaves the held events to the call that opened it. Observation's
// own events of the batch follow, in its own order, after the same commit (16 §4.3 "Ordering").
//
// Built in halves. The ledger's is ISSUE-096's (`ledgerBatchHalf`: usage on the transcript path,
// 11 F2); the conversation's is ISSUE-108's (`conversationBatchHalf`: the batch's entries →
// `ingest(dwarfId, entries, 'transcript')`, an observed batch being read from a provider's
// transcript or store). Without the conversation half the bridge's sink is
// `noObservedBatchSinkYet`: a cursor moved past a batch whose messages nothing stored would lose
// them for good (INV-98), so observation never starts over it (routes/observation.ts).
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import type { ConversationCommands } from '../../modules/conversation'
import type { JoinedEvents, LedgerCommands } from '../../modules/ledger'
import type { ObservedBatchSink } from '../../modules/observation'
import { noObservedBatchSinkYet } from '../routes/observation'

/** One batch as observation hands it over (16 §4.3 `ObservedBatchSink.apply`). */
export type ObservedBatch = Parameters<ObservedBatchSink['apply']>[0]

/** One module's half of the bridge: what it writes of a batch, and the events it holds. */
export interface ObservedBatchHalf {
  /** Runs inside the batch transaction; publishes nothing. */
  apply(batch: ObservedBatch): void
  joinedEvents: JoinedEvents
}

/** The ledger's half: each usage observation of the batch → `creditUsage(o, 'transcript')`. */
export function ledgerBatchHalf(ledger: {
  commands: Pick<LedgerCommands, 'creditUsage'>
  joinedEvents: JoinedEvents
}): ObservedBatchHalf {
  return {
    apply: (batch) => {
      for (const usage of batch.usage) ledger.commands.creditUsage(usage, 'transcript')
    },
    joinedEvents: ledger.joinedEvents
  }
}

/** The conversation's half: the batch's entries → `ingest(dwarfId, entries, 'transcript')`. */
export function conversationBatchHalf(conversation: {
  commands: Pick<ConversationCommands, 'ingest'>
  joinedEvents: JoinedEvents
}): ObservedBatchHalf {
  return {
    apply: (batch) => conversation.commands.ingest(batch.dwarfId, batch.entries, 'transcript'),
    joinedEvents: conversation.joinedEvents
  }
}

export interface ObservedBatchBridgeDeps {
  /** The Host's transaction runner and its probe (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  ledger: ObservedBatchHalf
  /** Conversation's half; null leaves the sink the placeholder, so observation never starts. */
  conversation: ObservedBatchHalf | null
}

export interface ObservedBatchBridge {
  /** Observation's `ObservedBatchSink`; `noObservedBatchSinkYet` while a half is missing. */
  sink: ObservedBatchSink
  /** The runner observation's batches run in: it publishes the halves' events after a commit. */
  transactions: TransactionRunner
}

export function composeObservedBatchSink(deps: ObservedBatchBridgeDeps): ObservedBatchBridge {
  const { transactions, conversation, ledger } = deps
  const halves = conversation === null ? [ledger] : [conversation, ledger]
  return {
    sink:
      conversation === null
        ? noObservedBatchSinkYet
        : {
            apply: (batch) => {
              // 09 §5.2: the messages first, then the usage.
              for (const half of halves) half.apply(batch)
            }
          },
    transactions: {
      inTransaction<T>(work: () => T): T {
        if (transactions.isInTransaction()) return transactions.inTransaction(work)
        let result: T
        try {
          result = transactions.inTransaction(work)
        } catch (error) {
          for (const half of halves) half.joinedEvents.discard()
          throw error
        }
        for (const half of halves) half.joinedEvents.publish()
        return result
      }
    }
  }
}
