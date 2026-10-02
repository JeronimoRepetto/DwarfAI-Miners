// The crew module's domain events (08 §0), over the kernel envelope (08 §1.2). Each is published
// after the transaction that proves it committed (16 §2.3), and the lifecycle ones only when their
// fact was new (09 §5.6).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, Instant, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import type { DepartureCause, DwarfPresence } from './presence'
import type { DwarfRank } from './rank'
import type { DwarfStatus } from './status'

/** Published only on a change of the derived status (08 §0; ADR-032 item 3). `askedAt` when it becomes `asking`. */
export type DwarfStatusChanged = DomainEvent<
  'DwarfStatusChanged',
  { dwarfId: DwarfId; from: DwarfStatus; to: DwarfStatus; askedAt?: Instant }
>

/** A dwarf exists (08 §0); once per provider identity (09 §5.6). */
export type DwarfArrived = DomainEvent<
  'DwarfArrived',
  {
    dwarfId: DwarfId
    mineId: MineId
    identity: ProviderIdentity
    rank: DwarfRank
    parentDwarfId: DwarfId | null
    delegated: boolean
    status: DwarfStatus
    baseName: string
  }
>

/** A Host-driven resume bound the dwarf to a new provider identity (08 §0; INV-22). */
export type DwarfRebound = DomainEvent<
  'DwarfRebound',
  { dwarfId: DwarfId; previous: ProviderIdentity; next: ProviderIdentity }
>

/** The presence changed without a departure (08 §0; 07 §2). */
export type DwarfPresenceChanged = DomainEvent<
  'DwarfPresenceChanged',
  { dwarfId: DwarfId; presence: DwarfPresence }
>

/** The dwarf left its mine; terminal, once per dwarf (08 §0; 09 §5.6). */
export type DwarfDeparted = DomainEvent<
  'DwarfDeparted',
  { dwarfId: DwarfId; mineId: MineId; cause: DepartureCause }
>

/** Every event crew publishes so far. */
export type CrewEvent =
  DwarfStatusChanged | DwarfArrived | DwarfRebound | DwarfPresenceChanged | DwarfDeparted
