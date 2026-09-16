import { REACTION_WINDOW_MS } from '../delivery/reaction'
import { normalizeConsoleText } from '../../../../shared/consoleText'
import { ATTACHED_FILE_PREFIX, HELD_IMAGE_PLACEHOLDER } from '../../../../shared/heldSessionText'
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
 * One expected attachment token, generalized over the two shapes a row can
 * carry it in (#424) — a LITERAL string taken off by an exact substring
 * match (a file's token on either channel, and a held image's — which is
 * none at all, so it contributes no entry here), or a PATTERN taken off by
 * regex (a console image's `[Image #N]`, the one case a literal string can
 * never express since the digits are Claude Code's own counter).
 *
 * One mechanism for both channels: `expectedTokensFor` is the only place that
 * decides WHICH shape a given attachment becomes; `stripAttachmentTokens`
 * below never again asks what channel it is removing a token for.
 */
type AttachmentToken = { kind: 'literal'; value: string } | { kind: 'pattern'; re: RegExp }

/**
 * The tokens `text` must carry, one per entry of `attachments`, for the
 * channel named by `via` — `echo.state.via`, the same field the sprite
 * marker already reads (#309).
 *
 * `'held-session'` is the one channel measured to look different
 * (`heldMessageEntries`, pinned in heldSession.test.ts, off what
 * `heldContentFor` in attachmentDelivery.ts actually builds): a non-image is
 * named on its own line, `Attached file: <path>` — the exact prefix that
 * module writes, shared rather than retyped (see shared/heldSessionText.ts)
 * — and an image is the fixed word `[Image]` (#424, second pass), since the
 * held stream carries no per-image counter the way a console's own
 * `[Image #N]` does. Both are LITERAL tokens here, never a pattern: unlike
 * the console's marker, `[Image]` never varies, so an exact substring match
 * is enough. Every other channel, and an echo with no `via` recorded at all
 * (minted before this field existed, or never reaching a channel that was
 * ever measured taking any shape but the console's), falls back to the
 * console shape #419 established.
 */
function expectedTokensFor(
  via: string | undefined,
  attachments: readonly DwarfAttachment[]
): AttachmentToken[] {
  if (via === 'held-session') {
    return attachments.map((attachment) => ({
      kind: 'literal',
      value:
        attachment.kind === 'image'
          ? HELD_IMAGE_PLACEHOLDER
          : `${ATTACHED_FILE_PREFIX}${attachment.path}`
    }))
  }
  return attachments.map((attachment) =>
    attachment.kind === 'image'
      ? { kind: 'pattern', re: IMAGE_MARKER_RE }
      : { kind: 'literal', value: attachment.path }
  )
}

/**
 * `text` with one `token` removed, each taken off once from wherever it
 * landed — undefined the moment one is missing.
 *
 * Position is deliberately not part of the match — #419 was reopened exactly
 * because the first fix stripped tokens in send order, and a console image's
 * placeholder position moves with how long its read took, independent of the
 * other pastes. Neither kind of token is a search over the WORDS that remain
 * once every token is off — those are compared by plain equality in
 * `accountsFor`, never by pattern, and normalized again there since a token
 * taken off the middle of the row can leave a whitespace gap the words never
 * had.
 *
 * LITERAL tokens come off before PATTERN ones, on purpose: a literal is
 * removed by an exact substring match regardless of what it contains, so one
 * that happens to itself contain something shaped like `[Image #5]` is gone
 * as one whole unit before the pattern search ever runs over the row.
 * Searching for a pattern first would risk matching that fragment inside a
 * literal still sitting in the text and cutting it in half.
 */
function stripAttachmentTokens(
  text: string,
  tokens: readonly AttachmentToken[]
): string | undefined {
  let rest = text
  for (const token of tokens) {
    if (token.kind !== 'literal') continue
    const at = rest.indexOf(token.value)
    if (at === -1) return undefined
    rest = rest.slice(0, at) + rest.slice(at + token.value.length)
  }
  for (const token of tokens) {
    if (token.kind !== 'pattern') continue
    const marker = token.re.exec(rest)
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
 * **A held row is compared by plain equality, same as an observed one** (#436
 * removed the store's own cut — see `retainHeldMessage` in heldSession.ts —
 * along with the branch that used to match a truncated row here,
 * `isHeldTruncationOf`; a held row is now exactly the words the session said).
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
 *
 * Which tokens a row is expected to carry now depends on how THIS message was
 * sent (#424) — `echo.state.via` picks the shape (`expectedTokensFor`), since
 * a session held over the Agent SDK writes its own user turn nothing like a
 * console does. Reading `via` off the echo rather than off `message` is
 * deliberate: the transcript row is what is being judged, not what is doing
 * the judging, and a channel is a fact about how the person's own words were
 * sent, never about the row they are being compared to.
 */
function accountsFor(
  echo: MessageEcho,
  message: FeedMessage,
  attachments: readonly DwarfAttachment[]
): boolean {
  if (message.role !== 'user' || message.issuer !== undefined) return false
  const stripped = stripAttachmentTokens(
    normalizeConsoleText(stripRelayProvenance(message.text)),
    expectedTokensFor(echo.state.via, attachments)
  )
  if (stripped === undefined) return false
  // Normalized again: a token can now come out of the middle of the row
  // (or off the end) rather than only the front, and closing the gap that
  // leaves is exactly what `normalizeConsoleText` already does for the
  // console's own whitespace runs.
  const words = normalizeConsoleText(stripped)
  if (words !== normalizeConsoleText(echo.text)) return false
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
