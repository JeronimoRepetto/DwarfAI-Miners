// The Host epoch, its OS boot identity and the clean-shutdown marker in `app_meta` (09 §8.4,
// §4.1; ADR-015 item 4; ADR-002 D7). `app_meta` has no module port: platform and transport write
// it (16 §11, O-16-08). One row holds one epoch at a time, so the boot reads the previous one
// before it writes its own:
//
// - `readPrevious()` (09 §8.4 step 1): the previous epoch, its start instant, its boot identity
//   (a NULL is no reading, `'unknown'`) and its marker — only a marker of that same epoch counts.
// - `beginEpoch(tx, …)` (step 3): ONE update that writes the new epoch, its start instant and the
//   current boot identity (`'unknown'` stored as NULL) and clears the marker. It runs inside the
//   caller's transaction, which the recovery's classification of the previous epoch's owned
//   records joins (lead decision 2026-09-30, ISSUE-173); outside one it throws.
// - `markClean(reason, at)` (step 4): one transaction that marks the running epoch clean with its
//   reason; the epoch's start instant and boot identity stay for the next boot's comparison. The
//   CHECK refuses any other reason, the retired `'idle'` included (AMENDMENT-5).
// - `flush()`: `PRAGMA wal_checkpoint(TRUNCATE)` (09 §8.1 "Checkpoint" at clean shutdown).
//
// The values are never logged or shown (09 §8.4): nothing here records anything.
import type {
  BootIdentity,
  CleanShutdownReason,
  PreviousEpoch
} from '../../kernel/domain/bootIdentity'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { HostEpoch, Instant } from '../../kernel/domain/values'
import type { SqliteDatabase, SqliteParam } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'

export interface HostEpochLogDeps {
  /** The Host's writer. */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  transactions: TransactionRunner & TransactionScope
}

export interface NewEpoch {
  epoch: HostEpoch
  startedAt: Instant
  bootIdentity: BootIdentity
}

const READ_PREVIOUS = `SELECT current_host_epoch, host_epoch_started_at, host_boot_id, host_boot_time_ms,
    host_logon_session_id, clean_shutdown_epoch, clean_shutdown_at, clean_shutdown_reason
  FROM app_meta WHERE id = 1`

const BEGIN_EPOCH = `UPDATE app_meta SET
    current_host_epoch = ?, host_epoch_started_at = ?,
    host_boot_id = ?, host_boot_time_ms = ?, host_logon_session_id = ?,
    clean_shutdown_epoch = NULL, clean_shutdown_at = NULL, clean_shutdown_reason = NULL
  WHERE id = 1`

const MARK_CLEAN = `UPDATE app_meta SET
    clean_shutdown_epoch = current_host_epoch, clean_shutdown_at = ?, clean_shutdown_reason = ?
  WHERE id = 1 AND current_host_epoch IS NOT NULL`

/** `'unknown'` is no reading: stored as NULL (09 §8.4 step 2). */
function stored<T extends string | number>(value: T | 'unknown'): SqliteParam {
  return value === 'unknown' ? null : value
}

function text(value: unknown): string | 'unknown' {
  return value === null || value === undefined ? 'unknown' : String(value)
}

function instant(value: unknown): number | 'unknown' {
  return value === null || value === undefined ? 'unknown' : Number(value)
}

export class HostEpochLog {
  constructor(private readonly deps: HostEpochLogDeps) {}

  readPrevious(): PreviousEpoch | null {
    const [row] = this.deps.db.all(READ_PREVIOUS)
    if (row === undefined) {
      throw new HostInvariantError('app_meta has no row 1; migration 1 seeds it (09 §4.9)')
    }
    if (row['current_host_epoch'] === null) return null
    const epoch = String(row['current_host_epoch'])
    const reason = row['clean_shutdown_reason'] as CleanShutdownReason | null
    return {
      epoch,
      startedAt: Number(row['host_epoch_started_at']),
      bootIdentity: {
        bootId: text(row['host_boot_id']),
        bootTimeMs: instant(row['host_boot_time_ms']),
        logonSessionId: text(row['host_logon_session_id'])
      },
      marker:
        row['clean_shutdown_epoch'] === epoch && reason !== null
          ? { reason, at: Number(row['clean_shutdown_at']) }
          : null
    }
  }

  beginEpoch(tx: TransactionScope, next: NewEpoch): void {
    if (!tx.isInTransaction()) {
      throw new HostInvariantError(
        "beginEpoch runs inside the caller's transaction (09 §8.4 step 3, 16 §2.2)"
      )
    }
    const { changes } = this.deps.db.run(BEGIN_EPOCH, [
      next.epoch,
      next.startedAt,
      stored(next.bootIdentity.bootId),
      stored(next.bootIdentity.bootTimeMs),
      stored(next.bootIdentity.logonSessionId)
    ])
    if (changes !== 1) {
      throw new HostInvariantError('app_meta has no row 1; migration 1 seeds it (09 §4.9)')
    }
  }

  markClean(reason: CleanShutdownReason, at: Instant): void {
    this.deps.transactions.inTransaction(() => this.deps.db.run(MARK_CLEAN, [at, reason]))
  }

  flush(): void {
    this.deps.db.all('PRAGMA wal_checkpoint(TRUNCATE)')
  }
}

/** `app_meta.reset_epoch` (09 §4.1), which the snapshot `meta` section carries (ISSUE-026). */
export function readResetEpoch(db: SqliteDatabase): number {
  const [row] = db.all('SELECT reset_epoch FROM app_meta WHERE id = 1')
  if (row === undefined) {
    throw new HostInvariantError('app_meta has no row 1; migration 1 seeds it (09 §4.9)')
  }
  return Number(row['reset_epoch'])
}
