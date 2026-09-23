import type { OpenCodePermissionPush } from './permissionPushPayload'

/**
 * How long a pending OpenCode ask NOBODY HAS EVER SEEN is kept before it is
 * dropped -- mirrors UNMATCHED_PROMPT_GRACE_MS in hooks/permissionPrompts.ts,
 * and for the same reason: a push can reach this registry before whatever
 * later consults it (#588 T4) has even drawn the session it names, so an
 * unclaimed ask waits rather than being discarded. The bound is real because
 * observe() sweeps the whole map on this schedule -- not because askFor()
 * happens to be asked about the session again before then -- so a session id
 * nothing ever replies to, and nothing ever draws, does not sit in this map
 * for the life of the app (#588 review D1).
 *
 * AMENDED for #588 review F1/F3: this window governs a NEVER-DRAWN ask only.
 * Once `askFor()` has handed an ask to a real dwarf at least once, it stops
 * being "unclaimed" in the sense this constant names, and a clock stops
 * being the right thing to judge it by at all -- see the class doc's own
 * lifecycle section.
 */
export const UNCLAIMED_ASK_GRACE_MS = 60_000

/**
 * Exported for the one consumer outside this file: `opencodeProvider.ts`
 * (#588 T4) reads `askFor()`'s return to build `DwarfPermissionRequest`
 * field by field, and needs a name for the shape to type that seam with.
 */
export type PendingAsk = Extract<OpenCodePermissionPush, { kind: 'asked' }>

interface OpenAsk {
  askedAt: number
  ask: PendingAsk
  /**
   * Whether `askFor()` has ever handed this ask to a real dwarf (#588 review
   * F1/F3) -- the one fact that decides which half of the lifecycle below
   * applies. Starts false on every fresh entry, including one that REPLACES
   * a drawn ask: a new requestId is a different ask nobody has seen yet,
   * whatever became of the one it replaced.
   */
  drawn: boolean
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
 * ## The lifecycle has two halves, told apart by whether the ask was DRAWN
 *
 * REWRITTEN for #588 review F1/F3, which is the same defect told twice: the
 * bound this class describes must apply to an ask nobody has ever put in
 * front of a person, and must stop applying the moment one has. The old text
 * here (review D1) said every entry ages out on time alone "rather than
 * being confirmed against a session still on screen" — true when this class
 * was written, and wrong from the moment T4 wired `askFor()` into a real
 * dwarf: that IS a session on screen, and this registry can and must
 * confirm against it.
 *
 * - **Never drawn** (`askFor()` has not yet returned this ask to a caller):
 *   ages out on `UNCLAIMED_ASK_GRACE_MS` alone, exactly as before. Nothing
 *   about the published board can end it early, because absence from a
 *   poll's board proves nothing here — the plugin's push can beat the scan
 *   by more than one poll (a session row not yet readable, a transiently
 *   locked `opencode.db`), and a session id no dwarf has EVER carried is the
 *   one case this window exists to bound.
 * - **Drawn** (`askFor()` has returned it at least once, meaning
 *   `opencodeProvider.ts` attached it to a real dwarf on some poll): stops
 *   aging on any clock. `observe()` skips it outright. It ends only two
 *   ways: a matching `permission.replied` through `note()`, or its session
 *   leaving the published board — which for a DRAWN ask is positive proof of
 *   an ending, the same standing `!state.running` has for a hosted process
 *   in runtime.ts. `drawnSessionIds()` below is what lets that board check
 *   see which asks now qualify for it; `pendingSessionIds()` still answers
 *   for every pending ask, drawn or not, since #588 T4's own dead-session
 *   forget-sweep is not the only reason to enumerate this map.
 *
 * Constructed once, in AgentRuntime's own constructor beside
 * PermissionPromptRegistry (runtime.ts, #588 T4). `observe()` runs on the
 * same poll chain that drives the Claude registry's own; `forget()` runs
 * against `drawnSessionIds()` the instant one of THOSE sessions leaves the
 * published board -- see runtime.ts's own hosted-process-forget precedent.
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
      // replace the entry, taking a fresh clock AND a fresh, undrawn state
      // with it (#588 review F1/F3) -- nobody has seen THIS ask yet, whatever
      // became of the one it replaced.
      if (current !== undefined && current.ask.requestId === push.requestId) return
      this.pending.set(push.sessionId, { askedAt: this.now(), ask: push, drawn: false })
      return
    }
    const current = this.pending.get(push.sessionId)
    if (current !== undefined && current.ask.requestId === push.requestId) {
      this.pending.delete(push.sessionId)
    }
  }

  /**
   * Prune every NEVER-DRAWN ask past its grace window, walking the whole map
   * -- mirrors PermissionPromptRegistry.observe() in hooks/permissionPrompts.
   * ts, which is what makes that registry's own bound real rather than
   * merely described (#588 review D1). A DRAWN ask is skipped outright
   * (#588 review F1/F3): it no longer ages on any clock, and only
   * runtime.ts's own board-absence sweep (over `drawnSessionIds()`) or a
   * matching reply through `note()` may end it now — see the class doc's
   * lifecycle section.
   */
  observe(): void {
    const now = this.now()
    for (const [sessionId, ask] of this.pending) {
      if (ask.drawn) continue
      if (now - ask.askedAt >= UNCLAIMED_ASK_GRACE_MS) this.pending.delete(sessionId)
    }
  }

  /**
   * The pending ask for a session, or undefined once it is answered,
   * replaced, or aged out.
   *
   * This is also the ONE place an ask becomes DRAWN (#588 review F1/F3):
   * `opencodeProvider.ts` calls this only while actually attaching the ask
   * to a real dwarf's `publish()` pass, so a defined return here IS the
   * "seen on a dwarf" event this class's lifecycle is keyed on. A
   * never-drawn ask still takes its lazy prune against the grace window
   * exactly as before; once marked drawn, later calls return it
   * unconditionally, whatever the clock says.
   */
  askFor(sessionId: string): PendingAsk | undefined {
    const current = this.pending.get(sessionId)
    if (current === undefined) return undefined
    if (!current.drawn) {
      if (this.now() - current.askedAt >= UNCLAIMED_ASK_GRACE_MS) {
        this.pending.delete(sessionId)
        return undefined
      }
      current.drawn = true
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

  /**
   * Every session id this registry is holding a pending ask for right now
   * (#588 T4), drawn or not — the general-purpose way to enumerate this map
   * from outside it. NOT what the poll's board-absence forget-sweep should
   * walk since #588 review F1: that must act only on a DRAWN ask, or it
   * forgets a session the board never had a chance to draw at all. See
   * `drawnSessionIds()`.
   */
  pendingSessionIds(): readonly string[] {
    return [...this.pending.keys()]
  }

  /**
   * Every session id this registry holds a DRAWN pending ask for (#588
   * review F1/F3) — what runtime.ts's own forget-sweep walks now, in place
   * of `pendingSessionIds()`: board-absence is positive proof of an ending
   * only for an ask that has actually been shown, the same distinction the
   * class doc's lifecycle section draws. A never-drawn ask never appears
   * here; it ages out through `observe()`'s clock alone.
   */
  drawnSessionIds(): readonly string[] {
    return [...this.pending.entries()]
      .filter(([, ask]) => ask.drawn)
      .map(([sessionId]) => sessionId)
  }
}
