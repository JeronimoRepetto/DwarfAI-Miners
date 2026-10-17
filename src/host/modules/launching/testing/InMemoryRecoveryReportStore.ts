// The RecoveryReportStore double (16 §4.5 `InMemoryRecoveryReportStore`; 16 §2.8). It runs
// `runRecoveryReportStoreContract` like `SqliteRecoveryReportStore`. It lives in `testing/`, beside
// the module's other store doubles, because it throws the kernel's `HostInvariantError` and ports
// are type-only (R2); never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { HostRecoveryReport, UnrecoveredReason } from '../domain/recoveryReport'
import type { RecoveryReportStore } from '../ports/recoveryReportStore'

interface ItemRow {
  dwarfId: string
  reason: UnrecoveredReason
  messageIds?: string[]
  retryOutcome: 'resumed' | 'failed' | null
}

interface ReportRow {
  hostEpoch: string
  at: Instant
  resumed: string[]
  shownAt: Instant | null
  settled: boolean
  items: ItemRow[]
}

const copyRow = (row: ReportRow): ReportRow => ({
  ...row,
  resumed: [...row.resumed],
  items: row.items.map((item) => ({
    ...item,
    ...(item.messageIds === undefined ? {} : { messageIds: [...item.messageIds] })
  }))
})

export class InMemoryRecoveryReportStore implements RecoveryReportStore {
  private rows: ReportRow[] = []

  constructor(private readonly scope: TransactionScope) {}

  save(r: HostRecoveryReport): void {
    this.requireTransaction('save')
    let row = this.rows.find((candidate) => candidate.hostEpoch === r.hostEpoch)
    if (row === undefined) {
      row = {
        hostEpoch: r.hostEpoch,
        at: r.at,
        resumed: [],
        shownAt: null,
        settled: false,
        items: []
      }
      this.rows.push(row)
    }
    row.resumed = [...r.resumed]
    for (const item of r.unrecovered) {
      const known = row.items.find((candidate) => candidate.dwarfId === item.dwarfId)
      if (known === undefined) {
        row.items.push({
          dwarfId: item.dwarfId,
          reason: item.reason,
          ...(item.messageIds === undefined ? {} : { messageIds: [...item.messageIds] }),
          retryOutcome: null
        })
      } else if (item.messageIds !== undefined) {
        known.messageIds = [...item.messageIds]
      }
    }
    row.settled = row.items.every((item) => item.retryOutcome !== null)
  }

  pending(): HostRecoveryReport | null {
    const row = [...this.rows]
      .filter((candidate) => !candidate.settled)
      .sort((x, y) => y.at - x.at)[0]
    if (row === undefined) return null
    return {
      hostEpoch: row.hostEpoch,
      at: row.at,
      resumed: [...row.resumed],
      unrecovered: [...row.items]
        .sort((x, y) => (x.dwarfId < y.dwarfId ? -1 : x.dwarfId > y.dwarfId ? 1 : 0))
        .map((item) => ({
          dwarfId: item.dwarfId,
          reason: item.reason,
          ...(item.messageIds === undefined ? {} : { messageIds: [...item.messageIds] })
        }))
    }
  }

  markShown(hostEpoch: string, at: Instant): void {
    this.requireTransaction('markShown')
    const row = this.rows.find((candidate) => candidate.hostEpoch === hostEpoch)
    if (row !== undefined && row.shownAt === null) row.shownAt = at
  }

  settleItem(
    hostEpoch: string,
    dwarfId: DwarfId,
    outcome: 'resumed' | 'failed' | 'dismissed'
  ): void {
    this.requireTransaction('settleItem')
    const row = this.rows.find((candidate) => candidate.hostEpoch === hostEpoch)
    const item = row?.items.find((candidate) => candidate.dwarfId === dwarfId)
    if (row === undefined || item === undefined || item.retryOutcome !== null) return
    if (outcome === 'dismissed') row.items = row.items.filter((candidate) => candidate !== item)
    else item.retryOutcome = outcome
    row.settled = row.items.every((candidate) => candidate.retryOutcome !== null)
  }

  /** The stored retry outcome of a listed dwarf (the contract's read). */
  retryOutcome(hostEpoch: string, dwarfId: DwarfId): 'resumed' | 'failed' | null {
    const row = this.rows.find((candidate) => candidate.hostEpoch === hostEpoch)
    return row?.items.find((candidate) => candidate.dwarfId === dwarfId)?.retryOutcome ?? null
  }

  /** The stored first-display instant (the contract's read). */
  shownAt(hostEpoch: string): number | null {
    return this.rows.find((candidate) => candidate.hostEpoch === hostEpoch)?.shownAt ?? null
  }

  /** The rows, for a test transaction to restore when its work throws. */
  snapshot(): ReportRow[] {
    return this.rows.map(copyRow)
  }

  restore(rows: ReportRow[]): void {
    this.rows = rows.map(copyRow)
  }

  private requireTransaction(method: string): void {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError(
        `RecoveryReportStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}
