// `SqliteDelegationTicketStore` (16 §4.8 row `DelegationTicketStore`; 05 §3.8; AR-19a applied):
// the 06 §11.1 `Delegation` aggregate in `delegations` (09 §4.6), looked up by its ticket.
//
// - `put` inserts a new delegation, `save` writes the next state of one that exists (its id,
//   parent, ticket and `created_at` never change), both inside the caller's transaction (16 §2.2).
//   The table's CHECKs are the rules: `succeeded` only with `handoff_phase = 'delivered'`
//   (INV-68), no task or context once settled, `failure` exactly when `failed`, `settled_at`
//   exactly when settled, the worker never the parent; its UNIQUEs refuse a second id, ticket or
//   worker. A refused statement aborts the caller's command (16 §2.1). A `save` that matches no
//   row is a programming error (`HostInvariantError`).
// - `byTicket` maps a row back field for field; a NULL column is an absent optional field.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { DwarfId } from '../../../../kernel/domain/values'
import type {
  SqliteDatabase,
  SqliteParam,
  SqliteRow
} from '../../../../kernel/ports/sqliteDatabase'
import type {
  Delegation,
  DelegationFailure,
  DelegationHandoff,
  DelegationId,
  DelegationState
} from '../../domain/delegation'
import type { SubtaskText } from '../../domain/subtaskText'
import type { DelegationTicketStore } from '../../ports/delegationStores'

const INSERT = `
  INSERT INTO delegations (worker_dwarf_id, task_text, context_text, state, failure, handoff_via,
    handoff_phase, handoff_phase_at, settled_at, id, parent_dwarf_id, ticket, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const UPDATE = `
  UPDATE delegations SET worker_dwarf_id = ?, task_text = ?, context_text = ?, state = ?,
    failure = ?, handoff_via = ?, handoff_phase = ?, handoff_phase_at = ?, settled_at = ?
  WHERE id = ?`

const BY_TICKET = `SELECT * FROM delegations WHERE ticket = ?`

export class SqliteDelegationTicketStore implements DelegationTicketStore {
  constructor(private readonly db: SqliteDatabase) {}

  put(d: Delegation): void {
    this.db.run(INSERT, [...stateParams(d), d.id, d.parentDwarfId, d.ticket, d.createdAt])
  }

  byTicket(ticket: string): Delegation | null {
    const row = this.db.all(BY_TICKET, [ticket])[0]
    return row === undefined ? null : toDelegation(row)
  }

  save(d: Delegation): void {
    const { changes } = this.db.run(UPDATE, [...stateParams(d), d.id])
    if (changes === 0) throw new HostInvariantError('save names a delegation that is not stored')
  }
}

/** The columns `save` may change, in the order of both statements. */
function stateParams(d: Delegation): SqliteParam[] {
  return [
    d.workerDwarfId ?? null,
    d.task ?? null,
    d.context ?? null,
    d.state,
    d.failure ?? null,
    d.handoff?.via ?? null,
    d.handoff?.phase ?? null,
    d.handoff?.phaseAt ?? null,
    d.settledAt ?? null
  ]
}

function toDelegation(row: SqliteRow): Delegation {
  const text = (column: string): SubtaskText | undefined => {
    const value = row[column]
    return typeof value === 'string' ? (value as SubtaskText) : undefined
  }
  const worker = row['worker_dwarf_id']
  const task = text('task_text')
  const context = text('context_text')
  const failure = row['failure']
  const settledAt = row['settled_at']
  const phase = row['handoff_phase']
  return {
    id: String(row['id']) as DelegationId,
    parentDwarfId: String(row['parent_dwarf_id']) as DwarfId,
    ...(typeof worker === 'string' ? { workerDwarfId: worker as DwarfId } : {}),
    ticket: String(row['ticket']),
    ...(task === undefined ? {} : { task }),
    ...(context === undefined ? {} : { context }),
    state: row['state'] as DelegationState,
    ...(typeof failure === 'string' ? { failure: failure as DelegationFailure } : {}),
    ...(typeof phase === 'string'
      ? {
          handoff: {
            via: row['handoff_via'] as DelegationHandoff['via'],
            phase: phase as DelegationHandoff['phase'],
            phaseAt: Number(row['handoff_phase_at'])
          }
        }
      : {}),
    createdAt: Number(row['created_at']),
    ...(settledAt === null || settledAt === undefined ? {} : { settledAt: Number(settledAt) })
  }
}
