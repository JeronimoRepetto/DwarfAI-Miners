// The arrival and departure members of `CrewCommands` (05 §3.2; 16 §4.2): `arrive`, `rebind`,
// `sessionClosed` and `markUnrecovered`. The others (`recordActivity`, `startAsking`, `stop`,
// `rename`, the ends…) join with their issues (later: ISSUE-079, ISSUE-080, ISSUE-172, EPIC-10).
//
// Each command runs in one synchronous transaction (16 §2.2): it reads the dwarf, writes the next
// aggregate through `DwarfRepository` and its lifecycle fact through the kernel
// `LifecycleFactLog`, and publishes only after the commit and only when the fact was new
// (16 §2.3; 09 §5.6). A dwarf that departed meanwhile is a race, a silent no-op (16 §2.1); a dwarf
// id that never existed is a programming error (`HostInvariantError`).
import { HostInvariantError } from '../../../kernel/domain/errors'
import { providerIdentityKey, sameProviderIdentity } from '../../../kernel/domain/providerIdentity'
import type {
  DwarfId,
  EventId,
  HostEpoch,
  MineId,
  ProviderIdentity
} from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../../kernel/ports/lifecycleFactLog'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { baseNameFor } from '../domain/baseName'
import { applyPresence, arriveDwarf, rebindDwarf, type Dwarf } from '../domain/dwarf'
import type { CrewEvent } from '../domain/events'
import { isGone, type DepartureCause } from '../domain/presence'
import type { DwarfRank } from '../domain/rank'
import { classifyDwarfStatus } from '../domain/status'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { StatusTimer } from './statusTimer'

/** Driving port (05 §3.2): the members of ISSUE-069; the others join with their issues. */
export interface CrewCommands {
  /** ADR-015: a new UUID, or the existing dwarf bound to that identity (INV-20, INV-21). */
  arrive(input: {
    mineId: MineId
    identity: ProviderIdentity
    parent?: DwarfId
    rank: DwarfRank
    status: 'working' | 'idle'
  }): DwarfId
  /** Host-driven resume only (INV-22). */
  rebind(dwarfId: DwarfId, next: ProviderIdentity): void
  /** The single departure path (06 §5.1); publishes `DwarfDeparted`. */
  sessionClosed(dwarfId: DwarfId, cause: DepartureCause): void
  /** Host recovery pass: `processState` `unrecovered`, the dwarf stays present (INV-26). */
  markUnrecovered(dwarfId: DwarfId): void
}

export interface CrewArrivalsDeps {
  repository: DwarfRepository
  /** The kernel log of `dwarf_lifecycle_facts`, written inside each command's transaction. */
  facts: LifecycleFactLog
  transactions: TransactionRunner
  bus: Pick<DomainEventBus<CrewEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
  /** Machine 1's clock (ISSUE-067): told of each arrival and departure after the commit. */
  statusTimer: StatusTimer
}

export class CrewArrivals implements CrewCommands {
  constructor(private readonly deps: CrewArrivalsDeps) {}

  arrive(input: Parameters<CrewCommands['arrive']>[0]): DwarfId {
    const { repository, facts, transactions, clock, ids } = this.deps
    const at = clock.now()
    const arrived = transactions.inTransaction((): Dwarf | DwarfId => {
      const bound = repository.byProviderIdentity(input.identity)
      if (bound !== null) return bound.id
      const dwarf = arriveDwarf({
        id: ids.uuidv7() as DwarfId,
        mineId: input.mineId,
        identity: input.identity,
        baseName: baseNameFor(input.identity),
        // INV-28: `arrive` carries no delegation flag (05 §3.2); the delegation worker's arrival
        // sets it with the delegation issues.
        delegated: false,
        parentDwarfId: input.parent ?? null,
        rank: input.rank,
        status: input.status,
        at
      })
      repository.save(dwarf)
      facts.record({
        type: 'DwarfArrived',
        dwarfId: dwarf.id,
        identityKey: providerIdentityKey(dwarf.identity),
        occurredAt: at
      })
      return dwarf
    })
    if (typeof arrived === 'string') return arrived
    this.publish('DwarfArrived', {
      dwarfId: arrived.id,
      mineId: arrived.mineId,
      identity: arrived.identity,
      rank: arrived.rank,
      parentDwarfId: arrived.parentDwarfId,
      delegated: arrived.delegated,
      status: classifyDwarfStatus(arrived.facts, at),
      baseName: arrived.baseName
    })
    this.deps.statusTimer.factsChanged(arrived.id, arrived.facts)
    return arrived.id
  }

  rebind(dwarfId: DwarfId, next: ProviderIdentity): void {
    const { repository, facts, transactions, clock } = this.deps
    const rebound = transactions.inTransaction(() => {
      const dwarf = this.existing(dwarfId)
      if (isGone(dwarf) || sameProviderIdentity(dwarf.identity, next)) return null
      const fact = facts.record({
        type: 'DwarfRebound',
        dwarfId,
        identityKey: providerIdentityKey(next),
        occurredAt: clock.now()
      })
      if (fact === 'duplicate') return null
      repository.save(rebindDwarf(dwarf, next))
      return { previous: dwarf.identity }
    })
    if (rebound !== null)
      this.publish('DwarfRebound', { dwarfId, previous: rebound.previous, next })
  }

  sessionClosed(dwarfId: DwarfId, cause: DepartureCause): void {
    const { repository, facts, transactions, clock } = this.deps
    const at = clock.now()
    const departed = transactions.inTransaction(() => {
      const next = applyPresence(this.existing(dwarfId), { type: 'session-closed', cause, at })
      if (!next.ok) return null
      const fact = facts.record({ type: 'DwarfDeparted', dwarfId, cause, occurredAt: at })
      if (fact === 'duplicate') return null
      repository.save(next.value)
      return next.value
    })
    if (departed === null) return
    this.publish('DwarfDeparted', { dwarfId, mineId: departed.mineId, cause })
    this.deps.statusTimer.departed(dwarfId)
  }

  markUnrecovered(dwarfId: DwarfId): void {
    const { repository, transactions } = this.deps
    const moved = transactions.inTransaction(() => {
      const dwarf = this.existing(dwarfId)
      const next = applyPresence(dwarf, { type: 'listed-unrecovered' })
      if (!next.ok) return null
      const presenceMoved = next.value.presence !== dwarf.presence
      if (!presenceMoved && next.value.processState === dwarf.processState) return null
      repository.save(next.value)
      return presenceMoved ? next.value : null
    })
    // 16 §4.2: no event while presence is unchanged; a resuming dwarf listed unrecovered is
    // `present` again, which the window must hear (07 S2.10).
    if (moved !== null) this.publish('DwarfPresenceChanged', { dwarfId, presence: moved.presence })
  }

  private existing(dwarfId: DwarfId): Dwarf {
    const dwarf = this.deps.repository.byId(dwarfId)
    if (dwarf === null) throw new HostInvariantError(`no dwarf ${dwarfId} was ever stored`)
    return dwarf
  }

  private publish<K extends CrewEvent['type']>(
    type: K,
    payload: Extract<CrewEvent, { type: K }>['payload']
  ): void {
    const { bus, ids, clock, hostEpoch } = this.deps
    bus.publish({
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<CrewEvent, { type: K }>)
  }
}
