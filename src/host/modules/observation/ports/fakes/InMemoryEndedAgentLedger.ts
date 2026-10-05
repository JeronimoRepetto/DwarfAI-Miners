// The EndedAgentLedger double (16 §4.3 `InMemoryEndedAgentLedger`, §2.8). Never imported by
// production code (R14). It runs `runEndedAgentLedgerContract` like `SqliteEndedAgentLedger`; a
// test's transaction rolls it back through `snapshot` / `restore`. Type-only imports (05 R2).
import type { Instant, ProviderIdentity } from '../../../../kernel/domain/values'
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type { EndedAgentLedger } from '../endedAgentLedger'

/** The `ended_agents` primary key (09 §4.2): no agent is the empty string. */
function keyOf(i: ProviderIdentity): string {
  return JSON.stringify([i.providerId, i.providerSessionId, i.providerAgentId ?? ''])
}

export class InMemoryEndedAgentLedger implements EndedAgentLedger {
  private rows = new Map<string, Instant>()
  /** Every identity recorded by a committed transaction, in order, for tests. */
  readonly records: Array<{ identity: ProviderIdentity; at: Instant }> = []

  constructor(private readonly scope: TransactionScope) {}

  has(i: ProviderIdentity): boolean {
    return this.rows.has(keyOf(i))
  }

  record(i: ProviderIdentity, at: Instant): 'new' | 'duplicate' {
    if (!this.scope.isInTransaction()) {
      throw new Error('EndedAgentLedger.record runs inside the caller transaction (16 §2.2)')
    }
    const key = keyOf(i)
    if (this.rows.has(key)) return 'duplicate'
    this.rows.set(key, at)
    this.records.push({ identity: { ...i }, at })
    return 'new'
  }

  snapshot(): unknown {
    return { rows: new Map(this.rows), recorded: this.records.length }
  }

  restore(snapshot: unknown): void {
    const { rows, recorded } = snapshot as { rows: Map<string, Instant>; recorded: number }
    this.rows = new Map(rows)
    this.records.length = recorded
  }
}
