import { REACTION_WINDOW_MS } from '../delivery/reaction'
import { stripRelayProvenance, type DwarfSendState, type FeedMessage } from '../../types'
import type { PanelEntry } from './activityGroup'
import type { PanelMessage } from './conversation'

/**
 * The message the person just sent, drawn before anything has answered (#309).
 *
 * The panel promised a conversation and used to swallow half of it: a send
 * shows up only once the SESSION's own transcript carries it, which for an
 * observed session is a poll or two later and for a slow channel not until the
 * agent has acted. So the words are drawn immediately, from here, and the
 * transcript takes over when it arrives.
 *
 * ## What an echo claims, and what it does not
 *
 * Nothing new. An echo carries a `DwarfSendState` verbatim — the same
 * two-phase verdict the sprite marker in the shell already draws, through the
 * same `sendMarker` copy — so the tick on the bubble says exactly what the
 * marker on the dwarf says and never more: `…` while it is in flight, one tick
 * when the text reached the session's QUEUE, two only when the session was
 * seen acting, ✕ with the reason when it never left. The "delivered and
 * reacted are different facts" invariant is untouched, and deliberately: this
 * feature moves a verdict next to the words it is about, it does not soften
 * one.
 *
 * ## Why an id this app minted
 *
 * `DwarfSendState` is one verdict per dwarf, which is right for the sprite —
 * a dwarf has one latest verdict — and cannot say which of three messages
 * failed. The wire carries no message id (nothing on it is about a message the
 * session has not recorded yet), so the id is minted here at the moment Enter
 * is pressed and is the only handle the store, the bubble and the retry
 * control share.
 *
 * Renderer-only, and it stays that way: nothing about an echo crosses a
 * process. The per-dwarf verdict the shell reads is unchanged (see
 * DwarfDeliveryReport).
 */
export interface MessageEcho {
  /** Client-minted at send time. The wire has no id for a message it has not seen. */
  readonly id: string
  /** Exactly the text that was handed to the channel. */
  readonly text: string
  /** When Enter was pressed — what a transcript row's own stamp is measured against. */
  readonly sentAt: number
  /** This one message's verdict, in the same shape and phases the sprite marker reads. */
  readonly state: DwarfSendState
}

/**
 * One row of the panel's conversation.
 *
 * `echo` is present only on a row this panel is still holding on the person's
 * behalf; a row read off a transcript never has one, which is what the bubble
 * branches on to decide whether it carries a tick at all.
 */
export interface PanelRow extends PanelMessage {
  echo?: MessageEcho
}

/**
 * How many sent messages the panel keeps drawn per dwarf.
 *
 * A bound rather than a policy: an echo lives until the transcript accounts
 * for it (see `reconcileEchoes`), and a session whose transcript this panel
 * cannot read never accounts for one — so without a cap a long afternoon of
 * talking to such a session would grow the list without end. Twenty is well
 * past the transcript tail's own dozen, so the cap is only ever reached by
 * messages nothing has confirmed.
 */
export const ECHO_LIMIT = 20

/**
 * How long after the send a transcript row may still be read as that send.
 *
 * The reaction window itself, and the same window on purpose: past it the
 * delivery store has already stopped waiting for this message to be acted on
 * (see reaction.ts), and a row that turns up later is a row about something
 * else that happens to use the same words.
 */
export const ECHO_MATCH_WINDOW_MS = REACTION_WINDOW_MS

/** The list key for an echo's row: its own id, which is the one thing unique to it. */
function rowKeyOf(echo: MessageEcho): string {
  return `echo-${echo.id}`
}

/**
 * These echoes as the rows the panel draws them: the person's own bubbles, in
 * the order they were sent.
 *
 * Deliberately never an activity row. #294 folds consecutive tool calls into a
 * disclosure, and a message somebody SAID is a bubble whatever precedes it.
 */
export function echoRowsOf(echoes: readonly MessageEcho[]): PanelRow[] {
  return echoes.map((echo) => ({
    from: 'user',
    text: echo.text,
    key: rowKeyOf(echo),
    echo
  }))
}

/**
 * The panel's entries with the pending echoes appended after them.
 *
 * After the GROUPING and not before it, which is the whole reason this takes
 * entries rather than rows: a trailing run of tool calls reads `Working...`
 * only while it is the last thing in the conversation (#294), and a message
 * the person typed is not the agent finishing its work. Slipping an echo row
 * in ahead of the grouping would close that run and put a count on it, saying
 * the agent had stopped because somebody spoke to it.
 */
export function mergeEchoes<Row extends PanelMessage>(
  entries: readonly PanelEntry<Row>[],
  echoRows: readonly Row[]
): PanelEntry<Row>[] {
  return [
    ...entries,
    ...echoRows.map((row) => ({ kind: 'message' as const, key: row.key, message: row }))
  ]
}

/**
 * Whether `message` is evidence that `echo` reached the session's transcript.
 *
 * Four conditions, and all four are required, because dropping an echo is
 * throwing away the only copy of the person's words this panel holds:
 *
 * - the same words, trimmed — the composer trims before sending, and a
 *   transcript is free to keep a newline the channel added;
 * - a `user` turn, since the agent's reply is not the person's message;
 * - **no issuer** — an agent-issued `user` turn was never the human's (#175),
 *   and a coordinator that happened to instruct its worker with the same
 *   sentence must not account for the human's;
 * - a stamp between the send and the end of the window. A row written BEFORE
 *   Enter was pressed is the transcript having said those words already, which
 *   is precisely the case an echo exists to keep separate; a row that cannot
 *   be dated at all proves nothing about when it was written, and the echo
 *   stays.
 *
 * The words are compared past the relay's provenance line (#378). A message the
 * relay carries is prefixed with a line naming its author, and the transcript
 * reader takes it off before publishing the row — this is the second place it
 * has to come off, because an echo that never matches its own row is the
 * person's message drawn twice with a ✓ that can never reach ✓✓. Only that one
 * known line: `[for agent <name>] ` stays in the comparison, since it names the
 * recipient and the composer never typed it.
 */
function accountsFor(echo: MessageEcho, message: FeedMessage): boolean {
  if (message.role !== 'user' || message.issuer !== undefined) return false
  if (stripRelayProvenance(message.text).trim() !== echo.text.trim()) return false
  const at = Date.parse(message.timestamp)
  if (Number.isNaN(at)) return false
  return at >= echo.sentAt && at - echo.sentAt <= ECHO_MATCH_WINDOW_MS
}

/**
 * The echoes still worth drawing, given the transcript as it now reads.
 *
 * One row accounts for exactly ONE echo, oldest first: the same message sent
 * twice is two echoes, and one row in the transcript is evidence of one of
 * them — crediting both to it would erase a message that has not appeared yet.
 *
 * The store keeps the answer rather than re-deriving it per render, and that is
 * the point of doing it here at all: the transcript tail is BOUNDED, so a row
 * that accounted for an echo this morning rolls off it by the afternoon, and an
 * echo re-derived from the tail alone would come back from the dead at the
 * bottom of the conversation. Dropping is a fact, and later polls do not take
 * a fact back — the same rule `observeReaction` holds to about a reaction.
 */
export function reconcileEchoes(
  echoes: readonly MessageEcho[],
  messages: readonly FeedMessage[]
): MessageEcho[] {
  const kept = [...echoes]
  for (const message of messages) {
    const index = kept.findIndex((echo) => accountsFor(echo, message))
    if (index !== -1) kept.splice(index, 1)
  }
  return kept
}

/** These echoes inside the cap, the oldest dropped first. See ECHO_LIMIT. */
export function boundEchoes(
  echoes: readonly MessageEcho[],
  limit: number = ECHO_LIMIT
): MessageEcho[] {
  return echoes.length <= limit ? [...echoes] : echoes.slice(echoes.length - limit)
}
