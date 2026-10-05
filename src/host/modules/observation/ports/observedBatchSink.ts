// Driven port of observation (05 §3.3, 16 §4.3 `ObservedBatchSink`, AMENDMENT-10, OQ-78): the
// `host/wiring` bridge to `conversation.ingest` and `ledger.creditUsage`, which join the caller's
// transaction. Type-only (05 §2.2).
import type { DwarfId } from '../../../kernel/domain/values'
import type { ConversationEntry, UsageObservation } from '../../suppliers'

export interface ObservedBatchSink {
  // bridge (host/wiring) → conversation.ingest and ledger.creditUsage, which join the caller's transaction (16 §2.2) (AMENDMENT-10, OQ-78)
  apply(batch: { dwarfId: DwarfId; entries: ConversationEntry[]; usage: UsageObservation[] }): void // called inside the batch transaction, before CursorStore.advance; publishes nothing; every event of the batch is published after that commit
}
