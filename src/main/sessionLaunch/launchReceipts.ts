import type { Dwarf, DwarfProvider, Mine } from '../domain/types'

/**
 * Which dwarf on the board is the session the Add Panel launched, proved from
 * the session's own words (#191).
 *
 * ## The gap this closes
 *
 * The panel recognises its own launch by EVIDENCE rather than by timing, and
 * until now there was exactly one kind of evidence: a HELD session, whose
 * conversation the registry seeds with the prompt that was sent, so the first
 * message of a held exchange is the receipt (see the renderer's
 * launchArrival.ts). A DETACHED launch — every Codex launch, and a headless
 * `claude -p` — leaves no conversation, so nothing could ever be matched to
 * it: the panel stopped at "the session started" and never handed over, even
 * though its dwarf was on the board, had replied, and had left again.
 *
 * The third source the rule had not used is the provider's own transcript. A
 * launch writes its prompt to the child's stdin, and the child records that
 * prompt as the first thing a human said in the session. So the SAME match
 * runs — first human turn equals the prompt this launch sent — against the
 * observed store instead of a held stream.
 *
 * ## Why the match happens here and not in the renderer
 *
 * The alternative was to publish each dwarf's first user message on the wire
 * and let the panel compare. It is the larger of the two: the poll reads a
 * bounded TAIL, which for any session of length does not contain the first
 * message at all, so main would have to do this same head read either way —
 * and it would then have to redact what it published, because everything the
 * renderer draws is redacted, while the panel's own copy of the prompt is not.
 * Two spellings of one string, compared for equality. Here both sides are raw,
 * both are main's, and the renderer never holds the user's text at all.
 *
 * ## Not the same claim as the kill register
 *
 * `LaunchedSessionRegistry` (#217) also decides which session a launch became,
 * and deliberately keeps its own answer. That one exists to end a process:
 * it claims "the first session root of this provider that was not on the board
 * before", refuses a 'leaving' dwarf because a departed session's retained pid
 * is stale, and is right to. This one has to admit a leaving dwarf — a session
 * that finished before the poll first drew it is the case the panel most needs
 * to open on. Two questions, two answers, and neither is safe as the other's.
 *
 * AMENDED for #263. This paragraph used to end "and it will not claim on
 * absence of a prior sighting at all", and the half of that sentence which
 * still holds is the half that matters: absence claims NOBODY here — the words
 * are the whole proof, and a session nobody had seen whose prompt does not
 * match gets no receipt. What was wrong was reading it as "prior sightings are
 * none of this registry's business". Presence at issue time is not evidence of
 * a claim, it is a DISQUALIFICATION: a session already on the board when the
 * prompt was sent cannot be the session that prompt started, whatever it opened
 * with. Without that, launching Codex in a folder that already held a Codex
 * session claimed the OLD dwarf — a relaunch is usually the same words, and
 * candidates are ordered by id, which for Codex is a chronological uuid-v7 —
 * and the panel opened on it, so the session that had just started read as one
 * that never started at all (#263).
 */

/** What a launch leaves behind for its dwarf to be recognised by. */
export interface LaunchReceiptRequest {
  provider: DwarfProvider
  /** The mine's folder, exactly as the launch was given it. */
  minePath: string
  /** The prompt exactly as it went to the child's stdin, trimmed and capped. */
  prompt: string
  /**
   * Every session id already on the board when the launch was made (#263).
   *
   * A session in this list predates the prompt, so it cannot be the session
   * the prompt started — whatever it opened with, and whatever folder it turns
   * up in. Stated by the caller rather than remembered here, exactly as
   * `RetainLaunchRequest.knownSessionIds` is, because the board is the
   * runtime's and a launch is decided against the board it was made on.
   */
  knownSessionIds: readonly string[]
}

export interface LaunchReceiptOptions {
  /**
   * The first thing a person said in that dwarf's own session, off the head of
   * the provider's store (see providers/firstPrompt.ts). Undefined means the
   * session has recorded no human turn yet, OR that nothing could be read —
   * and neither is a mismatch.
   */
  firstPrompt: (dwarf: Dwarf) => Promise<string | undefined>
  log?: (message: string) => void
}

/**
 * How many polls one dwarf is asked for its opening prompt before it is left
 * alone.
 *
 * A single read is not enough: a store exists from the moment the CLI opens
 * it, and the first prompt lands in it a beat later, so the poll that first
 * draws the dwarf can genuinely be too early. Asking forever is the other
 * failure — a session in the same folder that never says anything a human
 * typed would cost a head read on every poll for as long as the launch waits.
 * A handful of tries covers the write and bounds the cost; the moment a
 * session says ANYTHING, matching or not, it is never asked again.
 */
export const FIRST_PROMPT_READ_ATTEMPTS = 5

interface LaunchRecord {
  launchId: string
  provider: DwarfProvider
  minePath: string
  prompt: string
  /** Frozen at issue time: the sessions this launch may never claim (#263). */
  knownSessionIds: Set<string>
  /** The dwarf this launch turned out to be, once one has been proved. */
  dwarfId?: string
}

export class LaunchReceiptRegistry {
  private readonly launches = new Map<string, LaunchRecord>()
  /** dwarfId -> launchId, the answer the board is stamped from. */
  private readonly claimed = new Map<string, string>()
  /** dwarfId -> its opening prompt, or null for "asked, and it had said nothing". */
  private readonly opened = new Map<string, string | null>()
  private readonly attempts = new Map<string, number>()
  private readonly firstPrompt: (dwarf: Dwarf) => Promise<string | undefined>
  private readonly log: (message: string) => void
  private observing = false
  private sequence = 0

  constructor(options: LaunchReceiptOptions) {
    this.firstPrompt = options.firstPrompt
    this.log = options.log ?? ((): void => {})
  }

  /** Open a receipt for a launch, and answer with the id the panel waits on. */
  issue(request: LaunchReceiptRequest): string {
    this.sequence += 1
    const launchId = `receipt:${this.sequence}`
    // Copied into a Set here, so a board that moves on cannot change what this
    // launch was allowed to claim.
    this.launches.set(launchId, {
      launchId,
      provider: request.provider,
      minePath: request.minePath,
      prompt: request.prompt,
      knownSessionIds: new Set(request.knownSessionIds)
    })
    return launchId
  }

  /**
   * Fold one poll's board in, proving a session for every launch still waiting.
   *
   * Asynchronous, and the caller does not wait for it: reading a transcript
   * head is disk work, and the poll callback is the thread the panel paints
   * from. So a launch is proved DURING one poll and stamped on the next, which
   * costs the handover one sweep and is the price of never reading a
   * transcript on the poll's own budget.
   *
   * Re-entrant calls are dropped rather than queued. Polls are every two
   * seconds and a read can outlast one; two passes over the same waiting
   * launch could otherwise claim two dwarfs for it.
   */
  async observe(mines: readonly Mine[]): Promise<void> {
    if (this.observing) return
    this.observing = true
    try {
      for (const launch of this.launches.values()) {
        if (launch.dwarfId !== undefined) continue
        const mine = mines.find((item) => item.path === launch.minePath)
        if (mine === undefined) continue
        // Sorted before anything is read, so the tie between two sessions with
        // identical opening prompts breaks on id — the same rule, and for the
        // same reason, as the renderer's own launchedDwarfIn: the answer must
        // not depend on the order one poll happened to list them in.
        const candidates = mine.dwarfs
          .filter(
            (dwarf) =>
              dwarf.provider === launch.provider &&
              // A spawned agent is a child of a session, never the session a
              // launch started — and a Codex child thread is a FORK, so it
              // carries the human's original prompt in its own rollout (#218).
              // Absent means root (see Dwarf.parentId).
              dwarf.parentId === undefined &&
              // Already on the board when this launch was made, so it predates
              // the prompt and cannot be what the prompt started (#263). The
              // one guard this shares with the kill register, and for the same
              // reason: matching words cannot separate a relaunch from the
              // session it was relaunched after.
              !launch.knownSessionIds.has(dwarf.sessionId) &&
              !this.claimed.has(dwarf.id)
          )
          .sort((left, right) => left.id.localeCompare(right.id))
        for (const candidate of candidates) {
          const opened = await this.openingPromptOf(candidate)
          if (opened !== launch.prompt) continue
          launch.dwarfId = candidate.id
          this.claimed.set(candidate.id, launch.launchId)
          this.log(`[receipt] ${launch.launchId} is ${candidate.id}`)
          break
        }
      }
    } finally {
      this.observing = false
    }
  }

  /** The launch this dwarf was proved to be, or undefined for every other dwarf. */
  receiptOf(dwarfId: string): string | undefined {
    return this.claimed.get(dwarfId)
  }

  /**
   * What this session opened with, read at most once it has said anything.
   *
   * Null is the remembered "asked, and it had said nothing", which is why it
   * is distinct from an absent entry: it permits another attempt, and it never
   * equals a prompt, so it can never claim anybody.
   */
  private async openingPromptOf(dwarf: Dwarf): Promise<string | null> {
    const known = this.opened.get(dwarf.id) ?? null
    if (known !== null) return known
    const attempts = this.attempts.get(dwarf.id) ?? 0
    if (attempts >= FIRST_PROMPT_READ_ATTEMPTS) return null
    this.attempts.set(dwarf.id, attempts + 1)
    // A read that threw said nothing about this session, exactly as a read
    // that came back empty did. Never a mismatch, and never a rejection with
    // nobody left to catch it.
    const opened = await this.firstPrompt(dwarf).catch(() => undefined)
    // Trimmed on both sides and compared for exact equality, and nothing
    // looser: the prompt was trimmed on its way to the child, and a CLI is
    // free to add a newline of its own when it writes the turn down.
    const value = opened?.trim() ?? ''
    const answer = value === '' ? null : value
    this.opened.set(dwarf.id, answer)
    return answer
  }
}

/**
 * Put every proved receipt onto the board, so the panel can recognise its own
 * launch from the snapshot it already receives.
 *
 * Only ever ADDS: a dwarf nobody here launched comes back exactly as it went
 * in, which is every dwarf on an ordinary machine.
 */
export function stampLaunchReceipts(
  mines: readonly Mine[],
  receiptOf: (dwarfId: string) => string | undefined
): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      const launchId = receiptOf(dwarf.id)
      return launchId === undefined ? dwarf : { ...dwarf, launchId }
    })
  }))
}
