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
// so it is not in the register and the adapter never touches it.
//
// The A-32 half (ISSUE-090, from cut 1, composed only with `LegacyDwarfIdBridge`): `beforeRemoveMine` takes the Host
// mine's present dwarfs (the HostClient's whole snapshot and the `dwarf.*` frames after it), joins each to today's
// dwarf through the bridge's exact `ProviderIdentity` join and to the launch today's register bound it to; a dwarf with
// no such launch is the Host's to end (B-M18). It ends each of those launches through the same legacy kill, in
// parallel, and waits, within the legacy kill's own bound, for both the end report and the Host's `dwarf.departed`
// (B-F10) for that dwarf: relaying earlier would find the dwarf still present, and the Host has no process identity
// for it (15 §5 `no-identity`). Only then does it relay `mines.remove {mineId, requestId}` through `remove`; a refused
// or thrown kill, or a departure that does not arrive in time, answers A-32's "unchanged" shape
// (./rowShapes/mineNotRemoved.ts) and relays nothing (INV-06). It reads the Host only (snapshot and frames); the one
// command it relays is the caller's. The A-N29 half comes later (ISSUE-178). Deleted at the end of cut 4 with
// `LegacyDwarfIdBridge` (later: ISSUE-241).
//
// Candidate decision (21 §6): no candidate exists for the A-32 half; new code.
import type { HostFrames, IpcError, StopAllOutcome } from '@dwarfai/contracts'
import type { MineUndeclareResult } from '../main/domain/types'
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
import type { HostClient, HostEvent } from '../ui-main/window/ports/hostClient'
import type { LegacyDwarfIdBridge } from './LegacyDwarfIdBridge'
import { MINE_DWARF_NOT_ENDED } from './rowShapes/mineNotRemoved'

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

/** Today's launched register, asked which launch started a legacy dwarf (the register's own binding). */
export interface LegacyLaunchesByDwarf {
  /** The launch that started the legacy dwarf `dwarfId`, or undefined when today's runtime did not launch it. */
  launchIdOfDwarf(dwarfId: string): string | undefined
}

/** What the A-32 half needs from cut 1: the Host's present dwarfs and departures, and the join to legacy ids. */
export interface LegacyEndFirstRemovalDeps {
  legacy: LegacyLaunchedSessions & LegacyLaunchesByDwarf
  timers: EndFirstTimers
  host: {
    /** Read only: the snapshot and the `dwarf.arrived` / `dwarf.departed` frames (B-F10); no Host command path. */
    client: Pick<HostClient, 'subscribe'>
    /** The exact `ProviderIdentity` join (21 §3 `LegacyDwarfIdBridge`). */
    bridge: Pick<LegacyDwarfIdBridge, 'toLegacy'>
  }
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

/** The A-32 half (cut 1 on), composed only where the bridge exists. */
export interface LegacyEndFirstRemoval {
  /**
   * The A-32 relay: ends every legacy-launched session of the Host mine `mineId`, waits for each one's
   * `dwarf.departed` (B-F10), then relays through `remove`; otherwise answers A-32's "unchanged" shape and relays
   * nothing.
   */
  beforeRemoveMine(
    mineId: string,
    requestId: string,
    remove: (mineId: string, requestId: string) => Promise<MineUndeclareResult>
  ): Promise<MineUndeclareResult>
  /** Unsubscribes; nothing is read after. */
  dispose(): void
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

export function createLegacyEndFirstAdapter(
  deps: LegacyEndFirstRemovalDeps
): LegacyEndFirstAdapter & LegacyEndFirstRemoval
export function createLegacyEndFirstAdapter(deps: LegacyEndFirstAdapterDeps): LegacyEndFirstAdapter
export function createLegacyEndFirstAdapter(
  deps: LegacyEndFirstAdapterDeps | LegacyEndFirstRemovalDeps
): LegacyEndFirstAdapter | (LegacyEndFirstAdapter & LegacyEndFirstRemoval) {
  const { legacy, timers } = deps
  /**
   * Whether the launch ended (or was already gone) within the bound and, when `departure` is given, the Host also saw
   * its dwarf depart within that same bound; a refusal, a throw, no report or no departure is a failure.
   */
  function endWithinBound(launchId: string, departure?: Departure): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let ended = false
      let departed = departure === undefined
      let settled = false
      const finish = (done: boolean): void => {
        if (settled) return
        settled = true
        cancel()
        stopWatching()
        resolve(done)
      }
      const cancel = timers.after(LEGACY_KILL_BOUND_MS, () => finish(false))
      const stopWatching =
        departure?.(() => {
          departed = true
          if (ended) finish(true)
        }) ?? (() => {})
      legacy.endLaunch(launchId).then(
        (verdict) => {
          if (verdict === 'refused') return finish(false)
          ended = true
          if (departed) finish(true)
        },
        () => finish(false)
      )
    })
  }

  const stopAll: LegacyEndFirstAdapter = {
    async beforeStopAll(requestId, shutdown) {
      const launches = await legacy.liveLaunches()
      const ended = await Promise.all(launches.map((launch) => endWithinBound(launch.launchId)))
      const failed = ended.filter((done) => !done).length
      if (failed > 0) throw new LegacyEndFailed(failed, launches.length)
      return shutdown(requestId)
    }
  }
  if (!('host' in deps)) return stopAll
  const { client, bridge } = deps.host
  const launches = deps.legacy

  /** The Host's present dwarfs (DwarfId → MineId), from the client's whole snapshot and every frame after it. */
  let present = new Map<string, string>()
  /** Who waits for a dwarf to leave the Host's board. */
  const watchers = new Map<string, Set<() => void>>()
  const told = (dwarfId: string): void => {
    for (const gone of [...(watchers.get(dwarfId) ?? [])]) gone()
  }
  const unsubscribe = client.subscribe((event: HostEvent) => {
    if (event.kind === 'snapshot') {
      const before = present
      present = new Map()
      for (const chunk of event.snapshot.chunks)
        if (chunk.section === 'dwarfs')
          for (const dwarf of chunk.data) present.set(dwarf.id, dwarf.mineId)
      for (const dwarfId of before.keys()) if (!present.has(dwarfId)) told(dwarfId)
      return
    }
    const { frame } = event
    if (frame.name === 'dwarf.arrived' || frame.name === 'dwarf.changed') {
      const { dwarf } = frame.data as HostFrames['dwarf.changed']
      present.set(dwarf.id, dwarf.mineId)
    } else if (frame.name === 'dwarf.departed') {
      const { dwarfId } = frame.data as HostFrames['dwarf.departed']
      present.delete(dwarfId)
      told(dwarfId)
    }
  })

  /** Watches for the Host's `dwarf.departed` of `dwarfId` (B-F10); told at once when it is already off the board. */
  const departureOf =
    (dwarfId: string): Departure =>
    (gone) => {
      if (!present.has(dwarfId)) {
        gone()
        return () => {}
      }
      const waiting = watchers.get(dwarfId) ?? new Set<() => void>()
      watchers.set(dwarfId, waiting)
      waiting.add(gone)
      return () => {
        waiting.delete(gone)
        if (waiting.size === 0) watchers.delete(dwarfId)
      }
    }

  /** The mine's Host dwarfs that today's runtime launched, each with its launch (the exact join, 21 §3). */
  async function legacyLaunchedIn(mineId: string): Promise<Array<[string, string]>> {
    const inMine = [...present].filter(([, of]) => of === mineId).map(([dwarfId]) => dwarfId)
    const joined = await Promise.all(
      inMine.map(async (dwarfId): Promise<[string, string] | null> => {
        const legacyId = await bridge.toLegacy(dwarfId)
        const launchId = legacyId === null ? undefined : launches.launchIdOfDwarf(legacyId)
        return launchId === undefined ? null : [dwarfId, launchId]
      })
    )
    return joined.filter((pair): pair is [string, string] => pair !== null)
  }

  return {
    ...stopAll,
    async beforeRemoveMine(mineId, requestId, remove) {
      const targets = await legacyLaunchedIn(mineId)
      const ended = await Promise.all(
        targets.map(([dwarfId, launchId]) => endWithinBound(launchId, departureOf(dwarfId)))
      )
      if (ended.some((done) => !done)) return { ...MINE_DWARF_NOT_ENDED }
      return remove(mineId, requestId)
    },
    dispose() {
      unsubscribe()
    }
  }
}

/** Starts watching for one departure; `gone` runs once it is seen; the answer stops watching. */
type Departure = (gone: () => void) => () => void

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
