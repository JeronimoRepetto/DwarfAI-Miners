// `SqliteEndedAgentLedger` (16 §4.3; 05 §3.3): the ended identities over `ended_agents` (09 §4.2),
// in bound SQL only. The one writer of that table.
//
// - The key is `(provider_id, provider_session_id, provider_agent_id)`, a session's own row with
//   the agent `''` (the column's default), so an ended subagent never ends its session or a
//   sibling (ADR-015 item 7).
// - `record` is an insert that ignores an existing key, inside the caller's transaction (16 §2.2);
//   outside one it throws `HostInvariantError`. The first record wins: `ended_at` is never moved.
// - Rows are kept by Reset metrics (09 §7.2); the 90-day prune belongs to the retention sweep
//   (09 §7.1).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Instant, ProviderIdentity } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { EndedAgentLedger } from '../ports/endedAgentLedger'

export interface SqliteEndedAgentLedgerDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
}

const HAS = `SELECT 1 AS found FROM ended_agents
  WHERE provider_id = ? AND provider_session_id = ? AND provider_agent_id = ?`

const INSERT = `INSERT INTO ended_agents (provider_id, provider_session_id, provider_agent_id, ended_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (provider_id, provider_session_id, provider_agent_id) DO NOTHING`

function keyOf(i: ProviderIdentity): [string, string, string] {
  return [i.providerId, i.providerSessionId, i.providerAgentId ?? '']
}

export class SqliteEndedAgentLedger implements EndedAgentLedger {
  constructor(private readonly deps: SqliteEndedAgentLedgerDeps) {}

  has(i: ProviderIdentity): boolean {
    return this.deps.db.all(HAS, keyOf(i)).length > 0
  }

  record(i: ProviderIdentity, at: Instant): 'new' | 'duplicate' {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        'EndedAgentLedger.record runs inside the caller transaction (16 §2.2)'
      )
    }
    const { changes } = this.deps.db.run(INSERT, [...keyOf(i), at])
    return changes > 0 ? 'new' : 'duplicate'
  }
}
