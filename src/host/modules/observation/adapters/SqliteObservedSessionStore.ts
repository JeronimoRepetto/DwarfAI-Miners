// `SqliteObservedSessionStore` (16 §4.3; 05 §3.3): the observed-session index over
// `observed_sessions` and `observed_session_streams` (09 §4.2), in bound SQL only. The one writer
// of those two tables.
//
// - The index key is the dwarf's UNIQUE provider identity on `dwarfs` (ADR-015 item 7; 09 §4.2
//   has no identity column on `observed_sessions`): `byIdentity` reads it through that key, so it
//   answers the dwarf bound to an identity before observation saved its row (the port's rule). It
//   only reads `dwarfs` and `mines`; it never writes them (INV-37).
// - `save` is an upsert by `dwarf_id` that keeps the first sighting; `saveStream` inserts a link
//   once. Both run inside the caller's transaction (16 §2.2); outside one they throw
//   `HostInvariantError`. A stream's link needs its `source_cursors` row (foreign key), so the
//   loop links a stream after its cursor advanced in the same transaction.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type {
  ObservedSession,
  ObservedSessionStore,
  ObservedSessionStream
} from '../ports/observedSessionStore'

export interface SqliteObservedSessionStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const BY_IDENTITY = `SELECT d.id AS dwarf_id, d.arrived_at, d.departed_at, m.canonical_path,
    o.dwarf_id AS saved, o.cwd, o.first_seen_at, o.last_record_at, o.closed_at
  FROM dwarfs d
  JOIN mines m ON m.id = d.mine_id
  LEFT JOIN observed_sessions o ON o.dwarf_id = d.id
  WHERE d.provider_id = ? AND d.provider_session_id = ? AND d.provider_agent_id = ?`

const UPSERT = `INSERT INTO observed_sessions (dwarf_id, cwd, first_seen_at, last_record_at, closed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (dwarf_id) DO UPDATE SET
    cwd = excluded.cwd,
    last_record_at = max(observed_sessions.last_record_at, excluded.last_record_at),
    closed_at = excluded.closed_at`

export class SqliteObservedSessionStore implements ObservedSessionStore {
  constructor(private readonly deps: SqliteObservedSessionStoreDeps) {}

  byIdentity(i: ProviderIdentity): ObservedSession | null {
    const row = this.deps.db.all(BY_IDENTITY, [
      i.providerId,
      i.providerSessionId,
      i.providerAgentId ?? ''
    ])[0]
    if (row === undefined) return null
    const departedAt = instantOrNull(row['departed_at'])
    const identity: ProviderIdentity = {
      providerId: i.providerId,
      providerSessionId: i.providerSessionId,
      ...(i.providerAgentId === undefined ? {} : { providerAgentId: i.providerAgentId })
    }
    if (row['saved'] === null) {
      const arrivedAt = Number(row['arrived_at'])
      return {
        identity,
        dwarfId: row['dwarf_id'] as DwarfId,
        cwd: row['canonical_path'] as FolderPath,
        firstSeenAt: arrivedAt,
        lastRecordAt: arrivedAt,
        closedAt: departedAt
      }
    }
    return {
      identity,
      dwarfId: row['dwarf_id'] as DwarfId,
      cwd: row['cwd'] as FolderPath,
      firstSeenAt: Number(row['first_seen_at']),
      lastRecordAt: Number(row['last_record_at']),
      closedAt: instantOrNull(row['closed_at']) ?? departedAt
    }
  }

  save(s: ObservedSession): void {
    this.inside('save')
    this.deps.db.run(UPSERT, [s.dwarfId, s.cwd, s.firstSeenAt, s.lastRecordAt, s.closedAt])
  }

  streams(sessionId: string): ObservedSessionStream[] {
    return this.deps.db
      .all(
        'SELECT dwarf_id, stream_id FROM observed_session_streams WHERE dwarf_id = ? ORDER BY stream_id',
        [sessionId]
      )
      .map((row) => ({ dwarfId: row['dwarf_id'] as DwarfId, streamId: row['stream_id'] as string }))
  }

  saveStream(s: ObservedSessionStream): void {
    this.inside('saveStream')
    this.deps.db.run(
      'INSERT INTO observed_session_streams (dwarf_id, stream_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [s.dwarfId, s.streamId]
    )
  }

  private inside(member: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `ObservedSessionStore.${member} runs inside the caller transaction (16 §2.2)`
      )
    }
  }
}

function instantOrNull(value: unknown): Instant | null {
  return value === null || value === undefined ? null : Number(value)
}
