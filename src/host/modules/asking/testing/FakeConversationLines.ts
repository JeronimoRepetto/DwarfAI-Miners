// The double of conversation's `ingest` and `JoinedEvents` (16 §4.6) as the asking open path uses
// them: the auto-denied system line joins asking's open transaction, and its `MessagesAppended` is
// held until asking publishes the joined events after the commit (16 §2.3). Asking reaches
// conversation only through its index (05 R4). Never imported by production code (R14).
//
// - `ingest` refuses to run outside the caller's transaction (it must join, never open its own);
// - a `sourceKey` already stored is claimed: no second row (ADR-006, conversation's MessageLog);
// - `snapshot` / `restore` let the test's transaction roll the rows back with the asks.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationCommands, JoinedEvents } from '../../conversation'
import type { ConversationEntry } from '../../suppliers'

export interface FakeLine {
  dwarfId: DwarfId
  entry: ConversationEntry
  origin: 'live-stream' | 'transcript'
}

export class FakeConversationLines implements Pick<ConversationCommands, 'ingest'>, JoinedEvents {
  /** The stored rows. */
  rows: FakeLine[] = []
  /** The `MessagesAppended` batches published after a commit, in order. */
  readonly appended: FakeLine[][] = []
  private held: FakeLine[][] = []

  constructor(private readonly scope: TransactionScope) {}

  ingest(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): void {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError('the asking open path writes its line inside its transaction')
    }
    const batch: FakeLine[] = []
    for (const entry of entries) {
      const claimed = this.rows.some(
        (row) => row.dwarfId === dwarfId && row.entry.sourceKey === entry.sourceKey
      )
      if (claimed) continue
      const line = { dwarfId, entry, origin }
      this.rows.push(line)
      batch.push(line)
    }
    if (batch.length > 0) this.held.push(batch)
  }

  publish(): void {
    if (this.scope.isInTransaction()) {
      throw new HostInvariantError('joined events are published after the commit (16 §2.3)')
    }
    this.appended.push(...this.held.splice(0))
  }

  discard(): void {
    this.held = []
  }

  snapshot(): FakeLine[] {
    return [...this.rows]
  }

  restore(rows: FakeLine[]): void {
    this.rows = rows
    this.held = []
  }
}
