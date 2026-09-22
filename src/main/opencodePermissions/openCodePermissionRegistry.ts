import type { OpenCodePermissionPush } from './permissionPushPayload'

/**
 * How long a pending OpenCode ask nobody has replied to is kept before it is
 * dropped -- mirrors UNMATCHED_PROMPT_GRACE_MS in hooks/permissionPrompts.ts,
 * and for the same reason: a push can reach this registry before whatever
 * later consults it (#588 T4) has even drawn the session it names, so an
 * unclaimed ask waits rather than being discarded. The bound is real because
 * observe() sweeps the whole map on this schedule -- not because askFor()
 * happens to be asked about the session again before then -- so a session id
 * nothing ever replies to, and nothing ever asks about, does not sit in this
 * map for the life of the app (#588 review D1).
 */
export const UNCLAIMED_ASK_GRACE_MS = 60_000

type PendingAsk = Extract<OpenCodePermissionPush, { kind: 'asked' }>

interface OpenAsk {
  askedAt: number
  ask: PendingAsk
}

export interface OpenCodePermissionRegistryOptions {
  /** Injected so the grace window is measured against a test's own clock. */
  now: () => number
}

/**
 * Which OpenCode sessions have a permission ask outstanding, keyed by
 * sessionId exactly as PermissionPromptRegistry keys Claude's -- the Claude
 * hook precedent this mirrors (#203, #588 T3).
 *
 * `buildOpenCodePermissionPush` forwards only 'asked' and 'replied' pushes
 * (permissionPushPayload.ts), so the vocabulary here is closed: an 'asked'
 * push opens (or replaces) the session's pending entry, and a 'replied' push
 * closes it -- but only when its requestId matches the pending ask's. A
 * mismatch means a second ask already replaced the first one this registry
 * held; the stale reply must never clear the newer ask in its place.
 *
 * This registry sweeps its own bound: observe() walks the whole pending map
 * on the schedule UNCLAIMED_ASK_GRACE_MS names, mirroring
 * permissionPrompts.ts's own observe() -- the difference is this one has no
 * poll board to reconcile against yet, so every entry ages out on time alone
 * rather than being confirmed against a session still on screen (#588 review
 * D1). Nothing constructs this registry in production yet; whichever later
 * slice (#588 T4) does still owes it two things: calling observe() from the
 * poll chain, the way runtime.ts already drives the Claude registry's own
 * observe(), and forget() on session end.
 */
export class OpenCodePermissionRegistry {
  private readonly pending = new Map<string, OpenAsk>()
  private readonly now: () => number

  constructor(options: OpenCodePermissionRegistryOptions) {
    this.now = options.now
  }

  /** Read one push: 'asked' opens/replaces the session's entry, 'replied' closes it. */
  note(push: OpenCodePermissionPush): void {
    if (push.kind === 'asked') {
      const current = this.pending.get(push.sessionId)
      // Idempotent on the same requestId, mirroring
      // PermissionPromptRegistry.note(): several tool calls in one assistant
      // message, or a plugin retrying delivery, can each re-raise the same
      // permission.asked for one ask, and a re-raise must not restart the
      // grace clock -- that would let a session nothing ever replies to keep
      // postponing its own sweep forever (#588 review D2, compounds D1). A
      // genuinely NEW requestId for this session is a different ask and does
      // replace the entry, taking a fresh clock with it.
      if (current !== undefined && current.ask.requestId === push.requestId) return
      this.pending.set(push.sessionId, { askedAt: this.now(), ask: push })
      return
    }
    const current = this.pending.get(push.sessionId)
    if (current !== undefined && current.ask.requestId === push.requestId) {
      this.pending.delete(push.sessionId)
    }
  }

  /**
   * Prune every pending ask past its grace window, walking the whole map --
   * mirrors PermissionPromptRegistry.observe() in hooks/permissionPrompts.ts,
   * which is what makes that registry's own bound real rather than merely
   * described (#588 review D1). This registry has no poll board to reconcile
   * against yet (see the class doc), so every entry here ages out on time
   * alone; #588 T4 still owes calling this from the poll chain, and forget()
   * on session end.
   */
  observe(): void {
    const now = this.now()
    for (const [sessionId, ask] of this.pending) {
      if (now - ask.askedAt >= UNCLAIMED_ASK_GRACE_MS) this.pending.delete(sessionId)
    }
  }

  /** The pending ask for a session, or undefined once it is answered, replaced, or aged out. */
  askFor(sessionId: string): PendingAsk | undefined {
    const current = this.pending.get(sessionId)
    if (current === undefined) return undefined
    if (this.now() - current.askedAt >= UNCLAIMED_ASK_GRACE_MS) {
      this.pending.delete(sessionId)
      return undefined
    }
    return current.ask
  }

  /** Whether a session has a pending ask right now. */
  isOpen(sessionId: string): boolean {
    return this.askFor(sessionId) !== undefined
  }

  /** Drop a session's pending ask outright, for a later slice to call once it learns the session ended. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /** Entries currently held, so a test can observe the sweep's own effect without going through askFor()'s lazy prune. */
  get size(): number {
    return this.pending.size
  }
}
