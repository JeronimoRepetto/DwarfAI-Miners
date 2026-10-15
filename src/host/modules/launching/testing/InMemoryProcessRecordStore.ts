// The ProcessRecordStore double (16 §4.5 `InMemoryProcessRecordStore`; 16 §2.8). It runs
// `runProcessRecordStoreContract` like `SqliteProcessRecordStore`. It lives in `testing/`, not
// `ports/fakes/`, because it throws the kernel's `HostInvariantError` and ports are type-only (R2);
// never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { Instant } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ProcessRecord, ProcessRecordStore } from '../ports/processRecordStore'

interface ProcessRow {
  record: ProcessRecord
  recordedAt: Instant
}

const sameKey = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
  a.pid === b.pid && a.processStartTimeMs === b.processStartTimeMs && a.bootId === b.bootId

const copy = (p: ProcessRecord): ProcessRecord => ({ ...p, identity: { ...p.identity } })

export class InMemoryProcessRecordStore implements ProcessRecordStore {
  private rows: ProcessRow[] = []

  constructor(
    private readonly scope: TransactionScope,
    private readonly clock: Clock
  ) {}

  put(p: ProcessRecord): void {
    this.requireTransaction('put')
    if (this.rows.some((row) => sameKey(row.record.identity, p.identity))) return
    this.rows.push({ record: copy(p), recordedAt: this.clock.now() })
  }

  ended(pid: number, at: Instant): void {
    this.requireTransaction('ended')
    this.rows = this.rows.filter((row) => row.record.identity.pid !== pid || row.recordedAt > at)
  }

  live(): ProcessRecord[] {
    return this.rows.map((row) => copy(row.record))
  }

  /** Whether `identity` has a live record (what `launch_records.process_id` references). */
  has(identity: ProcessIdentity): boolean {
    return this.rows.some((row) => sameKey(row.record.identity, identity))
  }

  snapshot(): readonly ProcessRow[] {
    return [...this.rows]
  }

  restore(rows: readonly ProcessRow[]): void {
    this.rows = [...rows]
  }

  private requireTransaction(method: string): void {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError(
        `ProcessRecordStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}
