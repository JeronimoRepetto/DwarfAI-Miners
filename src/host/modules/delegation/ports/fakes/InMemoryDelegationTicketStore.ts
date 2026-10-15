// The DelegationTicketStore double (16 §4.8 `InMemoryDelegationTicketStore`). Never imported by
// production code (R14).
//
// It keeps the SQLite adapter's rules, held equal by the shared runDelegationTicketStoreContract:
// the 09 §4.6 `delegations` CHECKs (`failure` exactly when `failed`; `settledAt` exactly when
// settled; `succeeded` only with `handoff.phase = 'delivered'`; no task or context once settled;
// the worker never the parent) and its UNIQUEs (id, ticket, worker). `save` writes the next state
// of a delegation that exists, keeping its id, parent, ticket and `createdAt`. It has no
// transaction of its own: a test's transaction rolls it back with `snapshot` / `restore`.
import type { Delegation } from '../../domain/delegation'
import type { DelegationTicketStore } from '../delegationStores'

export class InMemoryDelegationTicketStore implements DelegationTicketStore {
  private rows: Delegation[] = []

  put(d: Delegation): void {
    check(d)
    if (this.rows.some((row) => row.id === d.id || row.ticket === d.ticket)) {
      throw new Error('a delegation id and ticket are stored once (09 §4.6)')
    }
    this.checkWorker(d)
    this.rows.push({ ...d })
  }

  byTicket(ticket: string): Delegation | null {
    const row = this.rows.find((r) => r.ticket === ticket)
    return row === undefined ? null : { ...row }
  }

  save(d: Delegation): void {
    const stored = this.rows.find((row) => row.id === d.id)
    if (stored === undefined) throw new Error('save names a delegation that is not stored')
    const next: Delegation = {
      ...d,
      parentDwarfId: stored.parentDwarfId,
      ticket: stored.ticket,
      createdAt: stored.createdAt
    }
    check(next)
    this.checkWorker(next)
    this.rows = this.rows.map((row) => (row === stored ? { ...next } : row))
  }

  /** Every row by id, for a test transaction to restore on rollback. */
  snapshot(): Delegation[] {
    return this.rows
      .map((row) => ({ ...row }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  restore(rows: Delegation[]): void {
    this.rows = rows.map((row) => ({ ...row }))
  }

  private checkWorker(d: Delegation): void {
    if (
      d.workerDwarfId !== undefined &&
      this.rows.some((row) => row.id !== d.id && row.workerDwarfId === d.workerDwarfId)
    ) {
      throw new Error('a worker serves one delegation (09 §4.6 UNIQUE worker_dwarf_id)')
    }
  }
}

/** The 09 §4.6 row CHECKs. */
function check(d: Delegation): void {
  const settled = d.state === 'succeeded' || d.state === 'failed'
  if ((d.state === 'failed') !== (d.failure !== undefined)) {
    throw new Error('failure is set exactly when the delegation failed (09 §4.6)')
  }
  if (settled !== (d.settledAt !== undefined)) {
    throw new Error('settledAt is set exactly when the delegation settled (09 §4.6)')
  }
  if (d.state === 'succeeded' && d.handoff?.phase !== 'delivered') {
    throw new Error('a succeeded delegation has its handoff delivered (09 §4.6, INV-68)')
  }
  if (settled && (d.task !== undefined || d.context !== undefined)) {
    throw new Error('a settled delegation keeps no task or context (09 §4.6)')
  }
  if (d.workerDwarfId !== undefined && d.workerDwarfId === d.parentDwarfId) {
    throw new Error('a worker is never its own parent (09 §4.6)')
  }
}
