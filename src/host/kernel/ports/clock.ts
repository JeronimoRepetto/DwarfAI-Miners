// Kernel driven port (05 §3, 16 §3): the only time source of every Host module.
import type { Instant } from '../domain/values'

export interface Clock {
  now(): Instant
}
