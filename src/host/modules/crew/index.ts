// The crew module (05 §3.2): a mine's dwarfs. Machine 1, the dwarf status (ADR-032): the
// four-value status derived from persisted facts, and the timer that moves an idle dwarf to asleep;
// machine 2, presence (07 §2): rank by depth, the pending end of each end, the one departure; and
// (ISSUE-069) the dwarfs stored in the Host database, one per provider identity, the arrival and
// departure commands with their lifecycle facts, and `CrewQueries`. Crew imports only suppliers
// (05 §1.3, R4); what it reads of launching and of the delivery routes comes in as `SessionLinks`.
import type { HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteDwarfRepository } from './adapters/SqliteDwarfRepository'
import { CrewArrivals, type CrewCommands } from './application/arrival'
import { CrewReadModel, type CrewQueries, type SessionLinks } from './application/crewQueries'
import { StatusTimer } from './application/statusTimer'
import type { CrewEvent } from './domain/events'

export type {
  CrewEvent,
  DwarfArrived,
  DwarfDeparted,
  DwarfPresenceChanged,
  DwarfRebound,
  DwarfStatusChanged
} from './domain/events'
export type { Dwarf, DwarfArrival, SessionProfile, UsagePath } from './domain/dwarf'
export type { DwarfView, StopUnavailableReason } from './domain/dwarfView'
export {
  departureCause,
  type DepartureCause,
  type DwarfPresence,
  type DwarfProcessState,
  type EndReason
} from './domain/presence'
export { rankForDepth, type DwarfRank } from './domain/rank'
export {
  ASLEEP_AFTER_MS,
  classifyDwarfStatus,
  type DwarfStatus,
  type StatusFacts
} from './domain/status'
export { StatusTimer, type StatusTimerDeps } from './application/statusTimer'
export type { CrewCommands, CrewQueries, SessionLinks }
// Strangler-only (05 §3.2; AMENDMENT-8): the B-M41 record, deleted with B-M41 at the end of cut 4.
export type { PresentIdentity } from './application/crewQueries'

export interface CrewDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** Its transaction runner (16 §2.2), which also reports whether a transaction is open. */
  transactions: TransactionRunner & TransactionScope
  /** The kernel log of `dwarf_lifecycle_facts`, shared with conversation (16 §3). */
  lifecycleFacts: LifecycleFactLog
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<CrewEvent>
  clock: Clock
  /** Machine 1's idle-to-asleep wake-ups (ADR-032 item 3). */
  scheduler: Scheduler
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /** Launching's ownership and the delivery routes, bound by `host/wiring`. */
  links: SessionLinks
}

export interface Crew {
  commands: CrewCommands
  queries: CrewQueries
  /** Machine 1's clock; boot recomputes the present dwarfs' statuses through it (S1.18). */
  statusTimer: StatusTimer
}

/** The module over the Host database. */
export function createCrew(deps: CrewDeps): Crew {
  const repository = new SqliteDwarfRepository({ db: deps.db, scope: deps.transactions })
  const statusTimer = new StatusTimer({
    clock: deps.clock,
    scheduler: deps.scheduler,
    bus: deps.bus,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const commands = new CrewArrivals({
    repository,
    facts: deps.lifecycleFacts,
    transactions: deps.transactions,
    bus: deps.bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    statusTimer
  })
  const queries = new CrewReadModel({
    repository,
    clock: deps.clock,
    links: deps.links,
    presentDwarfs: repository
  })
  return { commands, queries, statusTimer }
}
