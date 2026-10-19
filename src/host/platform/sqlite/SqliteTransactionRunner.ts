// The Host's one way to write (16 §2.2, §3 `TransactionRunner`; 09 §8.1; ADR-005 item 7).
//
// - `work` runs synchronously inside `BEGIN IMMEDIATE … COMMIT`: the write lock is taken up front,
//   so a second writer never meets a deferred lock upgrade (HO-24).
// - A `work` that throws rolls the transaction back and its error propagates unchanged.
// - A call made while a transaction is open joins it (no savepoint). A joined work that throws
//   dooms the whole transaction: even if an outer work catches that error, nothing commits and
//   the outermost call throws `HostInvariantError` with the inner error as its cause.
// - A `work` that returns a thenable is a programming error: `HostInvariantError`, checked before
//   committing, and the transaction rolls back.
// - It is the `TransactionScope` probe of the event bus (16 §2.3): true only while a transaction
//   is open.
import { HostInvariantError } from '../../kernel/domain/errors'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function refuseThenable(value: unknown): void {
  if (isThenable(value)) {
    throw new HostInvariantError(
      'inTransaction work returned a promise; a transaction never spans an await (16 §2.2)'
    )
  }
}

interface OpenTransaction {
  /** The first error a joined work threw; once set, the transaction can only roll back. */
  doomedBy: { error: unknown } | null
}

export class SqliteTransactionRunner implements TransactionRunner, TransactionScope {
  private open: OpenTransaction | null = null

  constructor(private readonly db: SqliteDatabase) {}

  isInTransaction(): boolean {
    return this.open !== null
  }

  inTransaction<T>(work: () => T): T {
    const current = this.open
    return current === null ? this.runOutermost(work) : this.runJoined(current, work)
  }

  private runJoined<T>(transaction: OpenTransaction, work: () => T): T {
    try {
      const result = work()
      refuseThenable(result)
      return result
    } catch (error) {
      transaction.doomedBy ??= { error }
      throw error
    }
  }

  private runOutermost<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    const transaction: OpenTransaction = { doomedBy: null }
    this.open = transaction
    let result: T
    try {
      result = work()
      refuseThenable(result)
      if (transaction.doomedBy !== null) {
        throw new HostInvariantError(
          'a joined inTransaction work threw and the error was caught; the whole transaction was rolled back (16 §2.2)',
          { cause: transaction.doomedBy.error }
        )
      }
    } catch (error) {
      this.rollback()
      throw error
    }
    try {
      this.db.exec('COMMIT')
    } catch (error) {
      // A failed COMMIT (SQLITE_BUSY, SQLITE_FULL) can leave the transaction open.
      this.rollback()
      throw error
    }
    this.open = null
    return result
  }

  private rollback(): void {
    this.open = null
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back (it does on some errors, e.g. SQLITE_FULL): nothing is open.
    }
  }
}
