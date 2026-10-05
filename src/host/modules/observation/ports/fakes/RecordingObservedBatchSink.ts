// The ObservedBatchSink double (16 §4.3 `RecordingObservedBatchSink`). Never imported by
// production code (R14). It records each applied batch as conversation and ledger would store it,
// so a rolled-back transaction leaves no record (`snapshot` / `restore`), and it can fail the next
// batch the way a crash inside the transaction does. Type-only imports (05 R2).
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type { ObservedBatchSink } from '../observedBatchSink'

type Batch = Parameters<ObservedBatchSink['apply']>[0]

export class RecordingObservedBatchSink implements ObservedBatchSink {
  /** The batches of committed transactions, in order. */
  applied: Batch[] = []
  private failures: Error[] = []

  constructor(private readonly scope: TransactionScope) {}

  apply(batch: Batch): void {
    if (!this.scope.isInTransaction()) {
      throw new Error('ObservedBatchSink.apply runs inside the batch transaction (16 §4.3)')
    }
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    this.applied.push(structuredClone(batch))
  }

  /** The next `apply` throws `error` (a crash inside the batch transaction). */
  failNext(error: Error): void {
    this.failures.push(error)
  }

  snapshot(): unknown {
    return structuredClone(this.applied)
  }

  restore(snapshot: unknown): void {
    this.applied = structuredClone(snapshot as Batch[])
  }
}
