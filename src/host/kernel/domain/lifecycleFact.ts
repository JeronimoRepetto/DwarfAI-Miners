// The dwarf lifecycle facts that must happen at most once (09 §5.6; ADR-006 item 1; 16 §3
// `LifecycleFactLog`), and the natural key that makes a repeat a duplicate. Pure: no I/O, no
// clock read (05 §2.2, R1).
//
// Keys (09 §5.6, 08 §2 "Idempotency key"):
// - `DwarfArrived` is keyed by the provider identity, `DwarfRebound` by `(dwarfId, next identity)`.
//   The caller (crew, which owns `ProviderIdentity`) passes the identity as one opaque
//   `identityKey`; the key is namespaced by type so an identity never collides with another
//   type's key in the table-wide UNIQUE `source_key`.
// - `SubagentObserved`, `SessionClosedObserved` and `DriverSessionExited` carry their provider
//   `source_key` (`<adapterId>:<streamId>:<eventId>`, ADR-006 item 2), stored as given.
// - `TurnEnded` is keyed `turn:<dwarfId>:<turnKey>` whatever path reported it (ADR-021 item 3):
//   its provider `sourceKey`, when known, is NOT the key, because the driver and the transcript
//   path report the same end under different provider keys.
// - `DwarfDeparted` is unique per dwarf (`dwarf_lifecycle_facts_one_departure`); its optional
//   `sourceKey` is stored but is not what dedupes it.
import type { Instant } from './values'

/** The `09` §4.2 `type` column: a closed subset of the `08` §0 event names (09 §13 O-04). */
export type LifecycleFactType =
  | 'DwarfArrived'
  | 'DwarfRebound'
  | 'SubagentObserved'
  | 'SessionClosedObserved'
  | 'DriverSessionExited'
  | 'TurnEnded'
  | 'DwarfDeparted'

/** The `09` §4.2 `cause` column of a `DwarfDeparted` fact (06 §5.1 departure causes). */
export type LifecycleDepartureCause =
  | 'stopped'
  | 'mine-removed'
  | 'closed-elsewhere'
  | 'crashed'
  | 'recovery-dismissed'
  | 'recovery-failed'

interface LifecycleFactBase {
  /** The DwarfAI dwarf id (UUID, ADR-015); the dwarf row must exist. */
  dwarfId: string
  /** When the transition happened (provider time or the Host clock), epoch ms. */
  occurredAt: Instant
}

export type LifecycleFact =
  | (LifecycleFactBase & { type: 'DwarfArrived'; identityKey: string })
  | (LifecycleFactBase & { type: 'DwarfRebound'; identityKey: string })
  | (LifecycleFactBase & { type: 'SubagentObserved' | 'SessionClosedObserved'; sourceKey: string })
  | (LifecycleFactBase & {
      type: 'DriverSessionExited'
      sourceKey: string
      exitCode: number | null
    })
  | (LifecycleFactBase & { type: 'TurnEnded'; turnKey: string; sourceKey?: string })
  | (LifecycleFactBase & {
      type: 'DwarfDeparted'
      cause: LifecycleDepartureCause
      sourceKey?: string
    })

/** The `source_key` a fact is stored and deduped under; null only for a keyless departure. */
export function lifecycleFactKey(fact: LifecycleFact): string | null {
  switch (fact.type) {
    case 'DwarfArrived':
      return `arrived:${fact.identityKey}`
    case 'DwarfRebound':
      return `rebound:${fact.dwarfId}:${fact.identityKey}`
    case 'TurnEnded':
      return `turn:${fact.dwarfId}:${fact.turnKey}`
    case 'DwarfDeparted':
      return fact.sourceKey ?? null
    default:
      return fact.sourceKey
  }
}
