// `SqliteRecoveryReportStore` (16 §4.5; 05 §3.5): `host_recovery_reports` and
// `host_recovery_items` (09 §4.3; 10 §3), in bound SQL through the kernel `SqliteDatabase` port
// (R11). Every write joins the caller's transaction (16 §2.2): outside one it throws
// `HostInvariantError` and writes nothing.
//
// - `save` upserts the epoch's one report (INV-58): `resumed_json` is replaced, a new item is
//   inserted, and a listed item keeps its first `reason` while its `message_ids_json` follows the
//   latest save (the delivery reconcile lists the sends after classification).
// - `pending()` is the latest report, by `at`, that is neither `settled` nor `superseded` and still
//   lists an item with no `retry_outcome`. A report with no item is never pending: nothing is shown
//   when `unrecovered` is empty (ADR-015 item 5). Items read back by `dwarf_id` (UUIDv7: arrival order).
// - `markShown` sets `shown_at` once and moves `pending-display` to `shown` (07 §16).
// - `settleItem` sets `retry_outcome` once (`resumed` / `failed`); `dismissed`, which the column
//   cannot hold, deletes the item (ports/recoveryReportStore.ts). When no unsettled item is left
//   and the report was shown, the report is `settled` with `settled_at` from the `Clock` (the
//   table's CHECKs: `settled` iff `settled_at`, and only once `shown_at` is set).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { DwarfId, Instant } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type { HostRecoveryReport, UnrecoveredReason } from '../../domain/recoveryReport'
import type { RecoveryReportStore } from '../../ports/recoveryReportStore'

export interface SqliteRecoveryReportStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `settled_at`. */
  clock: Clock
}

const SAVE_REPORT = `INSERT INTO host_recovery_reports (host_epoch, at, resumed_json) VALUES (?, ?, ?)
  ON CONFLICT (host_epoch) DO UPDATE SET resumed_json = excluded.resumed_json`

const SAVE_ITEM = `INSERT INTO host_recovery_items (host_epoch, dwarf_id, reason, message_ids_json)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (host_epoch, dwarf_id) DO UPDATE SET
    message_ids_json = coalesce(excluded.message_ids_json, host_recovery_items.message_ids_json)`

const PENDING = `SELECT r.host_epoch, r.at, r.resumed_json FROM host_recovery_reports r
  WHERE r.state NOT IN ('settled', 'superseded')
    AND EXISTS (SELECT 1 FROM host_recovery_items i
                WHERE i.host_epoch = r.host_epoch AND i.retry_outcome IS NULL)
  ORDER BY r.at DESC, r.host_epoch DESC LIMIT 1`

const ITEMS = `SELECT dwarf_id, reason, message_ids_json FROM host_recovery_items
  WHERE host_epoch = ? ORDER BY dwarf_id`

const MARK_SHOWN = `UPDATE host_recovery_reports SET shown_at = ?,
    state = CASE state WHEN 'pending-display' THEN 'shown' ELSE state END
  WHERE host_epoch = ? AND shown_at IS NULL`

const SETTLE_ITEM = `UPDATE host_recovery_items SET retry_outcome = ?
  WHERE host_epoch = ? AND dwarf_id = ? AND retry_outcome IS NULL`

const DISMISS_ITEM = `DELETE FROM host_recovery_items
  WHERE host_epoch = ? AND dwarf_id = ? AND retry_outcome IS NULL`

const SETTLE_REPORT = `UPDATE host_recovery_reports SET state = 'settled', settled_at = ?
  WHERE host_epoch = ? AND shown_at IS NOT NULL AND state NOT IN ('settled', 'superseded')
    AND NOT EXISTS (SELECT 1 FROM host_recovery_items i
                    WHERE i.host_epoch = host_recovery_reports.host_epoch
                      AND i.retry_outcome IS NULL)`

export class SqliteRecoveryReportStore implements RecoveryReportStore {
  constructor(private readonly deps: SqliteRecoveryReportStoreDeps) {}

  save(r: HostRecoveryReport): void {
    this.requireTransaction('save')
    const { db } = this.deps
    db.run(SAVE_REPORT, [r.hostEpoch, r.at, JSON.stringify(r.resumed)])
    for (const item of r.unrecovered) {
      db.run(SAVE_ITEM, [
        r.hostEpoch,
        item.dwarfId,
        item.reason,
        item.messageIds === undefined ? null : JSON.stringify(item.messageIds)
      ])
    }
  }

  pending(): HostRecoveryReport | null {
    const [row] = this.deps.db.all(PENDING)
    if (row === undefined) return null
    const hostEpoch = String(row['host_epoch'])
    return {
      hostEpoch,
      at: Number(row['at']),
      resumed: JSON.parse(String(row['resumed_json'])) as string[],
      unrecovered: this.deps.db.all(ITEMS, [hostEpoch]).map(toItem)
    }
  }

  markShown(hostEpoch: string, at: Instant): void {
    this.requireTransaction('markShown')
    this.deps.db.run(MARK_SHOWN, [at, hostEpoch])
  }

  settleItem(
    hostEpoch: string,
    dwarfId: DwarfId,
    outcome: 'resumed' | 'failed' | 'dismissed'
  ): void {
    this.requireTransaction('settleItem')
    const { db } = this.deps
    const { changes } =
      outcome === 'dismissed'
        ? db.run(DISMISS_ITEM, [hostEpoch, dwarfId])
        : db.run(SETTLE_ITEM, [outcome, hostEpoch, dwarfId])
    if (changes > 0) db.run(SETTLE_REPORT, [this.deps.clock.now(), hostEpoch])
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `RecoveryReportStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}

function toItem(row: SqliteRow): HostRecoveryReport['unrecovered'][number] {
  const ids = row['message_ids_json']
  return {
    dwarfId: String(row['dwarf_id']),
    reason: row['reason'] as UnrecoveredReason,
    ...(ids === null ? {} : { messageIds: JSON.parse(String(ids)) as string[] })
  }
}
