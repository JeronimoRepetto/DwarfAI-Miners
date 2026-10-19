// The CursorStore conformance suite (16 §4.3 `runCursorStoreContract`; 17 §1.3): run on
// `InMemoryCursorStore` and on `SqliteCursorStore`. A cursor only moves forward (INV-35;
// ADR-006 item 3): a lower value or another kind throws and the batch transaction rolls back
// whole, the same value again changes nothing, and `advance` runs only inside the caller's
// transaction.
import { describe, expect, it } from 'vitest'
import type { CursorStore } from '../ports/cursorStore'
import type { Cursor } from '../ports/observationAdapter'

export interface CursorStoreSubject {
  store: CursorStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
}

const at = (value: number, extra: Partial<Cursor> = {}): Cursor => ({
  adapterId: 'simulated',
  kind: 'byte-offset',
  value,
  fileIdentity: 'file-1',
  ...extra
})

export function runCursorStoreContract(makeSubject: () => CursorStoreSubject): void {
  describe('CursorStore contract', () => {
    it('[INV-35, ADR-006] a cursor never moves back and a lower value aborts the batch', () => {
      const { store, inTransaction } = makeSubject()
      inTransaction(() => store.advance('stream-a', at(100)))

      expect(() =>
        inTransaction(() => {
          store.advance('stream-b', at(5))
          store.advance('stream-a', at(50))
        })
      ).toThrow(/CURSOR_REGRESSION/)

      // The whole batch rolled back: the other stream's advance of the same batch is gone too.
      expect(store.get('stream-a')).toEqual(at(100))
      expect(store.get('stream-b')).toBeNull()
    })

    it('[INV-35] a cursor moves forward, and the same position again changes nothing', () => {
      const { store, inTransaction } = makeSubject()
      expect(store.get('stream-a')).toBeNull()
      inTransaction(() => store.advance('stream-a', at(10)))
      inTransaction(() => store.advance('stream-a', at(40)))
      inTransaction(() => store.advance('stream-a', at(40)))
      expect(store.get('stream-a')).toEqual(at(40))
    })

    it('[INV-35] another cursor kind for the same stream aborts the batch', () => {
      const { store, inTransaction } = makeSubject()
      inTransaction(() => store.advance('stream-a', at(10)))
      expect(() =>
        inTransaction(() => store.advance('stream-a', at(20, { kind: 'watermark' })))
      ).toThrow(/CURSOR_REGRESSION/)
      expect(store.get('stream-a')).toEqual(at(10))
    })

    it('[INV-35] advance outside the caller transaction is refused and stores nothing', () => {
      const { store } = makeSubject()
      expect(() => store.advance('stream-a', at(10))).toThrow(/inside the caller transaction/)
      expect(store.get('stream-a')).toBeNull()
    })
  })
}
