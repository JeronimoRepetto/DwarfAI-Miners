// `SqliteLaunchStore` (16 §4.5; 05 §3.5): the `launches` table (09 §4.3), one row per `Launch`
// (06 §8.1), in bound SQL through the kernel `SqliteDatabase` port (R11). Every write joins the
// caller's transaction (16 §2.2): outside one it throws `HostInvariantError` and writes nothing.
//
// - The first `put` of a launch inserts its row: the request's facts, `cwd` (the mine's folder,
//   from `folderOf`), `delegated` (set once, 09 D-17) and `requested_at` from the kernel `Clock`.
//   A later `put` of the same id moves the launch forward: state, cause, Jev reason, dwarf,
//   `spawned_at`, and `settled_at` stamped the first time the launch is terminal. The request is
//   immutable once sent (06 §8.1) and is never rewritten.
// - A launch never goes back and a settled one never changes state (07 machine 5B): such a put is a
//   code defect (`HostInvariantError`).
// - `markSeen` sets `seen_at` once (`WHERE seen_at IS NULL`, 14 §8 I-03) and only on a failed
//   launch (09 §4.3 CHECK).
// - A launch reads back as the port's stored projection (`ports/launchStore.ts`): no prompt
//   (09 D-16), `jevOn` = `launched_with_let_jev_choose`, the delegation's parent through
//   `delegations` (09 D-17), and the failure rebuilt by the domain from its cause and Jev reason
//   with the generic supplier label (no column holds the chip label; package gap).
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type {
  JevFallbackReason,
  LaunchFailureCause
} from '../../../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId,
  MineId,
  ProviderId
} from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type {
  CustomCommand,
  Launch,
  LaunchRequest,
  LaunchState,
  LaunchWay
} from '../../domain/launch'
import { buildLaunchFailure } from '../../domain/launchFailure'
import { CUSTOM_COMMAND_LABEL, NO_SUPPLIER_LABEL } from '../../domain/supplierLabel'
import type { LaunchStore } from '../../ports/launchStore'

export interface SqliteLaunchStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `requested_at` and `settled_at`. */
  clock: Clock
  /** The mine's folder, the session's `cwd` (10 §`launches`); null for an unknown mine. */
  folderOf(mineId: MineId): FolderPath | null
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** What a stored request reads back as (`ports/launchStore.ts`; 09 D-17). */
type StoredRequest = LaunchRequest<string, { delegationId: string; parentDwarfId: DwarfId }>

/** 07 machine 5B order: a launch never goes back, and a settled one never changes state. */
const RANK: Record<LaunchState, number> = {
  routing: 0,
  resolving: 1,
  spawned: 2,
  succeeded: 3,
  failed: 3,
  'handed-back': 3,
  lost: 3
}

const INSERT = `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, custom_command_json,
    model, effort, permission_mode, launched_with_let_jev_choose, jev_auto_accept, state,
    failure_cause, jev_reason, dwarf_id, retry_of, delegation_id, delegated, host_epoch,
    requested_at, spawned_at, settled_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const STATE_OF = 'SELECT state FROM launches WHERE id = ?'

const ADVANCE = `UPDATE launches SET state = ?, failure_cause = ?, jev_reason = ?, dwarf_id = ?,
    spawned_at = ?, settled_at = coalesce(settled_at, ?)
  WHERE id = ?`

const MARK_SEEN = `UPDATE launches SET seen_at = coalesce(seen_at, ?)
  WHERE id = ? AND state = 'failed'`

const SELECT = `SELECT l.*, d.parent_dwarf_id
  FROM launches l LEFT JOIN delegations d ON d.id = l.delegation_id`

const BY_ID = `${SELECT} WHERE l.id = ?`

const IN_FLIGHT = `${SELECT} WHERE l.state IN ('routing', 'resolving', 'spawned')
  ORDER BY l.requested_at, l.id`

export class SqliteLaunchStore implements LaunchStore {
  constructor(private readonly deps: SqliteLaunchStoreDeps) {}

  put(l: Launch): void {
    this.requireTransaction('put')
    const settledAt = RANK[l.state] === 3 ? this.deps.clock.now() : null
    const [stored] = this.deps.db.all(STATE_OF, [l.id])
    if (stored === undefined) {
      this.insert(l, settledAt)
      return
    }
    refuseGoingBack(stored['state'] as LaunchState, l.state)
    this.deps.db.run(ADVANCE, [
      l.state,
      l.failure?.cause ?? null,
      l.failure?.jevReason ?? null,
      l.dwarfId ?? null,
      l.spawnedAt ?? null,
      settledAt,
      l.id
    ])
  }

  byId(id: LaunchId): Launch | null {
    const [row] = this.deps.db.all(BY_ID, [id])
    return row === undefined ? null : toLaunch(row)
  }

  inFlight(): Launch[] {
    return this.deps.db.all(IN_FLIGHT).map(toLaunch)
  }

  markSeen(id: LaunchId, at: Instant): void {
    this.requireTransaction('markSeen')
    if (this.deps.db.run(MARK_SEEN, [at, id]).changes === 0) {
      throw new HostInvariantError('markSeen is for a failed launch only (14 §8 I-03)')
    }
  }

  private insert(l: Launch, settledAt: Instant | null): void {
    const { request } = l
    const cwd = this.deps.folderOf(request.mineId)
    if (cwd === null) {
      throw new HostInvariantError('a launch is stored for a mine that exists (INV-50)')
    }
    const { way } = request
    this.deps.db.run(INSERT, [
      l.id,
      request.mineId,
      cwd,
      way.kind,
      way.kind === 'supplier' ? way.providerId : null,
      way.kind === 'custom'
        ? JSON.stringify({ raw: way.command.raw, argv: way.command.argv })
        : null,
      request.model ?? null,
      request.effort ?? null,
      permissionModeOf(request),
      l.launchedWithLetJevChoose ? 1 : 0,
      request.jevAutoAccept ? 1 : 0,
      l.state,
      l.failure?.cause ?? null,
      l.failure?.jevReason ?? null,
      l.dwarfId ?? null,
      l.retryOf ?? null,
      delegationIdOf(request),
      request.delegation === undefined ? 0 : 1,
      l.hostEpoch,
      this.deps.clock.now(),
      l.spawnedAt ?? null,
      settledAt
    ])
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `LaunchStore.${method} runs inside the caller's transaction (16 §2.2)`
      )
    }
  }
}

function refuseGoingBack(from: LaunchState, to: LaunchState): void {
  const settled = RANK[from] === 3
  if ((settled && to !== from) || RANK[to] < RANK[from]) {
    throw new HostInvariantError(`a launch moves forward only (07 5B): ${from} → ${to}`)
  }
}

/** 06 §5.1: a permission mode is the mode id string from the supplier's own list. */
function permissionModeOf(request: LaunchRequest): string | null {
  const mode = request.permissionMode
  if (mode === undefined) return null
  if (typeof mode !== 'string') {
    throw new HostInvariantError('a launch request carries its permission mode as a mode id')
  }
  return mode
}

/** 09 D-17: a delegated worker's request carries `{ delegationId, parentDwarfId }`. */
function delegationIdOf(request: LaunchRequest): string | null {
  const delegation: unknown = request.delegation
  if (delegation === undefined) return null
  const id =
    typeof delegation === 'object' && delegation !== null && 'delegationId' in delegation
      ? delegation.delegationId
      : undefined
  if (typeof id !== 'string') {
    throw new HostInvariantError('a delegated launch request names its delegation (09 D-17)')
  }
  return id
}

function wayOf(row: SqliteRow): LaunchWay {
  switch (row['way_kind']) {
    case 'supplier':
      return { kind: 'supplier', providerId: String(row['provider_id']) as ProviderId }
    case 'custom':
      return {
        kind: 'custom',
        command: JSON.parse(String(row['custom_command_json'])) as CustomCommand
      }
    default:
      return { kind: 'jev' }
  }
}

function toLaunch(row: SqliteRow): Launch {
  const way = wayOf(row)
  const letJevChoose = row['launched_with_let_jev_choose'] === 1
  const request: Mutable<StoredRequest> = {
    // `mine_id` is NULL only once Reset removed the mine (10 §`launches`); the id is then unknown.
    mineId: (row['mine_id'] === null ? '' : String(row['mine_id'])) as MineId,
    way,
    prompt: '',
    jevOn: letJevChoose,
    jevAutoAccept: row['jev_auto_accept'] === 1
  }
  if (row['model'] !== null) request.model = String(row['model'])
  if (row['effort'] !== null) request.effort = String(row['effort'])
  if (row['permission_mode'] !== null) request.permissionMode = String(row['permission_mode'])
  if (row['delegation_id'] !== null && row['parent_dwarf_id'] !== null) {
    request.delegation = {
      delegationId: String(row['delegation_id']),
      parentDwarfId: String(row['parent_dwarf_id']) as DwarfId
    }
  }
  const launch: Mutable<Launch> = {
    id: String(row['id']) as LaunchId,
    request,
    state: row['state'] as LaunchState,
    hostEpoch: String(row['host_epoch']) as HostEpoch,
    launchedWithLetJevChoose: letJevChoose
  }
  if (row['failure_cause'] !== null) {
    launch.failure = buildLaunchFailure({
      cause: row['failure_cause'] as LaunchFailureCause,
      supplierLabel: way.kind === 'custom' ? CUSTOM_COMMAND_LABEL : NO_SUPPLIER_LABEL,
      ...(row['jev_reason'] !== null ? { jevReason: row['jev_reason'] as JevFallbackReason } : {})
    })
  }
  if (row['spawned_at'] !== null) launch.spawnedAt = Number(row['spawned_at'])
  if (row['dwarf_id'] !== null) launch.dwarfId = String(row['dwarf_id']) as DwarfId
  if (row['retry_of'] !== null) launch.retryOf = String(row['retry_of']) as LaunchId
  return launch
}
