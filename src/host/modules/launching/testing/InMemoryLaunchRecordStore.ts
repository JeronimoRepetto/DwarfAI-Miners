// The LaunchRecordStore double (16 §4.5 `InMemoryLaunchRecordStore`; 16 §2.8). It runs
// `runLaunchRecordStoreContract` like `SqliteLaunchRecordStore`: a record's process must have a live
// record in the process double it is given, and reads back only while it does (the `process_id`
// SET NULL of 09 §4.3). It lives in `testing/` because it throws the kernel's `HostInvariantError`
// and ports are type-only (R2); never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, LaunchId } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { InMemoryProcessRecordStore } from './InMemoryProcessRecordStore'

const copy = (r: LaunchRecord): LaunchRecord => ({
  ...r,
  ref: { ...r.ref },
  launchOptions: { ...r.launchOptions },
  ...(r.process !== undefined ? { process: { ...r.process } } : {})
})

export class InMemoryLaunchRecordStore implements LaunchRecordStore {
  /** Records by launch id. */
  private rows = new Map<LaunchId, LaunchRecord>()

  constructor(
    private readonly scope: TransactionScope,
    private readonly processes: InMemoryProcessRecordStore
  ) {}

  put(r: LaunchRecord): void {
    this.requireTransaction('put')
    if (r.process !== undefined && !this.processes.has(r.process)) {
      throw new HostInvariantError(
        'a launch record names a process with no live ProcessRecord: record the process first (16 §2.2)'
      )
    }
    for (const [launchId, stored] of this.rows) {
      if (stored.dwarfId === r.dwarfId && launchId !== r.launchId) {
        throw new HostInvariantError('a dwarf has one launch record (launch_records PK dwarf_id)')
      }
    }
    const stored = this.rows.get(r.launchId)
    if (stored !== undefined && stored.dwarfId !== r.dwarfId) {
      throw new HostInvariantError("a launch's record never changes dwarf")
    }
    const record = copy(r)
    if (record.endedAt !== undefined) record.resumeIntent = false
    this.rows.set(r.launchId, record)
  }

  remove(id: LaunchId): void {
    this.requireTransaction('remove')
    this.rows.delete(id)
  }

  all(): LaunchRecord[] {
    return this.read()
  }

  markStoppedByPerson(dwarfId: DwarfId): void {
    this.requireTransaction('markStoppedByPerson')
    for (const record of this.rows.values()) {
      if (record.dwarfId === dwarfId && record.endedAt === undefined) record.stoppedByPerson = true
    }
  }

  live(): LaunchRecord[] {
    return this.read().filter((r) => r.endedAt === undefined)
  }

  snapshot(): ReadonlyMap<LaunchId, LaunchRecord> {
    return new Map([...this.rows].map(([id, r]) => [id, copy(r)]))
  }

  restore(rows: ReadonlyMap<LaunchId, LaunchRecord>): void {
    this.rows = new Map(rows)
  }

  /** In launch order; a process whose record ended reads back as none. */
  private read(): LaunchRecord[] {
    return [...this.rows.values()]
      .sort((a, b) => (a.launchId < b.launchId ? -1 : a.launchId > b.launchId ? 1 : 0))
      .map((r) => {
        const out = copy(r)
        if (out.process !== undefined && !this.processes.has(out.process)) delete out.process
        return out
      })
  }

  private requireTransaction(method: string): void {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError(
        `LaunchRecordStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}
