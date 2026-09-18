import type { LaunchTuning } from '../domain/launchTuning'

/**
 * Messages the panel is holding for a Codex thread whose turn is still
 * running (#457).
 *
 * The queue is the PANEL's and never Codex's, and it has to be: `codex queue`
 * refuses an `exec`-tagged thread (`providers/codex/queue.ts`), so a session
 * launched from here has no inbox of its own to wait in. And a second
 * `codex exec resume <thread> -` started while a resumed turn on that thread
 * is still running exits 1 at once — measured live on codex-cli 0.153.4 —
 * so Codex refuses a concurrent turn rather than queueing it. The panel is
 * the only thing that knows when a turn ends, which makes it the only honest
 * place for the wait.
 *
 * Pure, and deliberately: it decides WHICH message goes next and never when.
 * Whether a turn is in flight is the runtime's finding (a launch process it
 * still holds, or a resume it spawned that has not exited), and keeping that
 * out of here is what lets every rule below be asserted without a process.
 *
 * Nothing here survives a quit. A message sitting in this app's memory has
 * been handed to nothing, so losing it costs the person a re-send and never a
 * false ✓ — see the marker it drives, which stays pending for exactly that
 * reason (`DwarfSendState`'s 'held', and reaction.ts on delivered-versus-
 * reacted).
 */

/** What a caller knows about a message it wants held; the id is minted here. */
export interface HoldCodexRequest {
  /** The dwarf the person typed at, which is also what a Kick names. */
  dwarfId: string
  /** The Codex thread the turn will run on, and the key the wait is per. */
  threadId: string
  /** The mine the thread belongs to; Codex declines to run outside a Git repository. */
  cwd: string
  /**
   * The payload exactly as the send route built it — any worker prefix
   * included. Held rather than re-derived, so the message that finally goes
   * is the one the person's send resolved, not one rebuilt against a board
   * that has moved since.
   */
  text: string
  /** What the thread itself already shows (#462, D2), carried to the resume unchanged. */
  observed: LaunchTuning
  /**
   * Whose LAUNCH record may be read for an explicit tuning (#462), or absent
   * on a foreman hop — the same rule `resumeCodexThread` applies to a live
   * send, resolved once here so the held turn cannot resolve it differently.
   */
  launchDwarfId?: string
}

/** One message waiting for a thread's turn to end. */
export interface HeldCodexMessage extends HoldCodexRequest {
  /**
   * What the eventual verdict is reported under (see `DwarfSendSettledPush`).
   * Minted by main for the reason `AgentLaunchResult.launchId` is: the
   * renderer has no dwarf-wide verdict to correlate on, because a dwarf can
   * be holding several messages at once.
   */
  holdId: string
  heldAt: number
}

/**
 * How long a message may wait before the panel gives up on it.
 *
 * A bound rather than a timeout on anything: nothing here is being awaited,
 * and the event this waits for is a process ending. Thirty minutes because a
 * real Codex turn runs for minutes rather than seconds — 29 s measured for a
 * trivial one (see codexResume.ts), and an agentic one that reads a repository
 * runs far longer — so anything shorter would abandon messages the person was
 * right to expect. What it exists for is the case where the ending is never
 * seen at all: a launch handle that outlives the process it named, a resume
 * whose exit this panel missed. A message that waits forever is one the person
 * has been told a lie about, so the wait ends and the marker says it was not
 * sent (#457) — never that it was handed over.
 */
export const CODEX_HOLD_MAX_MS = 30 * 60_000

export class CodexHoldQueue {
  /**
   * One list for every thread, oldest first.
   *
   * Flat rather than a map keyed by thread, because two of the three questions
   * asked of it are not about a thread at all: Kick names a DWARF, and expiry
   * names a moment. Order is the only index that answers all three, and a
   * thread's own FIFO is that order filtered — which is what `next` does.
   */
  private readonly messages: HeldCodexMessage[] = []
  private sequence = 0

  /** Hold one message, and answer with the record the verdict will name. */
  hold(request: HoldCodexRequest, now: number): HeldCodexMessage {
    this.sequence += 1
    const held: HeldCodexMessage = { ...request, holdId: `hold:${this.sequence}`, heldAt: now }
    this.messages.push(held)
    return held
  }

  /**
   * Take the oldest message held for `threadId`, or nothing.
   *
   * ONE message, never the thread's whole list: each held message is its own
   * resumed turn, and Codex refuses a second turn on a thread that is already
   * running one. So the caller sends this one and asks again when it ends.
   */
  next(threadId: string): HeldCodexMessage | undefined {
    const index = this.messages.findIndex((message) => message.threadId === threadId)
    if (index === -1) return undefined
    return this.messages.splice(index, 1)[0]
  }

  /**
   * Give up everything held for `dwarfId`, oldest first — what a Kick takes
   * with it.
   *
   * Kick ENDS the session a launched Codex dwarf is (#217), which is the very
   * event a held message is waiting for. Ending it is the person's LATER
   * decision and outranks the earlier message, so the wait is abandoned rather
   * than fired into a session that has just been told to stop. The messages
   * come back so the caller can say so on each one's own marker.
   */
  dropDwarf(dwarfId: string): HeldCodexMessage[] {
    return this.removeWhere((message) => message.dwarfId === dwarfId)
  }

  /** Give up everything held past `CODEX_HOLD_MAX_MS` at `now`, oldest first. */
  expired(now: number): HeldCodexMessage[] {
    return this.removeWhere((message) => now - message.heldAt > CODEX_HOLD_MAX_MS)
  }

  /** Every thread with something still waiting, in the order their heads were held. */
  threads(): string[] {
    return [...new Set(this.messages.map((message) => message.threadId))]
  }

  /** What is still waiting, oldest first — for the caller's own accounting. */
  held(): readonly HeldCodexMessage[] {
    return [...this.messages]
  }

  private removeWhere(matches: (message: HeldCodexMessage) => boolean): HeldCodexMessage[] {
    const taken = this.messages.filter(matches)
    for (const message of taken) {
      this.messages.splice(this.messages.indexOf(message), 1)
    }
    return taken
  }
}
