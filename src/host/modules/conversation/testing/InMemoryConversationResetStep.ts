// The conversation Reset step over the in-memory doubles (16 §4.12 `ResetDbStep`, §2.8). Never
// imported by production code (R14). The same rules as `ConversationResetStep` (09 §7.2): every
// message goes with its delivery except one still `sending`, every key stays, every activity run
// and outcome line goes; it joins the caller's transaction and throws `HostInvariantError` outside
// one, writing nothing.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { InMemoryActivityLog } from './InMemoryActivityLog'
import type { InMemoryMessageLog } from './InMemoryMessageLog'

export interface InMemoryConversationResetStepDeps {
  scope: TransactionScope
  log: InMemoryMessageLog
  activity: InMemoryActivityLog
}

export class InMemoryConversationResetStep {
  readonly name = 'conversation'

  constructor(private readonly deps: InMemoryConversationResetStepDeps) {}

  reset(tx: TransactionRunner): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        "the conversation ResetDbStep runs inside the saga's db transaction (16 §2.2)"
      )
    }
    tx.inTransaction(() => {
      this.deps.log.resetKeepingSending()
      this.deps.activity.clearAll()
    })
  }
}
