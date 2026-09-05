import type { Dwarf, Mine } from '../domain/types'
import type { HookEvent } from './hookPayload'

/**
 * How long a prompt nothing on the board answers to is kept before it is
 * dropped (#203).
 *
 * A hook beats the poll: Claude Code raises `permission_prompt` the instant the
 * dialog opens, and the session behind it may not be drawn yet — a fresh
 * session's very first tool call is exactly that case. So an unmatched prompt
 * waits rather than being discarded, and it waits with a bound, because a
 * session id no dwarf ever carries would otherwise sit in this map for the life
 * of the app. A minute is far more than the two-second poll needs and far less
 * than any dialog a person leaves open.
 */
export const UNMATCHED_PROMPT_GRACE_MS = 60_000

/** Whether a permission prompt is open for that session id right now. */
export type PermissionPromptLookup = (sessionId: string) => boolean

/** One notification type, and the only one this registry reads. */
const PERMISSION_PROMPT = 'permission_prompt'

/**
 * The hook events that end a session's turn, and with it any prompt inside it.
 *
 * `SubagentStop` is deliberately absent: a subagent finishing says nothing
 * about what the main session is blocked on, and treating it as an ending
 * would clear a dialog that is still on the person's screen.
 */
const TURN_ENDED_EVENTS: readonly HookEvent['event'][] = ['Stop', 'SessionEnd']

interface OpenPrompt {
  /** When the notification arrived, for the unmatched grace above. */
  notedAt: number
  /**
   * The dwarf's `transcriptUpdatedAt` the first time this prompt's session was
   * seen on the board, or undefined when the provider stamps none. The prompt
   * closes once the transcript moves PAST it — see observe().
   */
  baseline?: number
  /** Whether the session has been drawn at all since the prompt was noted. */
  matched: boolean
}

export interface PermissionPromptRegistryOptions {
  /** Injected so the unmatched grace is measured against a test's own clock. */
  now: () => number
}

/**
 * Which observed sessions have a permission dialog open, as Claude Code's own
 * hooks report it (#203).
 *
 * ## Why a hook may say this at all
 *
 * `WaitingReason` is derived only from a provider's own structured evidence,
 * and a `permission_prompt` Notification is exactly that: Claude Code stating,
 * in a fixed vocabulary of its own, that a permission dialog is open for that
 * `session_id`. Nothing here reads prose, and nothing here infers a prompt from
 * silence or from a transcript that looks like a question. The correlation is
 * the session id and nothing weaker — a notification that carried none names no
 * session, so it is dropped rather than matched by `cwd`, which two sessions in
 * one project would share.
 *
 * ## What closes it, and why there are two rules rather than one
 *
 * `Stop`/`SessionEnd` is the definitive answer and a late one: the turn ends
 * long after the dialog was answered, because the agent goes on working with
 * the tool it was allowed. A transcript that has moved PAST where it stood
 * while the prompt was open is the prompt one: answering the dialog appends the
 * `tool_result` either way, allow or deny, so the file's own mtime moving is
 * the first observable consequence of an answer.
 *
 * The transcript rule is a proxy and is documented as one. The `tool_use` block
 * is written BEFORE the dialog opens (see providers/claude/parse.ts on how the
 * tail is read), so the baseline taken on the first poll after the hook already
 * includes it and the next move is the answer's. Where that ordering does not
 * hold the rule errs EARLY — it stops claiming a prompt is open while one still
 * is — which is the direction this codebase always takes: a marker that wrongly
 * claims something is worse than one that admits it saw nothing.
 *
 * A session whose provider stamps no `transcriptUpdatedAt` has no baseline and
 * therefore no second rule; its prompt closes on the turn ending. Absence of
 * evidence is not evidence, in either direction.
 */
export class PermissionPromptRegistry {
  private readonly open = new Map<string, OpenPrompt>()
  private readonly now: () => number

  constructor(options: PermissionPromptRegistryOptions) {
    this.now = options.now
  }

  /**
   * Read one hook event. Everything that is not a permission prompt or a turn
   * ending is ignored outright — an `idle_prompt` says the session is waiting
   * on nothing in particular, and a notification type this build has never seen
   * says nothing at all.
   */
  note(event: HookEvent): void {
    const sessionId = event.sessionId
    if (sessionId === undefined) return
    if (TURN_ENDED_EVENTS.includes(event.event)) {
      this.open.delete(sessionId)
      return
    }
    if (event.event !== 'Notification' || event.notificationType !== PERMISSION_PROMPT) return
    // Idempotent on purpose: several tool calls in one assistant message each
    // raise their own notification, and a re-raised prompt must not restart the
    // baseline the first one recorded — that would postpone the close by one
    // transcript move every time the hook fires.
    if (this.open.has(sessionId)) return
    this.open.set(sessionId, { notedAt: this.now(), matched: false })
  }

  /**
   * Reconcile every open prompt against the board this poll produced: take a
   * baseline for one whose session has just appeared, close one whose
   * transcript has moved past it, and forget one nothing ever answered to.
   *
   * Called from the poll chain immediately before the stamp, so a prompt closed
   * here is never stamped on the board it was closed against.
   */
  observe(mines: Mine[]): void {
    if (this.open.size === 0) return
    const now = this.now()
    for (const [sessionId, prompt] of this.open) {
      const dwarf = foremanOf(mines, sessionId)
      if (dwarf === undefined) {
        if (now - prompt.notedAt >= UNMATCHED_PROMPT_GRACE_MS) this.open.delete(sessionId)
        continue
      }
      if (!prompt.matched) {
        prompt.matched = true
        if (dwarf.transcriptUpdatedAt !== undefined) prompt.baseline = dwarf.transcriptUpdatedAt
        continue
      }
      const moved =
        prompt.baseline !== undefined &&
        dwarf.transcriptUpdatedAt !== undefined &&
        dwarf.transcriptUpdatedAt > prompt.baseline
      if (moved) this.open.delete(sessionId)
    }
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }
}

/** The main session's own dwarf for that session id, or undefined. */
function foremanOf(mines: Mine[], sessionId: string): Dwarf | undefined {
  for (const mine of mines) {
    for (const dwarf of mine.dwarfs) {
      if (dwarf.role === 'foreman' && dwarf.sessionId === sessionId) return dwarf
    }
  }
  return undefined
}

/**
 * Copy `mines` with `waitingReason: 'approval'` on the foreman of every session
 * a permission dialog is open for (#203).
 *
 * Only the foreman, never a worker sharing its session id — the same trap
 * `stampHeldQuestions` names, for the same reason: a Claude subagent carries
 * its foreman's `sessionId`, so keying on the id alone would mark every dwarf
 * in the session as the one being asked.
 *
 * Additive only, unlike the held stamps around it. Those supersede the
 * provider's reading because a held stream is the complete truth about that
 * session; this is a second observer of a session somebody else is running, so
 * it may name a condition the provider left unnamed and may never take one
 * away. In particular it never overwrites `'user-input'`, which is the one
 * value carrying a behavioural promise (eviction is suspended while it stands),
 * and it does replace `'unknown'` — "blocked, and the condition is not one this
 * app can read" is exactly what a second structured proof is allowed to refine,
 * and is what Claude's own `dialog open` registry value produces.
 *
 * `status` is left exactly as the provider read it. The hook says what the
 * session is blocked ON; whether it is blocked at all is the provider's own
 * finding, and the two facts keep their own sources here as everywhere else.
 */
export function stampPermissionPrompts(mines: Mine[], isOpen: PermissionPromptLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      if (dwarf.waitingReason === 'user-input' || dwarf.waitingReason === 'approval') return dwarf
      if (!isOpen(dwarf.sessionId)) return dwarf
      return { ...dwarf, waitingReason: 'approval' }
    })
  }))
}
