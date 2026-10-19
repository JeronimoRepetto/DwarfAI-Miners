// The CursorStore double (16 §4.3 `InMemoryCursorStore`, §2.8). Never imported by production code
// (R14). It runs `runCursorStoreContract` like `SqliteCursorStore`; a test's transaction rolls it
// back through `snapshot` / `restore`. Type-only imports (05 R2).
import type { TransactionScope } from '../../../../kernel/ports/transactionScope'
import type { CursorStore } from '../cursorStore'
import type { Cursor } from '../observationAdapter'

export class InMemoryCursorStore implements CursorStore {
  private rows = new Map<string, Cursor>()
  /** Every `advance` call, in order, for tests that check what a cycle wrote. */
  readonly advances: Array<{ source: string; cursor: Cursor }> = []

  constructor(private readonly scope: TransactionScope) {}

  get(source: string): Cursor | null {
    const row = this.rows.get(source)
    return row === undefined ? null : { ...row }
  }

  advance(source: string, c: Cursor): void {
    if (!this.scope.isInTransaction()) {
      throw new Error('CursorStore.advance runs inside the caller transaction (16 §2.2)')
    }
    this.advances.push({ source, cursor: { ...c } })
    const current = this.rows.get(source)
    // The `source_cursors_never_regress` trigger's rule (09 §4.2), restated: ports are type-only.
    if (current !== undefined && (c.kind !== current.kind || c.value < current.value)) {
      throw new Error('CURSOR_REGRESSION')
    }
    this.rows.set(source, { ...c })
  }

  snapshot(): unknown {
    return new Map(this.rows)
  }

  restore(snapshot: unknown): void {
    this.rows = new Map(snapshot as Map<string, Cursor>)
  }
}
