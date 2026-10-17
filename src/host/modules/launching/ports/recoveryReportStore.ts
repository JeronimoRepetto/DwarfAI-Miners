// Driven port of launching (05 §3.5, 16 §4.5 `RecoveryReportStore`): `host_recovery_reports` and
// `host_recovery_items` (09 §4.3; 10 §3), the one report per Host epoch (INV-58), persisted until a
// UI has shown it and its items are settled (ADR-015 item 5). Every write runs inside the caller's
// transaction (16 §2.2) and throws `HostInvariantError` outside one. Type-only (R2).
//
// - The idempotency key is `hostEpoch`: a second `save` of the same epoch updates that report — its
//   `resumed` list, the items it adds and an item's `messageIds` (the 10 s delivery reconcile lists
//   them after classification); an item's `reason` is fixed by its first save (ADR-015 item 5). A
//   `save` of another epoch supersedes every earlier report not settled yet (07 S16.09): the
//   recovery pass reads the earlier `pending()` first and carries its unsettled items over.
// - `pending()` is the latest report that still has an unsettled item, listing those items only (a
//   settled dwarf leaves the grouped message, 07 S2.11, S2.12); `markShown` stamps the first display
//   (`shown_at`, the first instant wins) and keeps it pending.
// - `settleItem` records one outcome per listed dwarf, once: `resumed` or `failed` (the person's
//   Retry, OQ-41 A, OQ-43) in `retry_outcome`, or `dismissed`. A second settle, a settle of a dwarf
//   the report does not list, or one of a superseded report changes nothing. The last settled item
//   settles the report.
// - `dismissed` has no `retry_outcome` value (10 §`host_recovery_items`: `resumed` | `failed`): a
//   dismissed item leaves the report. ISSUE-174 needs no stored `dismissed` outcome (no new
//   migration): after a Dismiss the dwarf is gone or its session runs, the report is `settled`, and
//   nothing reads the outcome back (US-RES-009.AC06).
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { HostRecoveryReport } from '../domain/recoveryReport'

export interface RecoveryReportStore {
  save(r: HostRecoveryReport): void
  pending(): HostRecoveryReport | null
  markShown(hostEpoch: string, at: Instant): void
  settleItem(hostEpoch: string, dwarfId: DwarfId, outcome: 'resumed' | 'failed' | 'dismissed'): void
}
