// The crew module's wiring (05 §3.2, §4; 16 §8.2, §8.3), in two parts, as routes/mines.ts:
//
// - `serveCrew`, run by the composition root before the boot binds the endpoint: the `dwarfs`
//   snapshot section (14 §4.1) and B-M41 `strangler.dwarfIdentities` (14 §2.3; AMENDMENT-8), so
//   every `hello.ok` lists them (14 §1.3). They forward to the one instance boot step 4 constructs;
//   until then the dispatcher answers HOST_NOT_READY before any handler runs (14 §3.3), and the
//   section is never read before `ready`. The `dwarf.*` board frames are the mines wiring's
//   (`publishBoardFrames`, frames/board.ts), over this instance's queries (`WiredCrew.mines`).
// - `wire`, run by boot step 4 before mines: `createCrew` over the Host database, the one kernel
//   `LifecycleFactLog` (16 §3, shared with conversation, 05 §4 item 1) and the kernel clock and
//   scheduler, the `SessionTerminator` bridge (bridges/sessionTerminator.ts, ADR-014) over the
//   kernel's process control and observation's process-identity read and `recordEnded`, and
//   crew's half of the mines wiring (`MinesCrewBinding`: `mineOf`, `ends`, `queries`).
// - `route`, run by boot step 4 once mines exists, the 05 §4 routes of this module and the boot
//   recompute of machine 1 (S1.18):
//   - `SessionObserved` (observation) → `mines.resolveForSession(cwd, firstMessage)` →
//     `crew.arrive` on `{ mineId }`, `working` with a first message, else `idle` (S1.01, S1.02),
//     with the parent's dwarf and the rank of its depth for a session that names a parent
//     (`rankForDepth`, INV-27); `{ waiting }` and `{ unenterable }` → nothing but the cursor
//     (06 INV-39; AMENDMENT-2, SC-AR-01).
//   - `SessionClosedObserved` (observation) → `crew.sessionClosed` with `departureCause` of the
//     dwarf's pending end, else `closed-elsewhere` (observed) / `crashed` (owned); `host-recovery`
//     departs nobody (08 §2.3; 06 §5.1).
//   - every present dwarf's status recomputed from its persisted facts, with its wake-up scheduled
//     again; no timer is persisted (ADR-032 item 3; S1.18).
//   A session's dwarf is read through observation's `ProviderIdentity → DwarfId` index
//   (`ObservedSessionStore.byIdentity`, 16 §4.3), which answers from the dwarf's own UNIQUE key.
//
// Not routed here, and why:
// - `SessionActivityObserved` → `crew.recordActivity` (08 §2.3): `CrewCommands` has no
//   `recordActivity` yet (crew/application/arrival.ts), and adding it is module code (ISSUE-094 is
//   binding only).
// - `SubagentObserved` (08 §0): observation publishes no such event yet; a subagent arrives through
//   `SessionObserved` with its `parentIdentity`, which this route ranks by depth.
// - `DwarfStopRequested` → launching `markStoppedByPerson` (required handler, 16 §2.3): launching is
//   not constructed by the Host yet (later: EPIC-10); without a handler every end runs.
// - The cut-1 cross-epic routes (`TurnEnded`, `ask.*`, `DwarfDeparted` clean-ups; later: ISSUE-120).
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../kernel/ports/lifecycleFactLog'
import type { ProcessControl } from '../../kernel/ports/processControl'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import {
  createCrew,
  departureCause,
  rankForDepth,
  type Crew,
  type CrewEndEvent,
  type CrewEvent,
  type CrewQueries,
  type DwarfRank,
  type SessionLinks,
  type SessionTerminator
} from '../../modules/crew'
import type { MinesCommands, MinesQueries } from '../../modules/mines'
import type {
  ObservationControl,
  ObservationEvent,
  ObservedProcessIdentities,
  ObservedSessionStore
} from '../../modules/observation'
import type { Dispatcher } from '../../transport/dispatcher'
import { registerStranglerDwarfIdentities } from '../../transport/methods/strangler'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { registerDwarfsSection } from '../../transport/snapshot/sections/dwarfs'
import { errorCode } from '../boot'
import { createSessionTerminator } from '../bridges/sessionTerminator'
import type { MinesCrewBinding } from './mines'

/** The events the crew wiring routes or publishes: one Host bus carries them all (16 §2.3). */
export type CrewRouteEvent = CrewEvent | CrewEndEvent | ObservationEvent

/** The Host bus as the crew wiring uses it: crew publishes; observation is read. */
export type CrewWiringBus = DomainEventBus<CrewEvent> &
  Pick<DomainEventBus<CrewEndEvent>, 'publish'> &
  Pick<DomainEventBus<ObservationEvent>, 'subscribe'>

/** Observation's half of the crew wiring, through observation's public door. */
export interface CrewObservationBinding {
  /** The process identity observation recorded for an observed dwarf (the terminator's read). */
  processIdentities: ObservedProcessIdentities
  /** The anti-ghost record of an ended identity (ADR-014 item 7). */
  control: Pick<ObservationControl, 'recordEnded'>
  /** The `ProviderIdentity → DwarfId` index (16 §4.3), for the routes' session → dwarf reads. */
  sessions: Pick<ObservedSessionStore, 'byIdentity'>
}

/**
 * Observation is not constructed by the Host yet (later: ISSUE-095): no session is observed, so no
 * dwarf has a recorded process identity and no end is recorded. Its index (`sessions`) is the
 * real store, which `host/main.ts` builds over the Host database.
 */
export const noObservationYet: Omit<CrewObservationBinding, 'sessions'> = {
  processIdentities: { processIdentityOf: () => null },
  control: { recordEnded: () => undefined }
}

export interface CrewServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M41 joins. */
  dispatcher: Dispatcher
  /** The snapshot sections, where the `dwarfs` section joins. */
  sections: SectionRegistry
}

export interface CrewWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The one `SqliteLifecycleFactLog`, shared with conversation (05 §4 item 1; 16 §3). */
  lifecycleFacts: LifecycleFactLog
  /** The Host's one event bus (16 §2.3). */
  bus: CrewWiringBus
  clock: Clock
  /** Machine 1's idle-to-asleep wake-ups (ADR-032 item 3). */
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Launching's ownership and the delivery routes (`CrewDeps.links`). */
  links: SessionLinks
  /** The kernel's identity-checked tree kill, for the terminator bridge (ADR-014; R17). */
  processes: Pick<ProcessControl, 'killTree'>
  observation: CrewObservationBinding
}

/** Mines' half of the crew routes, through mines' public door. */
export interface CrewMinesRoute {
  commands: Pick<MinesCommands, 'resolveForSession'>
  queries: Pick<MinesQueries, 'list'>
}

export interface WiredCrew {
  /** The one instance the served members forward to. */
  crew: Crew
  /** The `SessionTerminator` bridge crew's ends run on. */
  terminator: SessionTerminator
  /** Crew's half of the mines wiring (routes/mines.ts). */
  mines: MinesCrewBinding
  /** Boot step 4, once mines is wired: the 05 §4 routes and the status recompute (S1.18). */
  route(mines: CrewMinesRoute): void
  /** Resolves once every routed arrival has answered (tests; drain). */
  idle(): Promise<void>
}

export interface ServedCrew {
  /** Boot step 4: constructs the module the served members forward to. */
  wire(deps: CrewWiringDeps): WiredCrew
}

/** The members the served section and method forward to. */
type ServedMembers = {
  crew: Pick<CrewQueries, 'crewOf' | 'presentIdentities'>
  mines: Pick<MinesQueries, 'list'>
}

/** Serves the module's seam-B members before it exists; `wire` constructs it at boot step 4. */
export function serveCrew(serve: CrewServeDeps): ServedCrew {
  let served: ServedMembers | undefined
  const current = (): ServedMembers => {
    if (served === undefined) throw new HostInvariantError('crew is served from boot step 4 on')
    return served
  }
  registerDwarfsSection(serve.sections, {
    mines: { list: (query) => current().mines.list(query) },
    crew: { crewOf: (mineId, opts) => current().crew.crewOf(mineId, opts) }
  })
  registerStranglerDwarfIdentities(serve.dispatcher, {
    crew: { presentIdentities: () => current().crew.presentIdentities() }
  })
  let wired = false
  return {
    wire: (deps) => {
      if (wired) throw new HostInvariantError('crew is wired once')
      wired = true
      const result = wireCrew(deps)
      return {
        ...result,
        route: (mines) => {
          if (served !== undefined) throw new HostInvariantError('crew is routed once')
          result.route(mines)
          served = { crew: result.crew.queries, mines: mines.queries }
        }
      }
    }
  }
}

function wireCrew(deps: CrewWiringDeps): WiredCrew {
  const { bus, log, observation } = deps
  const crew = createCrew(deps)
  const terminator = createSessionTerminator({
    crew: crew.queries,
    observed: observation.processIdentities,
    processes: deps.processes,
    endedLedger: observation.control,
    clock: deps.clock
  })

  /** The dwarf bound to a provider identity, read through observation's index. */
  const dwarfOf = (identity: Parameters<ObservedSessionStore['byIdentity']>[0]): DwarfId | null =>
    observation.sessions.byIdentity(identity)?.dwarfId ?? null
  /** The parent's dwarf and the rank one level below it (INV-27); an unknown parent's depth is unknown. */
  const lineage = (
    parentIdentity: Parameters<ObservedSessionStore['byIdentity']>[0] | undefined
  ): { parent?: DwarfId; rank: DwarfRank } => {
    if (parentIdentity === undefined) return { rank: rankForDepth(0) }
    const parent = dwarfOf(parentIdentity)
    const parentRank = parent === null ? undefined : crew.queries.get(parent)?.rank
    if (parent === null || parentRank === undefined) return { rank: rankForDepth(null) }
    return { parent, rank: rankForDepth(DEPTH_OF[parentRank] + 1) }
  }
  const logFailure = (error: unknown): void =>
    log.record({ level: 'error', event: 'uncaught', subsystem: 'host', errCode: errorCode(error) })

  /** The arrivals the `SessionObserved` route started that have not answered yet. */
  const routed = new Set<Promise<unknown>>()

  return {
    crew,
    terminator,
    mines: {
      mineOf: (dwarfId) => crew.queries.get(dwarfId)?.mineId ?? null,
      ends: crew.ends({ terminator, bus }),
      queries: crew.queries
    },
    route: (mines) => {
      bus.subscribe('SessionObserved', ({ payload }) => {
        const firstMessage = payload.firstMessage ?? false
        const arrival = mines.commands
          .resolveForSession(payload.cwd, firstMessage)
          .then((resolved) => {
            if (!('mineId' in resolved)) return
            crew.commands.arrive({
              mineId: resolved.mineId,
              identity: payload.identity,
              ...lineage(payload.parentIdentity),
              status: firstMessage ? 'working' : 'idle'
            })
          })
          .catch(logFailure)
          .finally(() => routed.delete(arrival))
        routed.add(arrival)
      })
      bus.subscribe('SessionClosedObserved', ({ payload }) => {
        const dwarfId = dwarfOf(payload.identity)
        const dwarf = dwarfId === null ? null : crew.queries.get(dwarfId)
        if (dwarf === null || dwarf.departed) return
        const cause = departureCause(dwarf.pendingEnd, dwarf.owned)
        if (cause !== null) crew.commands.sessionClosed(dwarf.id, cause)
      })
      // S1.18: every present dwarf of every mine on the board, from its persisted facts.
      crew.statusTimer.recompute(
        mines.queries
          .list({ sortBy: 'name', direction: 'asc' })
          .flatMap((mine) => crew.queries.crewOf(mine.mineId))
          .map((dwarf) => ({ dwarfId: dwarf.id, facts: dwarf.facts }))
      )
    },
    idle: async () => {
      while (routed.size > 0) await Promise.all([...routed])
    }
  }
}

/** The depth each rank stands for (`rankForDepth`'s inverse; `worker2` is every deeper level). */
const DEPTH_OF: Readonly<Record<DwarfRank, number>> = { foreman: 0, worker: 1, worker2: 2 }
