// One fake transaction over the observation module's in-memory doubles, for L2 and L3 tests
// (17 §1.2, §1.3): `work` runs synchronously, joins an open transaction (16 §2.2), and a throwing
// `work` restores every participant, as `BEGIN IMMEDIATE … ROLLBACK` does for the SQLite adapters.
// Never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'

/** A double whose rows a rolled-back transaction restores. */
export interface Rollbackable {
  snapshot(): unknown
  restore(snapshot: unknown): void
}

export class InMemoryTransactions implements TransactionRunner, TransactionScope {
  private open = false
  private readonly participants: Rollbackable[] = []
  /** Transactions committed so far (a joined call is not one). */
  committed = 0

  /** Adds a double the next transactions roll back. */
  enlist(participant: Rollbackable): void {
    this.participants.push(participant)
  }

  isInTransaction(): boolean {
    return this.open
  }

  inTransaction<T>(work: () => T): T {
    if (this.open) return work()
    const snapshots = this.participants.map((p) => p.snapshot())
    this.open = true
    try {
      const result = work()
      if (result instanceof Promise) {
        throw new HostInvariantError('inTransaction work must be synchronous (16 §2.2)')
      }
      this.committed += 1
      return result
    } catch (error) {
      this.participants.forEach((p, n) => p.restore(snapshots[n]))
      throw error
    } finally {
      this.open = false
    }
  }
}
