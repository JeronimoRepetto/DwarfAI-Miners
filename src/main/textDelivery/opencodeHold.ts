/**
 * Messages the panel is holding for an OpenCode session whose turn is still
 * running (#534) — the OpenCode twin of codexHold.ts.
 *
 * The queue is the PANEL's and never OpenCode's, and it has to be:
 * `opencode run --session <id>` reads one prompt and exits with its turn, so
 * a session continued from here has no inbox of its own to wait in. And a
 * second `opencode run --session <id>` started while one is already running
 * on that session is NOT refused — M6 measured two calls 1 s apart both
 * exiting 0 and racing, three assistant rows for two prompts — which is
 * worse than Codex's outright refusal, not better: the panel is the only
 * thing that can keep this from happening at all, because OpenCode's own CLI
 * will not stop it.
 *
 * This is a SEPARATE queue from CodexHoldQueue rather than a shared,
 * generalised one, on purpose: `holdId` correlates a verdict on the wire
 * with no channel of its own (DwarfSendSettledPush), so the two queues must
 * never mint the same id for two different messages held in the same
 * runtime — see the minting comment on `hold` below. Keeping two small,
 * parallel classes makes that non-collision a property of their separate
 * id spaces rather than a rule a shared counter would have to enforce.
 *
 * Pure, and deliberately: it decides WHICH message goes next and never when.
 * Whether a turn is in flight is the runtime's finding (a launch process it
 * still holds, or a continuation it spawned that has not exited), and
 * keeping that out of here is what lets every rule below be asserted
 * without a process.
 *
 * Nothing here survives a quit. A message sitting in this app's memory has
 * been handed to nothing, so losing it costs the person a re-send and never a
 * false ✓ — see the marker it drives, which stays pending for exactly that
 * reason (`DwarfSendState`'s 'held', and reaction.ts on delivered-versus-
 * reacted).
 */

/** What a caller knows about a message it wants held; the id is minted here. */
export interface HoldOpenCodeRequest {
  /** The dwarf the person typed at, which is also what a Kick names. */
  dwarfId: string
  /** The OpenCode session the turn will run on, and the key the wait is per. */
  sessionId: string
  /** The session's own directory; a continuation hangs from any other (M4). */
  cwd: string
  /**
   * The payload exactly as the send route built it — any worker prefix
   * included. Held rather than re-derived, so the message that finally goes
   * is the one the person's send resolved, not one rebuilt against a board
   * that has moved since.
   */
  text: string
  /**
   * Whose LAUNCH record may be re-checked while this message waits, or
   * absent on a foreman hop — the same rule `holdForBusyOpenCodeSession`
   * applies to a live send (#462's Risk 1, mirrored). No OpenCode provider
   * today returns a hop that terminates on this channel (roots only, #534),
   * so this is currently always equal to `dwarfId` — kept as its own field
   * rather than reusing `dwarfId` outright so the drain loop's busy re-check
   * and the initial hold decision can never quietly drift apart if that
   * ever stops being true.
   */
  launchDwarfId?: string
}

/** One message waiting for a session's turn to end. */
export interface HeldOpenCodeMessage extends HoldOpenCodeRequest {
  /**
   * What the eventual verdict is reported under (see `DwarfSendSettledPush`).
   * Minted by main, exactly as CodexHoldQueue's own `holdId` is, but under a
   * DISTINCT prefix (`hold:oc:`) — see `hold` below for why the two queues'
   * ids must never collide.
   */
  holdId: string
  heldAt: number
}

/**
 * How long a message may wait before the panel gives up on it — the same 30
 * minutes CODEX_HOLD_MAX_MS uses, for the same reason: nothing here is being
 * awaited, and the event this waits for is a process ending. An OpenCode
 * turn was measured at 5-8 s for a trivial one (M3, M9); an agentic one
 * reading a repository runs far longer, so anything shorter would abandon
 * messages the person was right to expect. What it exists for is the case
 * where the ending is never seen at all — a launch handle that outlives the
 * process it named, a continuation whose exit this panel missed — and a
 * message that waits forever is one the person has been told a lie about,
 * so the wait ends and the marker says it was not sent, never that it was
 * handed over.
 */
export const OPENCODE_HOLD_MAX_MS = 30 * 60_000

export class OpenCodeHoldQueue {
  /**
   * One list for every session, oldest first.
   *
   * Flat rather than a map keyed by session, exactly as CodexHoldQueue's own
   * `messages` is and for the same reason: Kick names a DWARF, expiry names a
   * moment, and order is the only index that answers both — a session's own
   * FIFO is that order filtered, which is what `next` does.
   */
  private readonly messages: HeldOpenCodeMessage[] = []
  private sequence = 0

  /**
   * Hold one message, and answer with the record the verdict will name.
   *
   * `hold:oc:${n}` rather than CodexHoldQueue's `hold:${n}`: both queues can
   * be live in the same runtime at once, each numbering from 1, and
   * `DwarfSendSettledPush` correlates a verdict by `holdId` ALONE, never by
   * channel. Two queues minting the same string for two different messages
   * would let one queue's ending settle the other's — the distinct prefix is
   * what keeps the two id spaces from ever meeting.
   */
  hold(request: HoldOpenCodeRequest, now: number): HeldOpenCodeMessage {
    this.sequence += 1
    const held: HeldOpenCodeMessage = {
      ...request,
      holdId: `hold:oc:${this.sequence}`,
      heldAt: now
    }
    this.messages.push(held)
    return held
  }

  /**
   * Take the oldest message held for `sessionId`, or nothing.
   *
   * ONE message, never the session's whole list: each held message is its
   * own continuation, and — unlike Codex, which refuses a concurrent turn —
   * OpenCode was measured to RACE one instead (M6), which is precisely the
   * outcome this queue exists to prevent by never starting a second one
   * itself. So the caller sends this one and asks again when it ends.
   */
  next(sessionId: string): HeldOpenCodeMessage | undefined {
    const index = this.messages.findIndex((message) => message.sessionId === sessionId)
    if (index === -1) return undefined
    return this.messages.splice(index, 1)[0]
  }

  /**
   * Give up everything held for `dwarfId`, oldest first — what a Kick takes
   * with it.
   *
   * Kick ENDS the session a launched OpenCode dwarf is (#217), which is the
   * very event a held message is waiting for. Ending it is the person's
   * LATER decision and outranks the earlier message, so the wait is
   * abandoned rather than fired into a session that has just been told to
   * stop. The messages come back so the caller can say so on each one's own
   * marker.
   */
  dropDwarf(dwarfId: string): HeldOpenCodeMessage[] {
    return this.removeWhere((message) => message.dwarfId === dwarfId)
  }

  /** Give up everything held past `OPENCODE_HOLD_MAX_MS` at `now`, oldest first. */
  expired(now: number): HeldOpenCodeMessage[] {
    return this.removeWhere((message) => now - message.heldAt > OPENCODE_HOLD_MAX_MS)
  }

  /** Every session with something still waiting, in the order their heads were held. */
  sessions(): string[] {
    return [...new Set(this.messages.map((message) => message.sessionId))]
  }

  /** What is still waiting, oldest first — for the caller's own accounting. */
  held(): readonly HeldOpenCodeMessage[] {
    return [...this.messages]
  }

  private removeWhere(matches: (message: HeldOpenCodeMessage) => boolean): HeldOpenCodeMessage[] {
    const taken = this.messages.filter(matches)
    for (const message of taken) {
      this.messages.splice(this.messages.indexOf(message), 1)
    }
    return taken
  }
}
