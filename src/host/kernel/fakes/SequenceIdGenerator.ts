// The deterministic IdGenerator double (16 §3): the n-th id is a valid UUIDv7 shape whose last
// field is n, so ids are predictable in tests and sort by creation order.
import type { IdGenerator } from '../ports/idGenerator'

export class SequenceIdGenerator implements IdGenerator {
  private issued = 0

  uuidv7(): string {
    this.issued += 1
    return `00000000-0000-7000-8000-${this.issued.toString(16).padStart(12, '0')}`
  }
}
