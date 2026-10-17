// The LaunchStore double (16 §4.5 `InMemoryLaunchStore`; 16 §2.8). It runs `runLaunchStoreContract`
// like `SqliteLaunchStore` and keeps the same stored projection (`ports/launchStore.ts`): the prompt
// is not stored (09 D-16), `jevOn` reads back as `launchedWithLetJevChoose`, the tool-output tail is
// never stored (ADR-020 item 6). It keeps the failure's display fields as given; the SQLite adapter
// rebuilds them, so the contract checks only `cause` and `jevReason`. It lives in `testing/` because
// it throws the kernel's `HostInvariantError` and ports are type-only (R2); never imported by
// production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Instant, LaunchId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { Launch, LaunchState } from '../domain/launch'
import type { LaunchStore } from '../ports/launchStore'

interface LaunchRow {
  launch: Launch
  requestedAt: Instant
  settledAt: Instant | null
  seenAt: Instant | null
}

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

function stored(l: Launch): Launch {
  const { failure, request, ...rest } = l
  const out: Launch = {
    ...rest,
    request: { ...request, prompt: '', jevOn: l.launchedWithLetJevChoose }
  }
  if (failure === undefined) return out
  const { toolOutputTail, ...kept } = failure
  void toolOutputTail
  return { ...out, failure: kept }
}

export class InMemoryLaunchStore implements LaunchStore {
  private rows = new Map<LaunchId, LaunchRow>()

  constructor(
    private readonly scope: TransactionScope,
    private readonly clock: Clock
  ) {}

  put(l: Launch): void {
    this.requireTransaction('put')
    const pm = l.request.permissionMode
    if (pm !== undefined && typeof pm !== 'string') {
      throw new HostInvariantError('a launch request carries its permission mode as a mode id')
    }
    const before = this.rows.get(l.id)
    if (before !== undefined) refuseGoingBack(before.launch.state, l.state)
    const settled = RANK[l.state] === 3
    this.rows.set(l.id, {
      launch: stored(l),
      requestedAt: before?.requestedAt ?? this.clock.now(),
      settledAt: before?.settledAt ?? (settled ? this.clock.now() : null),
      seenAt: before?.seenAt ?? null
    })
  }

  byId(id: LaunchId): Launch | null {
    return this.rows.get(id)?.launch ?? null
  }

  inFlight(): Launch[] {
    return [...this.rows.values()]
      .filter((row) => RANK[row.launch.state] < 3)
      .map((row) => row.launch)
  }

  markSeen(id: LaunchId, at: Instant): void {
    this.requireTransaction('markSeen')
    const row = this.rows.get(id)
    if (row === undefined || row.launch.state !== 'failed') {
      throw new HostInvariantError('markSeen is for a failed launch only (14 §8 I-03)')
    }
    if (row.seenAt === null) row.seenAt = at
  }

  /** The stored `settled_at`. */
  settledAt(id: LaunchId): Instant | null {
    return this.rows.get(id)?.settledAt ?? null
  }

  /** The stored `seen_at`. */
  seenAt(id: LaunchId): Instant | null {
    return this.rows.get(id)?.seenAt ?? null
  }

  snapshot(): ReadonlyMap<LaunchId, LaunchRow> {
    return new Map([...this.rows].map(([id, row]) => [id, { ...row }]))
  }

  restore(rows: ReadonlyMap<LaunchId, LaunchRow>): void {
    this.rows = new Map(rows)
  }

  private requireTransaction(method: string): void {
    if (!this.scope.isInTransaction()) {
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
