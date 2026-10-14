// The arrival and departure members of `CrewCommands` (05 §3.2; 16 §4.2): `arrive`, `rebind`,
// `sessionClosed` and `markUnrecovered`, and `recordActivity` (ISSUE-095, for the observed route
// `SessionActivityObserved`; ISSUE-120, its `'turn-finished'` for the `TurnEnded` route, owner
// amendment C), and `startAsking` / `stopAsking` (ISSUE-140, for the asking routes of
// host/wiring/routes/askingRoutes.ts). The others (`stop`, `rename`, the ends…) join with their
// issues (later: ISSUE-080, ISSUE-172, EPIC-10).
//
// The open ask is Host memory (09 §4.2 has no column for it; `DwarfRepository` drops
// `facts.openAsk`): `OpenAskMemory` keeps each dwarf's front ask beside the stored row, so every
// command and every read of the one decorated repository sees it (INV-24). The asking module's
// stored asks are the durable record; the wiring replays the open ones at boot.
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
import type { StatusFacts } from '../domain/status'
import { askClosed, askOpened, otherActivity, turnEnded, turnStarted } from '../domain/statusFacts'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { StatusTimer } from './statusTimer'

/** A turn's end as `TurnEnded` reports it (ADR-021): the provider's own instant and reliability. */
export interface TurnFinished {
  at: number
  reliability: 'reliable' | 'inferred'
}

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
  /**
   * 16 §4.2: moves the status facts (S1.03, S1.04, S1.06, S1.08); the status is derived (INV-23).
   * `end` is given iff `kind` is `'turn-finished'` (else `HostInvariantError`): the `TurnEnded`
   * route (host/wiring/routes/cut1Routes.ts, ISSUE-120) passes `TurnEnded.at` and `.reliability`,
   * which 09 `dwarfs` persists. A reliable and an inferred end move the status alike (OQ-36 A);
   * whether the end may be announced (`cancelledFromApp`) is the route's, not crew's.
   */
  // Amended: 05 §3.2 / 16 §4.2 recordActivity end (owner amendment C, 2026-10-06)
  recordActivity(
    dwarfId: DwarfId,
    kind: 'turn-started' | 'turn-finished' | 'message',
    end?: TurnFinished
  ): void
  /**
   * 16 §4.2: the broker opened a trusted ask for the dwarf (S1.10–S1.12): `asking` while any is
   * `open`/`answering` (INV-24). An `auto-denied` ask never reaches here (S1.16).
   */
  startAsking(dwarfId: DwarfId, kind: 'question' | 'permission'): void
  /** 16 §4.2: the dwarf's front ask closed (S1.13–S1.15); the status follows its turn again. */
  stopAsking(dwarfId: DwarfId): void
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

  recordActivity(
    dwarfId: DwarfId,
    kind: 'turn-started' | 'turn-finished' | 'message',
    end?: TurnFinished
  ): void {
    // Amended: 05 §3.2 / 16 §4.2 recordActivity end (owner amendment C, 2026-10-06)
    if ((kind === 'turn-finished') !== (end !== undefined)) {
      throw new HostInvariantError(
        `recordActivity '${kind}' takes an end iff it is 'turn-finished'`
      )
    }
    const { repository, transactions, clock } = this.deps
    const at = clock.now()
    const moved = transactions.inTransaction(() => {
      const dwarf = this.existing(dwarfId)
      if (isGone(dwarf)) return null
      const facts =
        end !== undefined
          ? // S1.03, S1.04: the end's own instant, the base of the 60 s asleep timer (INV-25).
            turnEnded(dwarf.facts, end)
          : kind === 'turn-started'
            ? turnStarted(dwarf.facts, at)
            : otherActivity(dwarf.facts, at)
      repository.save({ ...dwarf, facts })
      return facts
    })
    // 16 §4.2: the status is derived; the timer publishes only on a status change (S1.06, S1.08).
    if (moved !== null) this.deps.statusTimer.factsChanged(dwarfId, moved)
  }

  startAsking(dwarfId: DwarfId, kind: 'question' | 'permission'): void {
    // S1.10–S1.12: the broker reports only trusted, opened asks here (an auto-denied one never, S1.16);
    // while one is open the front ask stays (S1.15).
    this.moveFacts(dwarfId, (facts, at) => askOpened(facts, { kind, askedAt: at, state: 'open' }))
  }

  stopAsking(dwarfId: DwarfId): void {
    // S1.13, S1.14: the status follows the turn again; a dwarf with no open ask is unchanged.
    this.moveFacts(dwarfId, (facts) => (facts.openAsk === undefined ? facts : askClosed(facts)))
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

  /** One transaction moving a present dwarf's facts; the timer hears of a change after the commit. */
  private moveFacts(dwarfId: DwarfId, move: (facts: StatusFacts, at: number) => StatusFacts): void {
    const { repository, transactions, clock } = this.deps
    const at = clock.now()
    const moved = transactions.inTransaction(() => {
      const dwarf = this.existing(dwarfId)
      if (isGone(dwarf)) return null
      const facts = move(dwarf.facts, at)
      if (facts === dwarf.facts) return null
      repository.save({ ...dwarf, facts })
      return facts
    })
    if (moved !== null) this.deps.statusTimer.factsChanged(dwarfId, moved)
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

/**
 * The `DwarfRepository` crew's commands and read model share (16 §4.2): the stored rows, with each
 * dwarf's front ask kept in Host memory beside them (09 §4.2: no column), set and cleared by the
 * `facts.openAsk` of every saved dwarf and laid back on every read.
 */
export class OpenAskMemory implements DwarfRepository {
  private readonly openAsks = new Map<DwarfId, NonNullable<StatusFacts['openAsk']>>()

  constructor(private readonly stored: DwarfRepository) {}

  byId(id: DwarfId): Dwarf | null {
    return this.withOpenAsk(this.stored.byId(id))
  }

  byProviderIdentity(i: ProviderIdentity): Dwarf | null {
    return this.withOpenAsk(this.stored.byProviderIdentity(i))
  }

  inMine(id: MineId): Dwarf[] {
    return this.stored.inMine(id).map((d) => this.withOpenAsk(d) ?? d)
  }

  save(d: Dwarf): void {
    this.stored.save(d)
    if (d.facts.openAsk === undefined) this.openAsks.delete(d.id)
    else this.openAsks.set(d.id, { ...d.facts.openAsk })
  }

  private withOpenAsk(d: Dwarf | null): Dwarf | null {
    const openAsk = d === null ? undefined : this.openAsks.get(d.id)
    if (d === null || openAsk === undefined) return d
    return { ...d, facts: { ...d.facts, openAsk: { ...openAsk } } }
  }
}
