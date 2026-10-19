// Test helper for the TransactionRunner contract: a second connection that asks whether the
// database's write lock is free right now. Never imported by production code (R14).
import type { DatabaseSync } from 'node:sqlite'

const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/**
 * Try `BEGIN IMMEDIATE` on `other` and roll back at once. `false` when another connection holds
 * the write lock (`SQLITE_BUSY` on a file, `SQLITE_LOCKED` on a shared-cache memory database).
 * `other` must be opened with no busy timeout, so the answer never waits.
 */
export function otherWriterCanTakeWriteLock(other: DatabaseSync): boolean {
  try {
    other.exec('BEGIN IMMEDIATE')
  } catch (error) {
    const errcode = (error as { errcode?: unknown }).errcode
    if (typeof errcode === 'number' && [SQLITE_BUSY, SQLITE_LOCKED].includes(errcode & 0xff)) {
      return false
    }
    throw error
  }
  other.exec('ROLLBACK')
  return true
}
