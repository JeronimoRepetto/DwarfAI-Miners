import type { DwarfProvider, Mine } from '../domain/types'

/**
 * What the panel keeps of a session it STARTED and let go of, so that it can
 * still end it (#217).
 *
 * The gap this closes: a detached launch handed the process over and kept
 * nothing, so a Codex session started from the panel could not be messaged
 * (`codex exec` has no inbox), could not be interrupted, and could not be
 * killed — the app offered no exit from a process the person had started in it.
 *
 * Detachment itself is unchanged and stays deliberate: the agent outlives the
 * panel, and quitting the tray does NOT end a launched session. What is added
 * is a way to end one ON PURPOSE. Two consequences follow from that, and both
 * are honest limits rather than oversights:
 *
 * - the register is in memory, so a session launched by a previous run of the
 *   app has no exit here — its pid died with the process that knew it, and
 *   guessing from a recorded number is how an unrelated process gets killed;
 * - a launch is bound to at most ONE session, claimed once, and never moved.
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
  /** True once that process is gone — by its own exit or by our kill. */
  gone: boolean
}

export interface LaunchedSessionRegistryOptions {
  /** Ends a process and everything below it; see platform/processEnd. */
  endProcessTree: (pid: number) => Promise<boolean>
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
  private readonly log: (message: string) => void
  private sequence = 0

  constructor(options: LaunchedSessionRegistryOptions) {
    this.endProcessTree = options.endProcessTree
    this.log = options.log ?? ((): void => {})
  }

  /** Keep hold of what a launch started, and answer with the id of that launch. */
  retain(request: RetainLaunchRequest): string {
    this.sequence += 1
    const launchId = `launch:${this.sequence}`
    const record: LaunchRecord = {
      launchId,
      provider: request.provider,
      minePath: request.minePath,
      pid: request.process.pid,
      knownSessionIds: new Set(request.knownSessionIds),
      gone: false
    }
    this.records.set(launchId, record)
    // Subscribed here rather than probed later: this is the fact that keeps a
    // recycled pid from ever being signalled.
    request.process.onExit(() => {
      record.gone = true
    })
    return launchId
  }

  /**
   * Fold one poll's board in, claiming a session for every launch still
   * waiting for one. Called before the delivery channels are stamped, so a
   * session claimed on this poll is offered its exit on the same poll.
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
      this.byDwarf.set(claimed.id, record.launchId)
      this.log(`[launched] ${record.launchId} is session ${claimed.sessionId}`)
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
   */
  async end(launchId: string): Promise<EndLaunchVerdict> {
    const record = this.records.get(launchId)
    if (record === undefined || record.gone) return 'already-ended'
    const ended = await this.endProcessTree(record.pid)
    if (!ended) return 'refused'
    record.gone = true
    this.log(`[launched] ${launchId} ended`)
    return 'ended'
  }
}
