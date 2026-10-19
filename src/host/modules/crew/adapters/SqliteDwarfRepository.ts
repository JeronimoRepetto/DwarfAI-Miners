// `SqliteDwarfRepository` (16 §4.2; 05 §3.2): the `Dwarf` aggregate over `dwarfs` (09 §4.2), in
// bound SQL only. The one writer of that table.
//
// - The provider identity `(provider_id, provider_session_id, provider_agent_id)` is UNIQUE
//   (INV-21; an absent agent id is stored as `''`, 06 §3). `save` of a dwarf whose identity is
//   bound to another one is a code defect: it throws `HostInvariantError` and writes nothing, and
//   the table's UNIQUE key stays the backstop.
// - `save` is an upsert by id inside the caller's transaction (16 §2.2); outside one it throws
//   `HostInvariantError`. A statement failure aborts the caller's command (16 §2.1).
// - Not stored (no column, 09 §4.2): `pendingEnd` and `facts.openAsk`, which are Host memory; a
//   dwarf read back carries `pendingEnd: null` and no `openAsk`. `facts.processState` is read from
//   `process_state` (`closed` or not) and a `none-yet` turn's instant is `arrived_at`.
// - `workplace_path` / `workplace_branch` belong to mines' stamp (ADR-030 D3): `save` never
//   writes them.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import type { SqliteDatabase, SqliteParam, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { Dwarf, SessionProfile, UsagePath } from '../domain/dwarf'
import type { DepartureCause, DwarfPresence, DwarfProcessState } from '../domain/presence'
import type { DwarfRank } from '../domain/rank'
import type { StatusFacts } from '../domain/status'
import type { DwarfRepository } from '../ports/dwarfRepository'

export interface SqliteDwarfRepositoryDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const COLUMNS = `id, mine_id, provider_id, provider_session_id, provider_agent_id,
  previous_provider_session_id, base_name, custom_name, rank, parent_dwarf_id, delegated,
  profile_model, profile_effort, profile_permission_mode, process_state, presence, turn_state,
  turn_ended_at, turn_end_reliability, arrived_at, last_activity_at, stop_in_flight, departed_at,
  departure_cause, usage_path`

const SELECT = `SELECT ${COLUMNS} FROM dwarfs`

const IDENTITY_WHERE = 'WHERE provider_id = ? AND provider_session_id = ? AND provider_agent_id = ?'

const UPSERT = `INSERT INTO dwarfs (${COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    provider_id = excluded.provider_id,
    provider_session_id = excluded.provider_session_id,
    provider_agent_id = excluded.provider_agent_id,
    previous_provider_session_id = excluded.previous_provider_session_id,
    custom_name = excluded.custom_name,
    profile_model = excluded.profile_model,
    profile_effort = excluded.profile_effort,
    profile_permission_mode = excluded.profile_permission_mode,
    process_state = excluded.process_state,
    presence = excluded.presence,
    turn_state = excluded.turn_state,
    turn_ended_at = excluded.turn_ended_at,
    turn_end_reliability = excluded.turn_end_reliability,
    last_activity_at = excluded.last_activity_at,
    stop_in_flight = excluded.stop_in_flight,
    departed_at = excluded.departed_at,
    departure_cause = excluded.departure_cause`

export class SqliteDwarfRepository implements DwarfRepository {
  constructor(private readonly deps: SqliteDwarfRepositoryDeps) {}

  byId(id: DwarfId): Dwarf | null {
    return this.one(`${SELECT} WHERE id = ?`, [id])
  }

  byProviderIdentity(i: ProviderIdentity): Dwarf | null {
    return this.one(`${SELECT} ${IDENTITY_WHERE}`, identityParams(i))
  }

  inMine(id: MineId): Dwarf[] {
    return this.deps.db
      .all(`${SELECT} WHERE mine_id = ? ORDER BY arrived_at, rowid`, [id])
      .map(fromRow)
  }

  save(d: Dwarf): void {
    const { db, scope } = this.deps
    if (!scope.isInTransaction()) {
      throw new HostInvariantError(
        'DwarfRepository.save runs inside the caller transaction (16 §2.2)'
      )
    }
    const holder = db.all(`SELECT id FROM dwarfs ${IDENTITY_WHERE}`, identityParams(d.identity))[0]
    if (holder !== undefined && holder['id'] !== d.id) {
      throw new HostInvariantError('another dwarf is bound to this provider identity (INV-21)')
    }
    db.run(UPSERT, toParams(d))
  }

  private one(sql: string, params: readonly SqliteParam[]): Dwarf | null {
    const row = this.deps.db.all(sql, params)[0]
    return row === undefined ? null : fromRow(row)
  }
}

function identityParams(i: ProviderIdentity): SqliteParam[] {
  return [i.providerId, i.providerSessionId, i.providerAgentId ?? '']
}

function toParams(d: Dwarf): SqliteParam[] {
  const turn = d.facts.turn
  return [
    d.id,
    d.mineId,
    ...identityParams(d.identity),
    d.previousProviderSessionId,
    d.baseName,
    d.customName,
    d.rank,
    d.parentDwarfId,
    d.delegated ? 1 : 0,
    d.sessionProfile.model ?? null,
    d.sessionProfile.effort ?? null,
    d.sessionProfile.permissionMode ?? null,
    d.processState,
    d.presence,
    turn.state,
    turn.state === 'ended' ? turn.endedAt : null,
    turn.state === 'ended' ? turn.reliability : null,
    d.arrivedAt,
    d.facts.lastActivityAt,
    d.stopInFlight ? 1 : 0,
    d.departedAt,
    d.departureCause,
    d.usagePath
  ]
}

function fromRow(row: SqliteRow): Dwarf {
  const providerId = String(row['provider_id'])
  const agentId = String(row['provider_agent_id'])
  const identity: ProviderIdentity = {
    providerId,
    providerSessionId: String(row['provider_session_id']),
    ...(agentId === '' ? {} : { providerAgentId: agentId })
  }
  const processState = row['process_state'] as DwarfProcessState
  const arrivedAt = Number(row['arrived_at'])
  return {
    id: String(row['id']) as DwarfId,
    mineId: String(row['mine_id']) as MineId,
    identity,
    previousProviderSessionId: textOrNull(row['previous_provider_session_id']),
    baseName: String(row['base_name']),
    customName: textOrNull(row['custom_name']),
    rank: row['rank'] as DwarfRank,
    parentDwarfId: textOrNull(row['parent_dwarf_id']) as DwarfId | null,
    delegated: row['delegated'] === 1,
    sessionProfile: profileOf(providerId, row),
    stopInFlight: row['stop_in_flight'] === 1,
    usagePath: row['usage_path'] as UsagePath,
    presence: row['presence'] as DwarfPresence,
    processState,
    departedAt: numberOrNull(row['departed_at']),
    departureCause: textOrNull(row['departure_cause']) as DepartureCause | null,
    facts: {
      processState: processState === 'closed' ? 'closed' : 'running',
      turn: turnOf(row, arrivedAt),
      lastActivityAt: Number(row['last_activity_at'])
    },
    arrivedAt,
    pendingEnd: null
  }
}

function turnOf(row: SqliteRow, arrivedAt: number): StatusFacts['turn'] {
  switch (row['turn_state']) {
    case 'active':
      return { state: 'active' }
    case 'ended':
      return {
        state: 'ended',
        endedAt: Number(row['turn_ended_at']),
        reliability: row['turn_end_reliability'] as 'reliable' | 'inferred'
      }
    default:
      return { state: 'none-yet', arrivedAt }
  }
}

function profileOf(providerId: string, row: SqliteRow): SessionProfile {
  const model = textOrNull(row['profile_model'])
  const effort = textOrNull(row['profile_effort'])
  const permissionMode = textOrNull(row['profile_permission_mode'])
  return {
    providerId,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    ...(permissionMode === null ? {} : { permissionMode })
  }
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}
