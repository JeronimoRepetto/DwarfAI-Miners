// `LegacyEndFirstAdapter` (21 §3, cuts 0–4; 14 §5), its A-N26 half (ISSUE-054): Stop everything and quit ends what the
// legacy runtime launched before the Host is asked to stop (ADR-002 D7; ADR-014 items 2, 9).
//
// On Confirm, `beforeStopAll` lists the sessions today's runtime launched and that are still alive, ends each through
// today's own identity-checked kill (`LaunchedSessionRegistry.end`: the retained exit handle, or for a launch a
// previous run made, the pid re-probed against the creation time `launched_sessions` recorded, 21 §5.3), in parallel,
// and waits for each end report within the legacy kill's own bound. Only when every one ended does it relay
// `host.shutdown {mode:'stop-all', requestId}` and answer the Host's outcome merged with the legacy ends. A kill that
// is refused, throws, or reports nothing within the bound answers a `StopAllOutcome` naming that dwarf in `failed` and
// relays nothing, so the Host, the windows and the tray stay (ADR-002 D7 step 3).
//
// Only launches are ended (INV-120): a session the person started in their own terminal is observed, never retained,
// so it is not in the register and the adapter never touches it. In cut 0 the dwarf ids are the legacy runtime's (the
// board is still legacy); waiting for `dwarf.departed` and the A-32 and A-N29 halves come later (ISSUE-090,
// ISSUE-178). Deleted at the end of cut 4 with `LegacyDwarfIdBridge`.
import type { DwarfId, StopAllOutcome } from '@dwarfai/contracts'
import type { Mine } from '../main/domain/types'
import {
  LaunchedSessionRegistry,
  type EndLaunchVerdict,
  type LaunchedProcess,
  type LaunchedSessionRegistryOptions,
  type RetainLaunchRequest
} from '../main/sessionLaunch/launchedSessions'
import type {
  LaunchedSessionStore,
  PersistedLaunch
} from '../main/sessionLaunch/launchedSessionStore'

/**
 * The legacy kill's own bound: today's process-tree end runs its OS command with a 5 000 ms timeout
 * (`main/platform/processEnd.ts` `runEndCommand`), after which it reports the kill as not done.
 */
export const LEGACY_KILL_BOUND_MS = 5_000

/** One live session the legacy runtime launched, with the legacy dwarf id it became once the legacy board showed one. */
export interface LegacyLaunch {
  launchId: string
  dwarfId?: string
}

/**
 * The id A-N26 names a legacy-launched dwarf by. In cut 0 the board is still legacy, so the outcome carries the legacy
 * runtime's own dwarf id (ISSUE-054), or the legacy launch id for a launch the legacy board has not shown as a dwarf
 * yet: no Host `DwarfId` exists for such a session before `LegacyDwarfIdBridge` joins the two (cut 1, 21 §3).
 */
function legacyDwarfId(launch: LegacyLaunch): DwarfId {
  return (launch.dwarfId ?? launch.launchId) as DwarfId
}

/** Today's launched register as the adapter uses it: reached only through `LegacyRuntimeRoute` (21 §3). */
export interface LegacyLaunchedSessions {
  /** The launches whose process has not ended yet. */
  liveLaunches(): Promise<readonly LegacyLaunch[]>
  /** Today's identity-checked kill of one launch, answering its end report. */
  endLaunch(launchId: string): Promise<EndLaunchVerdict>
}

export interface EndFirstTimers {
  /** Runs `run` after `ms`; the answer cancels it. */
  after(ms: number, run: () => void): () => void
}

export interface LegacyEndFirstAdapterDeps {
  legacy: LegacyLaunchedSessions
  timers: EndFirstTimers
}

export interface LegacyEndFirstAdapter {
  /**
   * The A-N26 relay (`StopAllRelay`, window/application/stopEverything.ts): ends every legacy-launched session, then
   * relays through `shutdown` only when all of them ended.
   */
  beforeStopAll(
    requestId: string,
    shutdown: (requestId: string) => Promise<StopAllOutcome>
  ): Promise<StopAllOutcome>
}

/** What one legacy end reported: a launch that was already gone was not ended by this Stop everything. */
type EndReport = 'ended' | 'already-ended' | 'failed'

export function createLegacyEndFirstAdapter({
  legacy,
  timers
}: LegacyEndFirstAdapterDeps): LegacyEndFirstAdapter {
  function endWithinBound(launchId: string): Promise<EndReport> {
    return new Promise<EndReport>((resolve) => {
      const cancel = timers.after(LEGACY_KILL_BOUND_MS, () => resolve('failed'))
      legacy.endLaunch(launchId).then(
        (verdict) => {
          cancel()
          resolve(verdict === 'refused' ? 'failed' : verdict)
        },
        () => {
          cancel()
          resolve('failed')
        }
      )
    })
  }

  return {
    async beforeStopAll(requestId, shutdown) {
      const launches = await legacy.liveLaunches()
      const reports = await Promise.all(
        launches.map(async (launch) => ({
          id: legacyDwarfId(launch),
          report: await endWithinBound(launch.launchId)
        }))
      )
      const ended = reports.filter((r) => r.report === 'ended').map((r) => r.id)
      const failed = reports.filter((r) => r.report === 'failed').map((r) => r.id)
      if (failed.length > 0) return { ended, failed }
      const outcome = await shutdown(requestId)
      return { ended: [...ended, ...outcome.ended], failed: outcome.failed }
    }
  }
}

/**
 * Today's `LaunchedSessionRegistry`, unchanged in what it does, that also answers which of its launches are still
 * alive (21 §3: the legacy runtime keeps its identity-checked kill and the `launched_sessions` records it reads).
 * `LegacyRuntimeRoute` composes it as the runtime's register. It adds no read of `launched_sessions`: the restored
 * launches are the rows the register's own `restore` listed and re-adopted.
 */
export class LegacyLaunchRegister
  extends LaunchedSessionRegistry
  implements LegacyLaunchedSessions
{
  /** The launches whose process has not been seen to end, each with the dwarf it became. */
  private readonly live = new Map<string, { dwarfId?: string }>()
  /** The rows the register's own `restore` read from `launched_sessions`, until it re-adopted or dropped them. */
  private readonly listed: PersistedLaunch[]

  constructor(options: LaunchedSessionRegistryOptions) {
    const listed: PersistedLaunch[] = []
    const store = options.store
    const reading: LaunchedSessionStore | undefined =
      store === undefined
        ? undefined
        : {
            list: async () => {
              const rows = await store.list()
              listed.push(...rows)
              return rows
            },
            put: (launch) => store.put(launch),
            remove: (launchId) => store.remove(launchId)
          }
    super({ ...options, ...(reading === undefined ? {} : { store: reading }) })
    this.listed = listed
  }

  override retain(request: RetainLaunchRequest): string {
    const handle = request.process
    // The exit can be told before `retain` answers the launch id, so both are kept here until it does.
    const launch: { launchId?: string; exited: boolean } = { exited: false }
    const process: LaunchedProcess = {
      pid: handle.pid,
      onExit: (listener) =>
        handle.onExit(() => {
          launch.exited = true
          if (launch.launchId !== undefined) this.live.delete(launch.launchId)
          listener()
        }),
      ...(handle.onEarlyFailure === undefined
        ? {}
        : { onEarlyFailure: (listener) => handle.onEarlyFailure?.(listener) }),
      ...(handle.onTurnOutcome === undefined
        ? {}
        : { onTurnOutcome: (listener) => handle.onTurnOutcome?.(listener) })
    }
    const launchId = super.retain({ ...request, process })
    launch.launchId = launchId
    if (!launch.exited) this.live.set(launchId, {})
    return launchId
  }

  override async restore(): Promise<void> {
    await super.restore()
    for (const row of this.listed.splice(0)) {
      // Re-adopted only when the creation time still matched (the register's own decision); a dropped row has no
      // process left to end.
      if (this.launchIdOf(row.sessionId) === row.launchId) this.live.set(row.launchId, {})
    }
  }

  override observe(mines: readonly Mine[]): void {
    super.observe(mines)
    for (const dwarf of mines.flatMap((m) => m.dwarfs)) {
      const launchId = this.launchIdOfDwarf(dwarf.id)
      const launch = launchId === undefined ? undefined : this.live.get(launchId)
      if (launch !== undefined && launch.dwarfId === undefined) launch.dwarfId = dwarf.id
    }
  }

  override async end(launchId: string): Promise<EndLaunchVerdict> {
    const verdict = await super.end(launchId)
    // A refused kill leaves the launch retained, and alive: a later Stop everything tries it again.
    if (verdict !== 'refused') this.live.delete(launchId)
    return verdict
  }

  liveLaunches(): Promise<readonly LegacyLaunch[]> {
    return Promise.resolve(
      [...this.live].map(([launchId, { dwarfId }]) =>
        dwarfId === undefined ? { launchId } : { launchId, dwarfId }
      )
    )
  }

  endLaunch(launchId: string): Promise<EndLaunchVerdict> {
    return this.end(launchId)
  }
}
