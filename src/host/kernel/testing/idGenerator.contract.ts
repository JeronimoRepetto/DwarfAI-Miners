// The IdGenerator conformance suite (16 §2.8, §3 row `IdGenerator`; 17 §1.3): run against SequenceIdGenerator and
// UuidV7Generator. `uuidv7()` gives every surrogate id and EventId (09 §2, 08 §1.2): a 36-character UUID of version 7
// (16 §3 "format test"), never the same id twice from one generator, since each one keys a row or an event. Sort
// order is not a port promise (each adapter's own test states its order).
import { describe, expect, it } from 'vitest'
import type { IdGenerator } from '../ports/idGenerator'

/** RFC 9562: version 7 in the 13th hex digit, variant 10 in the 17th. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** More ids than the UUIDv7 12-bit counter holds in one millisecond. */
const MANY = 5_000

export function runIdGeneratorContract(makeSubject: () => IdGenerator): void {
  describe('IdGenerator contract', () => {
    it('[ADR-005] every id is a 36-character UUID of version 7 and variant 10', () => {
      const ids = makeSubject()

      for (let i = 0; i < 100; i += 1) {
        const id = ids.uuidv7()
        expect(id).toHaveLength(36)
        expect(id).toMatch(UUID_V7)
      }
    })

    it('[ADR-005] one generator never gives the same id twice', () => {
      const ids = makeSubject()

      const issued = Array.from({ length: MANY }, () => ids.uuidv7())

      expect(new Set(issued).size).toBe(MANY)
    })
  })
}
