// The Reset-metrics saga's steps of the cut-1 board and conversation modules (16 §4.12
// `ResetDbStep`; ADR-023 items 1, 3, 4; 09 §7.2), built through each module's `index.ts` (R15) over
// the Host's one writer, and the route of what the mines step queues after the saga's `db` commit
// (hot spot, 22 §5; ISSUE-121).
//
// - `createModuleResetSteps`, run by boot step 3 before the saga is constructed (preferencesWiring.ts):
//   the saga resumes an unfinished reset there, before the modules of step 4 exist (16 §8.2), so
//   the steps are built over the database alone. resetParticipants.ts orders them (09 §7.2).
// - `route`, run by boot step 4 once mines exists: `MetricsResetStarted`, published after the `db`
//   commit (16 §2.3), aborts every walk and drops every pending one (`MineWalks.abortAll`: a walk
//   of a deleted or recreated mine never lands), then hands each mine the step recreated to the
//   mines module's walk (`walkRecreatedMines` → `MineWalks.walkDue`; 07 S3.24 "walk queued"; 07
//   §21 row "S13.01 reset db step"). A saga resumed at boot publishes no `MetricsResetStarted`: its recreated mines
//   are `measuring`, and the boot walks of step 7 (S3.25) walk them.
import { HostInvariantError } from '../kernel/domain/errors'
import type { MineId } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DomainEventBus } from '../kernel/ports/domainEventBus'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../kernel/ports/transactionScope'
import { createConversationResetStep } from '../modules/conversation'
import { createCrewResetStep } from '../modules/crew'
import { createLedgerResetStep } from '../modules/ledger'
import { createMinesResetStep, type MapSite, type MineWalks } from '../modules/mines'
import { createObservationResetStep } from '../modules/observation'
import type { PreferencesEvent } from '../modules/preferences'
import type { ModuleResetSteps } from './resetParticipants'

export interface ModuleResetStepsDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner: every step joins the saga's one `db` transaction (16 §2.2). */
  scope: TransactionScope
  clock: Clock
  /** The map's spawn sites, the same the mines module is given (`MinesDeps.mapSites`). */
  mapSites: readonly MapSite[]
  /** `Math.random` in production (`MinesDeps.random`). */
  random: () => number
}

export interface ModuleResetStepsRouteDeps {
  /** The Host's one event bus (16 §2.3), where the saga publishes `MetricsResetStarted`. */
  bus: Pick<DomainEventBus<PreferencesEvent>, 'subscribe'>
  /** The mines module's walks (`WiredMines.walks`, routes/mines.ts). */
  walks: Pick<MineWalks, 'walkDue' | 'abortAll'>
}

export interface WiredModuleResetSteps {
  /** The steps, for resetParticipants.ts. */
  steps: ModuleResetSteps
  /** Boot step 4, once mines exists: the route of the recreated mines' walks. */
  route(deps: ModuleResetStepsRouteDeps): void
}

export function createModuleResetSteps(deps: ModuleResetStepsDeps): WiredModuleResetSteps {
  const { db, scope } = deps
  const bound: { walks?: ModuleResetStepsRouteDeps['walks'] } = {}
  const remeasure = (mineId: MineId): void => {
    if (bound.walks === undefined) {
      throw new HostInvariantError('a recreated mine is walked after boot step 4 routed the walks')
    }
    bound.walks.walkDue(mineId)
  }
  const mines = createMinesResetStep({
    db,
    scope,
    clock: deps.clock,
    mapSites: deps.mapSites,
    random: deps.random,
    remeasure
  })
  return {
    steps: {
      mines,
      crew: createCrewResetStep({ db, scope }),
      observation: createObservationResetStep({ db, scope }),
      ledger: createLedgerResetStep({ db, scope }),
      conversation: createConversationResetStep({ db, scope })
    },
    route: ({ bus, walks }) => {
      if (bound.walks !== undefined) throw new HostInvariantError('the reset walks are routed once')
      bound.walks = walks
      bus.subscribe('MetricsResetStarted', () => {
        walks.abortAll()
        mines.walkRecreatedMines()
      })
    }
  }
}
