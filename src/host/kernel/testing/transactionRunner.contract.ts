// The TransactionRunner conformance suite (16 §2.2, §3 `runTransactionRunnerContract`; 17 §1.3):
// the real runner over the in-memory double and over a database file. There is no fake runner:
// the semantics must be real (16 §3).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../domain/errors'
import type { SqliteDatabase } from '../ports/sqliteDatabase'
import type { TransactionRunner } from '../ports/transactionRunner'
import type { TransactionScope } from '../ports/transactionScope'

export interface TransactionRunnerSubject {
  db: SqliteDatabase
  runner: TransactionRunner & TransactionScope
  /**
   * Whether a second connection to the same database can take the write lock right now, without
   * waiting: it tries `BEGIN IMMEDIATE` and rolls back at once.
   */
  otherWriterCanTakeWriteLock(): boolean
  /** Close every connection the subject opened and remove its files. */
  dispose(): void | Promise<void>
}

class ContractFailure extends Error {}

export function runTransactionRunnerContract(
  makeSubject: () => TransactionRunnerSubject | Promise<TransactionRunnerSubject>
): void {
  describe('TransactionRunner contract', () => {
    let subject: TransactionRunnerSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      subject.db.exec(
        'CREATE TABLE contract_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT'
      )
      return subject
    }

    const insert = (db: SqliteDatabase, id: string) =>
      db.run('INSERT INTO contract_notes (id, body) VALUES (?, ?)', [id, `body of ${id}`])

    const ids = (db: SqliteDatabase) =>
      db.all('SELECT id FROM contract_notes ORDER BY id').map((row) => row.id)

    it('[ADR-005] a work that throws rolls back every write of the transaction', async () => {
      const { db, runner } = await setUp()
      const failure = new ContractFailure('work failed')

      expect(() =>
        runner.inTransaction(() => {
          insert(db, 'a')
          insert(db, 'b')
          throw failure
        })
      ).toThrow(failure)

      expect(ids(db)).toEqual([])
      expect(runner.isInTransaction()).toBe(false)

      // The runner is usable again after a rollback.
      expect(runner.inTransaction(() => insert(db, 'c').changes)).toBe(1)
      expect(ids(db)).toEqual(['c'])
    })

    it('[ADR-005] inTransaction called inside a transaction joins it: one commit, and a throw in the inner work rolls back both', async () => {
      const s = await setUp()
      const { db, runner } = s

      let lockHeldAfterInner: boolean | null = null
      const result = runner.inTransaction(() => {
        insert(db, 'outer')
        const inner = runner.inTransaction(() => {
          insert(db, 'inner')
          return 'inner result'
        })
        // Joined, not committed: the write lock is still held by the one open transaction.
        lockHeldAfterInner = !s.otherWriterCanTakeWriteLock()
        return inner
      })
      expect(result).toBe('inner result')
      expect(lockHeldAfterInner).toBe(true)
      expect(ids(db)).toEqual(['inner', 'outer'])

      const failure = new ContractFailure('inner failed')
      expect(() =>
        runner.inTransaction(() => {
          insert(db, 'outer-2')
          runner.inTransaction(() => {
            insert(db, 'inner-2')
            throw failure
          })
        })
      ).toThrow(failure)
      expect(ids(db)).toEqual(['inner', 'outer'])
      expect(runner.isInTransaction()).toBe(false)
    })

    it('[ADR-005] a throw of a joined inner work that the outer work catches still rolls back the whole transaction', async () => {
      const { db, runner } = await setUp()
      const failure = new ContractFailure('inner failed')

      let thrown: unknown
      try {
        runner.inTransaction(() => {
          insert(db, 'outer')
          try {
            runner.inTransaction(() => {
              insert(db, 'inner')
              throw failure
            })
          } catch {
            // Swallowed: without a savepoint the inner writes cannot be undone alone.
          }
          return 'outer result'
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HostInvariantError)
      expect((thrown as HostInvariantError).cause).toBe(failure)
      expect(ids(db)).toEqual([])
      expect(runner.isInTransaction()).toBe(false)
    })

    it('[ADR-005] a work that returns a promise throws HostInvariantError before anything is committed', async () => {
      const { db, runner } = await setUp()

      expect(() =>
        runner.inTransaction(() => {
          insert(db, 'a')
          return Promise.resolve('too late')
        })
      ).toThrow(HostInvariantError)
      expect(ids(db)).toEqual([])
      expect(runner.isInTransaction()).toBe(false)

      // Any thenable counts, and a joined work is refused the same way.
      expect(() =>
        runner.inTransaction(() => {
          insert(db, 'b')
          return runner.inTransaction(() => ({ then: () => undefined }))
        })
      ).toThrow(HostInvariantError)
      expect(ids(db)).toEqual([])
      expect(runner.isInTransaction()).toBe(false)
    })

    it('[ADR-005] writes start with BEGIN IMMEDIATE so a second writer never upgrades a deferred lock', async () => {
      const s = await setUp()
      const { db, runner } = s
      expect(s.otherWriterCanTakeWriteLock()).toBe(true)

      let otherWriterCouldLock: boolean | null = null
      runner.inTransaction(() => {
        // Only a read so far: a deferred BEGIN would not hold the write lock yet.
        ids(db)
        otherWriterCouldLock = s.otherWriterCanTakeWriteLock()
        insert(db, 'a')
      })

      expect(otherWriterCouldLock).toBe(false)
      expect(s.otherWriterCanTakeWriteLock()).toBe(true)
      expect(ids(db)).toEqual(['a'])
    })

    it('[ADR-005] TransactionScope reports true only inside inTransaction', async () => {
      const { runner } = await setUp()
      const seen: boolean[] = [runner.isInTransaction()]

      runner.inTransaction(() => {
        seen.push(runner.isInTransaction())
        runner.inTransaction(() => seen.push(runner.isInTransaction()))
        seen.push(runner.isInTransaction())
      })
      seen.push(runner.isInTransaction())
      try {
        runner.inTransaction(() => {
          seen.push(runner.isInTransaction())
          throw new ContractFailure('rolled back')
        })
      } catch {
        // expected
      }
      seen.push(runner.isInTransaction())

      expect(seen).toEqual([false, true, true, true, false, true, false])
    })
  })
}
