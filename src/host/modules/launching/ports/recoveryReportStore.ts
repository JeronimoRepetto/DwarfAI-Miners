// Driven port of launching (05 §3.5, 16 §4.5 `RecoveryReportStore`): `host_recovery_reports` and
// `host_recovery_items` (09 §4.3; 10 §3), the one report per Host epoch (INV-58), persisted until a
// UI has shown it and its items are settled (ADR-015 item 5). Every write runs inside the caller's
// transaction (16 §2.2) and throws `HostInvariantError` outside one. Type-only (R2).
//
// - The idempotency key is `hostEpoch`: a second `save` of the same epoch updates that report — its
//   `resumed` list, the items it adds and an item's `messageIds` (the 10 s delivery reconcile lists
//   them after classification); an item's `reason` is fixed by its first save (ADR-015 item 5).
// - `pending()` is the latest report that still has an unsettled item; `markShown` stamps the first
//   display (`shown_at`, the first instant wins) and keeps it pending.
// - `settleItem` records one outcome per listed dwarf, once: `resumed` or `failed` (the person's
//   Retry, OQ-41 A, OQ-43) in `retry_outcome`, or `dismissed`. A second settle, or a settle of a
//   dwarf the report does not list, changes nothing. The last settled item settles the report.
// - `dismissed` has no `retry_outcome` value (10 §`host_recovery_items`: `resumed` | `failed`):
//   a dismissed item leaves the report (package gap, resolved in development: the grouped message
//   no longer lists a dwarf the person dismissed; storing the outcome needs a schema change).
//   Retry and Dismiss are ISSUE-174's (later: ISSUE-174), which adds that migration if its ACs need
//   the stored outcome.
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { HostRecoveryReport } from '../domain/recoveryReport'

export interface RecoveryReportStore {
  save(r: HostRecoveryReport): void
  pending(): HostRecoveryReport | null
  markShown(hostEpoch: string, at: Instant): void
  settleItem(hostEpoch: string, dwarfId: DwarfId, outcome: 'resumed' | 'failed' | 'dismissed'): void
}
