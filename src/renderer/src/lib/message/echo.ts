import { REACTION_WINDOW_MS } from '../delivery/reaction'
import { normalizeConsoleText } from '../../../../shared/consoleText'
import {
  stripRelayProvenance,
  type DwarfAttachment,
  type DwarfSendState,
  type FeedMessage
} from '../../types'
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
 * The console's own marker for one pasted image, whatever digit Claude
 * Code's own session counter assigned it (#408, measured in
 * docs/console-hosting.md §6) — never a number this app predicts, only a
 * shape it recognizes. Not anchored to the start of the string: reopened by
 * #419, the placeholder is inserted at the cursor only once Claude Code
 * finishes READING the pasted file, while a plain path or the words that
 * follow paste in immediately — so its position in the row depends on how
 * long that read took, not on when the image was attached. A slow read can
 * land it after a later attachment's own token, or after the words entirely
 * (see `stripAttachmentTokens`).
 */
const IMAGE_MARKER_RE = /\[Image #\d+\]/

/**
 * `text` with one literal token per entry of `attachments` removed, each
 * taken off once from wherever it landed — undefined the moment one is
 * missing.
 *
 * A file's token is its exact path, matched as a plain substring anywhere in
 * the row; an image's is one `[Image #<digits>]` occurrence, matched
 * anywhere by the one shape-anchored pattern above because the digits are
 * Claude Code's own counter and never predictable. Position is deliberately
 * not part of the match — #419 was reopened exactly because the first fix
 * stripped tokens in send order, and the placeholder's own position moves
 * with how long its image took to read, independent of the other pastes.
 * Neither token is a search over the WORDS that remain once every token is
 * off — those are compared by plain equality in `accountsFor`, never by
 * pattern, and normalized again there since a token taken off the middle of
 * the row can leave a whitespace gap the words never had.
 *
 * File paths come off before image markers, on purpose: a path is removed by
 * an exact substring match regardless of what it contains, so a path that
 * happens to itself contain something shaped like `[Image #5]` is gone as
 * one whole unit before the marker search ever runs over the row. Searching
 * for markers first would risk matching that fragment inside a path still
 * sitting in the text and cutting it in half.
 */
function stripAttachmentTokens(
  text: string,
  attachments: readonly DwarfAttachment[]
): string | undefined {
  let rest = text
  for (const attachment of attachments) {
    if (attachment.kind === 'image') continue
    const at = rest.indexOf(attachment.path)
    if (at === -1) return undefined
    rest = rest.slice(0, at) + rest.slice(at + attachment.path.length)
  }
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue
    const marker = IMAGE_MARKER_RE.exec(rest)
    if (marker === null) return undefined
    rest = rest.slice(0, marker.index) + rest.slice(marker.index + marker[0].length)
  }
  return rest
}

/**
 * Whether `message` is evidence that `echo` reached the session's transcript.
 *
 * Four conditions, and all four are required, because dropping an echo is
 * throwing away the only copy of the person's words this panel holds:
 *
 * - the same words, normalized — see below;
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
 * **The words are normalized the way the console itself flattens a message**
 * (`normalizeConsoleText`, shared with `sendKeys.ts`'s `toConsoleLine`), not by
 * `.trim()` alone (#419): a message typed with Shift+Enter reaches the
 * transcript as one line, whitespace runs collapsed, while the echo the panel
 * is still holding keeps its own newlines. Comparing both sides through the
 * same rule the console applies is what lets them still read as equal, and it
 * changes nothing for a plain one-line message — a string with no internal
 * whitespace run normalizes to itself.
 *
 * The words are compared past the relay's provenance line (#378), taken off
 * before normalizing. A message the relay carries is prefixed with a line
 * naming its author, and the transcript reader takes it off before publishing
 * the row — this is the second place it has to come off, because an echo that
 * never matches its own row is the person's message drawn twice with a ✓ that
 * can never reach ✓✓. Only that one known line: `[for agent <name>] ` stays in
 * the comparison, since it names the recipient and the composer never typed
 * it.
 *
 * **`attachments` are this ECHO's own files** (#408) — `useDwarfMessaging`
 * keeps them keyed by echo id, since attachments play no part in an ordinary
 * text-only send. A row is expected to carry each attachment's token exactly
 * once, wherever it landed — never assumed to be in send order, and never
 * assumed to sit ahead of the words, because an image's placeholder is only
 * inserted once Claude Code finishes reading that file and can end up
 * anywhere relative to the rest (`stripAttachmentTokens`, #419 reopened). A
 * row missing even one token never accounts for this echo, and an
 * attachments-only echo (no words at all) matches a row that is exactly those
 * tokens. See docs/console-hosting.md §6 for the transcript shape this was
 * measured against.
 */
function accountsFor(
  echo: MessageEcho,
  message: FeedMessage,
  attachments: readonly DwarfAttachment[]
): boolean {
  if (message.role !== 'user' || message.issuer !== undefined) return false
  const stripped = stripAttachmentTokens(
    normalizeConsoleText(stripRelayProvenance(message.text)),
    attachments
  )
  // Normalized again: a token can now come out of the middle of the row
  // (or off the end) rather than only the front, and closing the gap that
  // leaves is exactly what `normalizeConsoleText` already does for the
  // console's own whitespace runs.
  if (stripped === undefined || normalizeConsoleText(stripped) !== normalizeConsoleText(echo.text))
    return false
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
 *
 * `attachmentsByEchoId` is each held echo's own files, keyed by echo id —
 * `useDwarfMessaging`'s `echoAttachments` (#408), passed straight through
 * rather than folded into `MessageEcho` itself, since that shape is
 * `useDwarfMessaging`'s and reconciling is the only thing this module does
 * with it. Defaulted to `{}` so every caller from before #419 — and every
 * plain text-only send today — reads as "no attachments", exactly the shape a
 * message without any already took.
 */
export function reconcileEchoes(
  echoes: readonly MessageEcho[],
  messages: readonly FeedMessage[],
  attachmentsByEchoId: Readonly<Record<string, readonly DwarfAttachment[]>> = {}
): MessageEcho[] {
  const kept = [...echoes]
  for (const message of messages) {
    const index = kept.findIndex((echo) =>
      accountsFor(echo, message, attachmentsByEchoId[echo.id] ?? [])
    )
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
