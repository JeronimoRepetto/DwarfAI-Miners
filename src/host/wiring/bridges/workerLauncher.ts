// The `WorkerLauncher` bridge (16 §4.8, with the signature AMENDMENT-15 (owner, 2026-10-15) gives
// it; ISSUE-180; ADR-013 items 1, 4; UC-017): delegation → launching. Jev already picked the
// worker for the subtask; the bridge sends one delegated launch and answers once it settled.
//
// - The structural `WorkerLauncher` type is declared here (lead decision 2026-09-30): the delegation
//   module has no `ports/workerLauncher.ts` yet. ISSUE-209 binds it to that port and deletes this
//   local type.
// - The request (09 D-17; 07 S5.10): the parent's mine, the task as the worker's first message, no
//   "Let Jev choose" (`jevOn: false`, so `launched_with_let_jev_choose = 0` and no delegation entry
//   for the worker, INV-81), and `delegation` naming the delegation and its delegating dwarf. A pick
//   is taken as given (no second Jev call, S5.12): its provider, model and effort fill the supplier
//   path. A pick that fell back names no supplier: it is sent as a `jev` way with its reason, and
//   launching fails it in `routing` (S5.14, S5.15; a delegated `effort-ceiling` is
//   `jev-could-not-choose`, never handed back, ADR-028 D2).
// - The answer (16 §2.9): `launch` answers at acceptance; the bridge then waits for that launch's
//   own settlement event, `DwarfLaunched` (the worker's `DwarfId`) or `LaunchFailed` (exactly its
//   cause, INV-52). It listens before it launches, so a settlement can never be missed, and it
//   stops listening once settled. A delegated launch is never handed back (09 §4.3 CHECK).
// - A parent the crew no longer knows, or a launch launching refuses at acceptance, has no launch
//   to settle: the bridge answers `could-not-start`, never a sixth cause (INV-52), and the
//   delegation fails as its worker failed (07 S8.07).
import type { JevSuggestionView } from '@dwarfai/contracts'
import type { LaunchFailureCause } from '../../kernel/domain/sharedContracts'
import type { DwarfId, LaunchId, ProviderId, Result } from '../../kernel/domain/values'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { CrewQueries } from '../../modules/crew'
import type { LaunchingCommands, LaunchingEvent, LaunchRequestInput } from '../../modules/launching'

// Amended: 05 §3.8 / 16 §4.8 WorkerLauncher.launchWorker delegationId (AMENDMENT-15 (owner, 2026-10-15))
export interface WorkerLauncher {
  launchWorker(
    delegationId: string,
    parent: DwarfId,
    pick: JevSuggestionView,
    task: string
  ): Promise<Result<DwarfId, LaunchFailureCause>>
} // bridge → launching

export interface WorkerLauncherDeps {
  /** The launching module's `launch` (16 §4.5): answers at acceptance. */
  launching: Pick<LaunchingCommands, 'launch'>
  /** The launching events the settlement arrives as. */
  events: Pick<DomainEventBus<LaunchingEvent>, 'subscribe'>
  /** The delegating dwarf's mine: the worker works where its parent works. */
  crew: Pick<CrewQueries, 'get'>
}

type Settlement = Result<DwarfId, LaunchFailureCause>

const COULD_NOT_START: Settlement = { ok: false, error: 'could-not-start' }

export function createWorkerLauncher(deps: WorkerLauncherDeps): WorkerLauncher {
  return {
    async launchWorker(delegationId, parent, pick, task) {
      const view = deps.crew.get(parent)
      if (view === null || view.departed) return COULD_NOT_START
      const request = workerRequest(view.mineId, delegationId, parent, pick, task)

      // Settlements seen before `launch` answered wait here until the launch id is known.
      const early = new Map<LaunchId, Settlement>()
      let mine: LaunchId | null = null
      let settle: (s: Settlement) => void = () => undefined
      const settled = new Promise<Settlement>((resolve) => {
        settle = resolve
      })
      const seen = (launchId: LaunchId, s: Settlement): void => {
        if (mine === null) early.set(launchId, s)
        else if (launchId === mine) settle(s)
      }
      const stops = [
        deps.events.subscribe('DwarfLaunched', (e) =>
          seen(e.payload.launchId, { ok: true, value: e.payload.dwarfId })
        ),
        deps.events.subscribe('LaunchFailed', (e) =>
          seen(e.payload.launchId, { ok: false, error: e.payload.failure.cause })
        )
      ]
      try {
        try {
          mine = (await deps.launching.launch(request)).launchId
        } catch {
          // Refused at acceptance (`LaunchRefusedError`): no launch exists to settle.
          return COULD_NOT_START
        }
        const already = early.get(mine)
        if (already !== undefined) return already
        return await settled
      } finally {
        for (const stop of stops) stop()
      }
    }
  }
}

/** The delegated launch of one pick (09 D-17; 07 S5.10, S5.12). */
function workerRequest(
  mineId: LaunchRequestInput['mineId'],
  delegationId: string,
  parent: DwarfId,
  pick: JevSuggestionView,
  task: string
): LaunchRequestInput {
  const common = { prompt: task, jevOn: false, jevAutoAccept: false }
  if (pick.fallback !== undefined || pick.providerId === undefined) {
    return {
      mineId,
      way: { kind: 'jev' },
      ...common,
      delegation: {
        delegationId,
        parentDwarfId: parent,
        // A pick with no supplier and no reason is a response Jev could not stand behind.
        fallback: pick.fallback ?? 'invalid-response'
      }
    }
  }
  return {
    mineId,
    way: { kind: 'supplier', providerId: pick.providerId as ProviderId },
    ...(pick.model === undefined ? {} : { model: pick.model }),
    ...(pick.effort === undefined ? {} : { effort: pick.effort }),
    ...common,
    delegation: { delegationId, parentDwarfId: parent }
  }
}
