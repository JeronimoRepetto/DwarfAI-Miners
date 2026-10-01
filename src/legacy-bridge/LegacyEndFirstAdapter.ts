// `LegacyEndFirstAdapter` (21 §3, cuts 0–4; 14 §5), its A-N26 half (ISSUE-054): Stop everything and quit ends what the
// legacy runtime launched before the Host is asked to stop (ADR-002 D7; ADR-014 items 2, 9).
//
// On Confirm, `beforeStopAll` lists the sessions today's runtime launched and that are still alive, ends each through
// today's own identity-checked kill (`LaunchedSessionRegistry.end`: the retained exit handle, or for a launch a
// previous run made, the pid re-probed against the creation time `launched_sessions` recorded, 21 §5.3), in parallel,
// and waits for each end report within the legacy kill's own bound. Only when every one ended does it relay
// `host.shutdown {mode:'stop-all', requestId}`, and it answers the Host's outcome unchanged: a `StopAllOutcome` names
// Host dwarf ids only, so a legacy end is never listed in it (owner ruling, 2026-10-01). A kill that is refused,
// throws, or reports nothing within the bound relays nothing and fails the relay with an `INTERNAL` error (14 §2.2
// A-N26, eB), which A-N26 answers as its error branch; the Host, the windows and the tray stay (ADR-002 D7 step 3).
//
// Only launches are ended (INV-120): a session the person started in their own terminal is observed, never retained,
// so it is not in the register and the adapter never touches it. Waiting for `dwarf.departed` and the A-32 and A-N29
// halves come later (ISSUE-090, ISSUE-178). Deleted at the end of cut 4 with `LegacyDwarfIdBridge`.
import type { IpcError, StopAllOutcome } from '@dwarfai/contracts'
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

/** One live session the legacy runtime launched. */
export interface LegacyLaunch {
  launchId: string
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
   * relays through `shutdown` only when all of them ended; otherwise rejects with `LegacyEndFailed`.
   */
  beforeStopAll(
    requestId: string,
    shutdown: (requestId: string) => Promise<StopAllOutcome>
  ): Promise<StopAllOutcome>
}

/**
 * Some legacy-launched session could not be ended, so nothing was relayed. It carries the seam-B error A-N26 answers
 * (the relay's `{ error }` convention, stopEverything.ts `ipcErrorOf`); its message is a diagnostic, never shown copy.
 */
export class LegacyEndFailed extends Error {
  readonly error: IpcError

  constructor(failed: number, of: number) {
    const message = `${failed} of ${of} legacy-launched session(s) could not be ended; stop-all was not relayed`
    super(message)
    this.name = 'LegacyEndFailed'
    this.error = { code: 'INTERNAL', message, retryable: false }
  }
}

export function createLegacyEndFirstAdapter({
  legacy,
  timers
}: LegacyEndFirstAdapterDeps): LegacyEndFirstAdapter {
  /** Whether the launch ended (or was already gone) within the bound; a refusal, a throw or no report is a failure. */
  function endWithinBound(launchId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cancel = timers.after(LEGACY_KILL_BOUND_MS, () => resolve(false))
      legacy.endLaunch(launchId).then(
        (verdict) => {
          cancel()
          resolve(verdict !== 'refused')
        },
        () => {
          cancel()
          resolve(false)
        }
      )
    })
  }

  return {
    async beforeStopAll(requestId, shutdown) {
      const launches = await legacy.liveLaunches()
      const ended = await Promise.all(launches.map((launch) => endWithinBound(launch.launchId)))
      const failed = ended.filter((done) => !done).length
      if (failed > 0) throw new LegacyEndFailed(failed, launches.length)
      return shutdown(requestId)
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
  /** The launches whose process has not been seen to end. */
  private readonly live = new Set<string>()
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
    if (!launch.exited) this.live.add(launchId)
    return launchId
  }

  override async restore(): Promise<void> {
    await super.restore()
    for (const row of this.listed.splice(0)) {
      // Re-adopted only when the creation time still matched (the register's own decision); a dropped row has no
      // process left to end.
      if (this.launchIdOf(row.sessionId) === row.launchId) this.live.add(row.launchId)
    }
  }

  override async end(launchId: string): Promise<EndLaunchVerdict> {
    const verdict = await super.end(launchId)
    // A refused kill leaves the launch retained, and alive: a later Stop everything tries it again.
    if (verdict !== 'refused') this.live.delete(launchId)
    return verdict
  }

  liveLaunches(): Promise<readonly LegacyLaunch[]> {
    return Promise.resolve([...this.live].map((launchId) => ({ launchId })))
  }

  endLaunch(launchId: string): Promise<EndLaunchVerdict> {
    return this.end(launchId)
  }
}
