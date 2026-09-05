import { sameProcessStart } from '../platform/processProbe'
import type { DwarfProvider, Mine } from '../domain/types'
import type { LaunchedSessionStore } from './launchedSessionStore'

/**
 * What the panel keeps of a session it STARTED and let go of, so that it can
 * still end it (#217, #231).
 *
 * The gap this closes: a detached launch handed the process over and kept
 * nothing, so a Codex session started from the panel could not be messaged
 * (`codex exec` has no inbox), could not be interrupted, and could not be
 * killed — the app offered no exit from a process the person had started in it.
 *
 * Detachment itself is unchanged and stays deliberate: the agent outlives the
 * panel, and quitting the tray does NOT end a launched session. What is added
 * is a way to end one ON PURPOSE, and one consequence that is an honest limit
 * rather than an oversight: a launch is bound to at most ONE session, claimed
 * once, and never moved.
 *
 * ## Surviving a restart (#231)
 *
 * The register used to be in memory only, so a session launched by a previous
 * run had no exit at all: the panel drew its dwarf, offered nothing, and fell
 * back to the generic no-channel reason, which reads like a bug. #217 said
 * outright why remembering was not enough — "guessing from a recorded number is
 * how an unrelated process gets killed", and this app owns a `taskkill /T` that
 * would take an unrelated process's whole tree with it.
 *
 * What is written down is therefore never the pid alone. It is the pid AND the
 * creation time of that exact process, read from the machine WHILE this panel
 * still held the handle — the one fact a recycled pid cannot forge, because a
 * new process gets a new creation time. On the next run the machine is asked
 * again, and only an answer matching that recorded instant re-adopts the row:
 *
 * - **the same instant** — this is the process this app started, and its exit
 *   is offered again;
 * - **a different instant** — the launch is over and its number now belongs to
 *   something else; the row is deleted and nothing is signalled;
 * - **no answer at all** — which is also what a dead pid looks like, and is the
 *   ordinary case for every launch of a previous run that has since finished.
 *   Treated exactly as a mismatch. "Cannot answer" never becomes "same
 *   process", and that is the OPPOSITE reading from the Claude registry's own
 *   procStart guard (#45), on purpose: there an unknown leaves a dwarf on the
 *   board and the worst case is a stale dwarf, here an unknown would end a
 *   process tree and the worst case is somebody else's.
 *
 * A launch whose creation time the machine would not report at retain time is
 * never written down at all, for the same reason: a bare pid is not evidence,
 * and an exit that cannot be offered honestly is worse than no exit.
 *
 * ## Which session a launch is
 *
 * Nothing in a detached launch tells the panel which session it became: the
 * poll discovers it later through the provider's own storage, and for Codex
 * that record carries no pid at all. So the claim is made from what IS known
 * and is checkable — the folder the launch was started in, the provider that
 * was started, and the session ids that were already on the board when it
 * happened. The first session root of that provider to appear in that mine
 * that was not there before is the one this launch started.
 *
 * That is evidence, not certainty, so the rules around it are the conservative
 * ones: a session already on the board is never claimed, a spawned agent is
 * never claimed (it is a child of a session, and ending its parent's tree is
 * not what a kick on it asks for), a session in another mine is never claimed,
 * and a claim once made is kept — the panel does not revise who it started.
 */

/**
 * The retained handle on one launched process.
 *
 * `pid` is the process THIS panel spawned, which for a shim launch is the
 * console-hosting intermediary rather than the CLI itself — the tree below it
 * is what `endProcessTree` is for.
 *
 * `onExit` is the pid-reuse guard, and it is why a handle rather than a number
 * is retained: the moment that process is gone its number can belong to
 * anything on this machine, so a launch that has ended is never signalled.
 */
export interface LaunchedProcess {
  pid: number
  onExit(listener: () => void): void
}

export interface RetainLaunchRequest {
  provider: DwarfProvider
  /** The mine's folder, exactly as the launch was given it. */
  minePath: string
  process: LaunchedProcess
  /**
   * Every session id already known when the launch was made. A session in this
   * list is somebody else's, whatever folder it turns up in.
   */
  knownSessionIds: readonly string[]
}

/**
 * What ending a launch actually did. 'already-ended' covers both a process
 * that exited on its own and a second kick after a successful one: nothing was
 * signalled either way, and the panel says the session has already ended
 * rather than claiming to have ended it twice.
 */
export type EndLaunchVerdict = 'ended' | 'already-ended' | 'refused'

interface LaunchRecord {
  launchId: string
  provider: DwarfProvider
  minePath: string
  pid: number
  knownSessionIds: Set<string>
  /** The session this launch became, once one has been claimed. */
  sessionId?: string
  /** The dwarf that session turns up as, once a board has shown one. */
  dwarfId?: string
  /** True once that process is gone — by its own exit, our kill, or a recycled pid. */
  gone: boolean
  /**
   * The creation time of `pid`'s process, in flight while the probe answers
   * and settled once it has. Undefined when this run keeps no register.
   */
  procStart?: Promise<number | null>
  /** That same answer, once it is known to be a real reading. */
  procStartMs?: number
  /**
   * True for a record read back from the store. It has no exit handle — the
   * fact that makes an in-run kill safe — so its pid is re-checked against
   * `procStartMs` at the moment of the kill rather than trusted from startup.
   */
  restored: boolean
}

export interface LaunchedSessionRegistryOptions {
  /** Ends a process and everything below it; see platform/processEnd. */
  endProcessTree: (pid: number) => Promise<boolean>
  /**
   * When the process that owns a pid was created; see platform/processProbe.
   * Absent means this run keeps no durable register — nothing is probed and
   * nothing is written, which is #217's in-memory behaviour exactly.
   */
  processStartTimeMs?: (pid: number) => Promise<number | null>
  /**
   * Where a launch is written down so its exit survives a restart (#231).
   * Absent for the same reason the probe may be: index.ts owns the database,
   * so the register stays testable and disk-free without one.
   */
  store?: LaunchedSessionStore
  log?: (message: string) => void
}

export class LaunchedSessionRegistry {
  private readonly records = new Map<string, LaunchRecord>()
  private readonly bySession = new Map<string, string>()
  /**
   * The same claims keyed by DWARF id, which is what the delivery channels are
   * resolved by. Indexed here rather than looked up on the board, because the
   * board being stamped is not yet the board this holds: a session claimed on
   * this poll would otherwise wait a poll for its exit to be offered.
   */
  private readonly byDwarf = new Map<string, string>()
  private readonly endProcessTree: (pid: number) => Promise<boolean>
  private readonly probeStart: ((pid: number) => Promise<number | null>) | null
  private readonly store: LaunchedSessionStore | null
  private readonly log: (message: string) => void
  private sequence = 0
  /**
   * Serializes the fire-and-forget register writes, and is what settle() hands
   * back. The poll must never await a disk write, so without this there is
   * nothing a test can wait on and no ordering between two of them — the same
   * seam `projectWrites` is in the runtime.
   */
  private writes: Promise<void> = Promise.resolve()

  constructor(options: LaunchedSessionRegistryOptions) {
    this.endProcessTree = options.endProcessTree
    this.probeStart = options.processStartTimeMs ?? null
    this.store = options.store ?? null
    this.log = options.log ?? ((): void => {})
  }

  /** Keep hold of what a launch started, and answer with the id of that launch. */
  retain(request: RetainLaunchRequest): string {
    const launchId = this.nextLaunchId()
    const record: LaunchRecord = {
      launchId,
      provider: request.provider,
      minePath: request.minePath,
      pid: request.process.pid,
      knownSessionIds: new Set(request.knownSessionIds),
      gone: false,
      restored: false
    }
    // Asked NOW, while this panel still holds the handle, which is the only
    // moment that pid is certainly this launch's. Read later it would be a
    // question about whatever owns the number by then (#231).
    if (this.keepsRegister()) record.procStart = this.probeCreation(record.pid)
    this.records.set(launchId, record)
    // Subscribed here rather than probed later: this is the fact that keeps a
    // recycled pid from ever being signalled.
    request.process.onExit(() => {
      record.gone = true
      this.forget(launchId)
    })
    return launchId
  }

  /**
   * Re-adopt what a PREVIOUS run of the app launched (#231), or delete the row.
   *
   * Called once at startup, before the poll can claim anything, which is what
   * keeps this out of the way of `retain`: no launch of this run exists yet.
   * A row whose id is already taken is left alone rather than merged — one
   * record must never describe two processes.
   */
  async restore(): Promise<void> {
    const store = this.store
    if (store === null || !this.keepsRegister()) return
    for (const row of await store.list()) {
      if (this.records.has(row.launchId)) continue
      const probed = await this.probeCreation(row.pid)
      // The decision the whole design turns on. Only a creation time matching
      // the one recorded while this app held the handle re-adopts the row; a
      // different instant means the pid was recycled, and no answer at all is
      // what a dead pid looks like. Both delete the row, because keeping a
      // record this app may not act on is one more chance to act on it.
      if (probed === null || !sameProcessStart(probed, row.processStartTimeMs)) {
        await store.remove(row.launchId)
        this.log(`[launched] ${row.launchId} is gone; its pid ${row.pid} is not that process`)
        continue
      }
      this.records.set(row.launchId, {
        launchId: row.launchId,
        provider: row.provider,
        minePath: row.minePath,
        pid: row.pid,
        // Every session on the board is old news to a run that has just
        // started, so nothing here may claim: this record already knows which
        // session it is, which is the only reason it could be restored at all.
        knownSessionIds: new Set<string>(),
        sessionId: row.sessionId,
        gone: false,
        procStartMs: row.processStartTimeMs,
        restored: true
      })
      this.bySession.set(row.sessionId, row.launchId)
      this.log(`[launched] ${row.launchId} is still session ${row.sessionId} from a previous run`)
    }
  }

  /** Settles the register's fire-and-forget writes; a test seam. */
  settle(): Promise<void> {
    return this.writes
  }

  /**
   * The next launch id, skipping any a restored record already answers to.
   *
   * The counter starts again every run, so without this the first launch of
   * this run would be handed the id a previous run's restored launch already
   * holds, and one record would describe two processes.
   */
  private nextLaunchId(): string {
    let candidate: string
    do {
      this.sequence += 1
      candidate = `launch:${this.sequence}`
    } while (this.records.has(candidate))
    return candidate
  }

  /** Whether this run has both halves of the durable register wired. */
  private keepsRegister(): boolean {
    return this.store !== null && this.probeStart !== null
  }

  private async probeCreation(pid: number): Promise<number | null> {
    try {
      return (await this.probeStart?.(pid)) ?? null
    } catch {
      // A probe that threw reported nothing, and nothing is never a match.
      return null
    }
  }

  /**
   * Write one claimed launch down, once its creation time has come back.
   *
   * Queued rather than awaited: this runs off the poll, which must not wait on
   * a disk write. Nothing is written for a pid the machine would not date —
   * that row would be a bare pid, and a bare pid is what gets an unrelated
   * process's tree killed.
   */
  private remember(record: LaunchRecord): void {
    const store = this.store
    const pending = record.procStart
    if (store === null || pending === undefined) return
    this.writes = this.writes
      .then(async () => {
        const processStartTimeMs = await pending
        const sessionId = record.sessionId
        if (processStartTimeMs === null || sessionId === undefined || record.gone) return
        record.procStartMs = processStartTimeMs
        await store.put({
          launchId: record.launchId,
          provider: record.provider,
          sessionId,
          minePath: record.minePath,
          pid: record.pid,
          processStartTimeMs
        })
      })
      .catch((error: unknown) => {
        // A register that will not write costs this launch its exit after a
        // restart, and nothing else. The panel goes on offering the in-memory
        // one for as long as this run lasts.
        this.log(`[launched] ${record.launchId} could not be written down: ${String(error)}`)
      })
  }

  /** Drop one launch from the register on disk; it has no process left behind it. */
  private forget(launchId: string): void {
    const store = this.store
    if (store === null) return
    this.writes = this.writes
      .then(() => store.remove(launchId))
      .catch((error: unknown) => {
        this.log(`[launched] ${launchId} could not be forgotten: ${String(error)}`)
      })
  }

  /**
   * Fold one poll's board in, claiming a session for every launch still
   * waiting for one. Called before the delivery channels are stamped, so a
   * session claimed on this poll is offered its exit on the same poll.
   *
   * Two passes, because a restored launch arrives with its session already
   * known and its dwarf not: the claim answers "which session is this launch",
   * and the binding answers "which dwarf is that session right now". The second
   * used to be a side effect of the first, which left a restored record with no
   * dwarf to resolve a channel by, and therefore with no exit on the board.
   */
  observe(mines: readonly Mine[]): void {
    for (const record of this.records.values()) {
      if (record.sessionId !== undefined) continue
      const mine = mines.find((item) => item.path === record.minePath)
      if (mine === undefined) continue
      const claimed = mine.dwarfs.find(
        (dwarf) =>
          dwarf.provider === record.provider &&
          // A spawned agent is a child of a session, never the session this
          // launch started; absent means root (see Dwarf.parentId).
          dwarf.parentId === undefined &&
          dwarf.status !== 'leaving' &&
          !record.knownSessionIds.has(dwarf.sessionId) &&
          !this.bySession.has(dwarf.sessionId)
      )
      if (claimed === undefined) continue
      record.sessionId = claimed.sessionId
      this.bySession.set(claimed.sessionId, record.launchId)
      this.log(`[launched] ${record.launchId} is session ${claimed.sessionId}`)
      // Written down here rather than at retain, because this is the first
      // moment both halves of a row exist (#231).
      this.remember(record)
    }
    for (const record of this.records.values()) {
      if (record.sessionId === undefined || record.dwarfId !== undefined) continue
      // Searched across every mine by session id, not within the launch's own
      // folder: the session id is the provider's own and is already the proof.
      // A restored record's mine may not even be on this board yet.
      const dwarf = mines
        .flatMap((mine) => mine.dwarfs)
        .find(
          (item) =>
            item.sessionId === record.sessionId &&
            item.provider === record.provider &&
            item.parentId === undefined
        )
      if (dwarf === undefined) continue
      record.dwarfId = dwarf.id
      this.byDwarf.set(dwarf.id, record.launchId)
    }
  }

  /** The launch that started `sessionId`, or undefined when this panel did not. */
  launchIdOf(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)
  }

  /** The same answer for the dwarf a channel is being resolved for. */
  launchIdOfDwarf(dwarfId: string): string | undefined {
    return this.byDwarf.get(dwarfId)
  }

  /**
   * End one launch's process tree.
   *
   * Never signals a launch already gone, and never claims success the platform
   * did not report: a refused kill leaves the launch retained, because the
   * process really may still be running and a second attempt is honest.
   *
   * A RESTORED launch is checked once more first (#231). An in-run record is
   * guarded by its exit handle — libuv telling this process the child is gone —
   * and a restored one has no handle at all, only the number and the instant it
   * was created. Startup proved that pair minutes or hours ago; the session can
   * have finished and its pid been handed to something else since, so the pair
   * is proved again at the moment the signal would be sent. A pid that no
   * longer dates to that instant is reported as a session already ended, which
   * is what it is.
   */
  async end(launchId: string): Promise<EndLaunchVerdict> {
    const record = this.records.get(launchId)
    if (record === undefined || record.gone) return 'already-ended'
    if (record.restored && !(await this.stillTheProcessWeStarted(record))) {
      record.gone = true
      this.forget(launchId)
      this.log(`[launched] ${launchId} is gone; its pid ${record.pid} is not that process`)
      return 'already-ended'
    }
    const ended = await this.endProcessTree(record.pid)
    if (!ended) return 'refused'
    record.gone = true
    this.forget(launchId)
    this.log(`[launched] ${launchId} ended`)
    return 'ended'
  }

  /** Whether `pid` still dates to the instant this launch's process was created. */
  private async stillTheProcessWeStarted(record: LaunchRecord): Promise<boolean> {
    const recorded = record.procStartMs
    if (recorded === undefined) return false
    const probed = await this.probeCreation(record.pid)
    return probed !== null && sameProcessStart(probed, recorded)
  }
}
