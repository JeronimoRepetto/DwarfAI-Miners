// The Host's launched sessions (16 §8.2 step 4, §8.3; 05 §4; ISSUE-182): what the composition root
// binds once launching exists, for the modules wired before it. Crew, asking and the suppliers'
// drivers are constructed first (launching arrives through crew and over suppliers), so each gets a
// door here that answers "none" until `bind` runs, and the real answer after:
//
// - `links(observedRoutes)`: crew's `SessionLinks` (INV-30, INV-33). A dwarf is owned when launching
//   holds a live `LaunchRecord` for it; an owned dwarf has a delivery route while suppliers holds its
//   live driver session (`ownedSessionsOver`), an observed one while the observed-session relay can
//   reach it (ISSUE-167). Crew's `canReceiveMessages` follows (`processState === 'running'`).
// - `answers`: the `driver` answer channel (bridges/driverAskChannel.ts) over the same lookup.
// - `resumeContext`: what each CLI driver's resume reads of the stored launch record when this
//   Host did not launch the session (bridges/resumeContext.ts, ISSUE-173; forward note of #1375).
// - `bind`: the owned-session lookup over launching and suppliers, the resume lookup, and the routes
//   of every driver event (routes/driverEvents.ts) into suppliers' sink, with the exit route of
//   routes/launching.ts. It returns the lookup crew's terminator binds (ISSUE-171).
//
// Before `bind` no driver session can exist (launching is the only opener; the recovery's resumes
// run at boot step 5), so the "none" answers are the true ones.
import { HostInvariantError } from '../kernel/domain/errors'
import type { DwarfId, HostEpoch } from '../kernel/domain/values'
import type { CrewCommands, CrewQueries, SessionLinks } from '../modules/crew'
import type { Launching } from '../modules/launching'
import type { DriverSession, SessionChannels, SessionRef } from '../modules/suppliers'
import { createDriverAskChannel, type DriverAskChannel } from './bridges/driverAskChannel'
import { createResumeContextLookup } from './bridges/resumeContext'
import { ownedSessionsOver, type OwnedSessionLookup } from './bridges/sessionTerminator'
import { routeDriverEvents, type DriverEventRouteDeps } from './routes/driverEvents'
import { routeSessionExits } from './routes/launching'
import type { WiredSuppliers } from './suppliersWiring'

export interface LaunchedSessionsBindDeps {
  launching: Pick<Launching, 'owned' | 'commands'>
  suppliers: Pick<WiredSuppliers, 'routeEvents'> & { sessions: Pick<SessionChannels, 'sessionFor'> }
  /** `app_meta.install_id`, the first field of a resumed process's spawn tag (ADR-015 item 2). */
  installId: string
  hostEpoch: HostEpoch
  /** The modules the driver events go to (routes/driverEvents.ts). */
  routes: Omit<DriverEventRouteDeps, 'exits' | 'crew'>
  crew: {
    commands: Pick<CrewCommands, 'recordActivity' | 'sessionClosed'>
    queries: Pick<CrewQueries, 'get'>
  }
}

export interface LaunchedSessions {
  /** Crew's `SessionLinks`, over the observed-session relay's reach for an observed dwarf. */
  links(observed: { canDeliverTo(dwarfId: DwarfId): boolean }): SessionLinks
  /** The asking module's `driver` answer channel. */
  readonly answers: DriverAskChannel
  /** Each CLI driver's `resumeContext` (ISSUE-173). */
  readonly resumeContext: (ref: SessionRef) => { cwd: string; spawnTag: string } | null
  /** Boot step 4, once launching is wired: returns the lookup crew's terminator binds. */
  bind(deps: LaunchedSessionsBindDeps): OwnedSessionLookup
}

export function createLaunchedSessions(): LaunchedSessions {
  let owned: OwnedSessionLookup | null = null
  let ownership: Pick<Launching['owned'], 'liveRecordOf'> | null = null
  let sessions: Pick<SessionChannels, 'sessionFor'> | null = null
  let resume: ((ref: SessionRef) => { cwd: string; spawnTag: string } | null) | null = null
  /** The dwarf's live driver session: its live launch record's session, while suppliers holds it. */
  const driverOf = (dwarfId: DwarfId): DriverSession | null => {
    const record = ownership?.liveRecordOf(dwarfId) ?? null
    return record === null ? null : (sessions?.sessionFor(record.ref) ?? null)
  }
  return {
    links: (observed) => ({
      owned: (dwarfId) => ownership?.liveRecordOf(dwarfId) != null,
      hasDeliveryRoute: (dwarfId) =>
        ownership?.liveRecordOf(dwarfId) != null
          ? driverOf(dwarfId) !== null
          : observed.canDeliverTo(dwarfId)
    }),
    answers: createDriverAskChannel({ sessionOf: driverOf }),
    resumeContext: (ref) => resume?.(ref) ?? null,
    bind: (deps) => {
      if (owned !== null) throw new HostInvariantError('the launched sessions are bound once')
      const { launching, suppliers } = deps
      ownership = launching.owned
      sessions = suppliers.sessions
      owned = ownedSessionsOver({ launching: launching.owned, channels: suppliers.sessions })
      resume = createResumeContextLookup({
        owned: launching.owned,
        installId: deps.installId,
        hostEpoch: deps.hostEpoch
      })
      suppliers.routeEvents(
        routeDriverEvents({
          ...deps.routes,
          crew: deps.crew,
          exits: routeSessionExits({ launching, crew: deps.crew })
        })
      )
      return owned
    }
  }
}
