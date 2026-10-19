// The production Clock (16 §3): the system wall clock in epoch ms. Ordering never relies on it
// being monotonic; it comes from commit order (08 §5.2).
import type { Instant } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'

export class SystemClock implements Clock {
  now(): Instant {
    return Date.now()
  }
}
