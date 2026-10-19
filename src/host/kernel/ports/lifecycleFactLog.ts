// Kernel driven port (05 §3, 16 §3 `LifecycleFactLog`): the durable dedupe of the dwarf lifecycle
// facts in `dwarf_lifecycle_facts` (09 §5.6; ADR-006 item 1). `record` runs inside the caller's
// transaction (16 §2.2), written together with the state change the fact proves; outside one it
// is a programming error (`HostInvariantError`). A repeat of a fact's natural key answers
// `'duplicate'`, writes no row, and the caller publishes nothing. Shared by crew and conversation.
import type { LifecycleFact } from '../domain/lifecycleFact'

export type {
  LifecycleDepartureCause,
  LifecycleFact,
  LifecycleFactType
} from '../domain/lifecycleFact'

export interface LifecycleFactLog {
  record(fact: LifecycleFact): 'new' | 'duplicate'
}
