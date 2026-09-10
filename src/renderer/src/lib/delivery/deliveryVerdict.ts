import type { DwarfKickState, DwarfSendState } from '../../types'

/**
 * The words the panel puts on a delivery verdict (issue #21).
 *
 * The whole point of the two-phase verdict is that "delivered" and "the session
 * reacted" are different facts, so the copy has to keep them apart in plain
 * language: a ✓ says the message was HANDED to the session, a ✓✓ says the
 * session was seen ACTING on it, and a delivery whose watch window closed
 * unobserved says exactly that instead of quietly implying either one.
 *
 * Pure, so the wording is unit-tested rather than eyeballed in a component.
 */

export interface DeliveryMarker {
  /** Presentation class the sprite styles the badge with. */
  cls: string
  glyph: string
  /** The hover title — the only place the full story fits. */
  title: string
}

const HANDED_TITLE = 'Handed to the session — watching for it to react.'
const UNOBSERVED_TITLE = 'Handed to the session; no reaction seen.'
/**
 * The same hand-over, said of a message the RELAY carried (#378).
 *
 * The fact is unchanged — handed over, still watching — and the glyph with it.
 * What these two add is HOW the words arrived: Claude Code wraps a relayed
 * message in its cross-session envelope and tells the receiving agent they came
 * from another session rather than from its user, so the panel prepends a line
 * naming the author (RELAY_PROVENANCE_LINE) and says so here. An agent that may
 * treat somebody's sentence as a teammate's request rather than their own is
 * something the person should be able to read off the marker, rather than
 * discovering it from how the agent answers.
 */
const RELAY_HANDED_TITLE =
  'Handed to the session as a relayed note that names you as its author, not as a prompt you typed — watching for it to react.'
const RELAY_UNOBSERVED_TITLE =
  'Handed to the session as a relayed note that names you as its author; no reaction seen.'
const KICK_REACTED_TITLE = 'The session reacted to the kick.'
const SEND_REACTED_TITLE = 'The session reacted to the message.'
const SEND_FAILED_TITLE = 'The message could not be delivered.'
const KICK_FAILED_TITLE = 'The kick could not be delivered.'
/**
 * A kick that ENDED the session rather than asking it to stop (#217).
 *
 * Its own words because it is its own act: everywhere else `delivered` means
 * handed over and the panel goes on watching for the session to react, and
 * here there is no session left to react. Saying "watching for it to react"
 * would wait for something that cannot happen, and promoting it to ✓✓ would
 * claim a reaction from a process that is gone — the exact thing reaction.ts
 * exists to stop. So it says what happened, once, and waits for nothing.
 *
 * AMENDED for #383: the wording no longer claims "the process this panel
 * launched" — since #329 the terminal tier ends a session the panel very
 * often merely OBSERVES, so that claim was false for it. The terminal case
 * gets its own sentence for the one further fact worth saying: the process is
 * asked to exit cleanly before anything stronger (#358), so its terminal
 * survives, left at its own prompt. Every other ending channel keeps the
 * plain fact — the process is gone — which is true of all of them.
 */
function kickEndedTitle(via: string | undefined): string {
  return via === 'terminal'
    ? 'The session was ended: its terminal is left at its prompt.'
    : 'The session was ended: the process is gone.'
}

function kickEndedLine(via: string | undefined): string {
  return via === 'terminal'
    ? 'Ended the session — its terminal is left at its prompt.'
    : 'Ended the session — the process is gone.'
}

/**
 * A kick that took the dwarf off the BOARD without touching the session
 * (#293).
 *
 * The third act behind one control, and it must read as neither of the other
 * two. A hand-over says a session was asked something, and nothing was asked
 * here — nothing can interrupt this session, which is precisely why the kick
 * means "I am done with this one". "The session was ended" is a claim about a
 * process, and this makes none: for all the panel knows the session is still
 * running, and it may well be.
 *
 * So the copy says what happened and then says the one thing that undoes it.
 * That second clause is not padding: a dismissed dwarf returns the moment its
 * session shows activity (see the main process's DwarfLifecycleTracker), and
 * somebody who was not told would read that return as a bug rather than as the
 * board refusing to hide work.
 */
const KICK_DISMISSED_TITLE =
  'The dwarf was sent off the rock. It comes back if its session shows new activity.'
const KICK_DISMISSED_LINE =
  'Sent the dwarf off the rock — it comes back if the session shows new activity.'

/**
 * Channels whose kick ends the session outright rather than asking it to
 * stop. The one set both `kickEndedTheSession` and (through it)
 * `kickHasNothingToAwait` read, so the copy and the reaction watch can never
 * drift apart (#383).
 *
 * `launched-process` and `hosted-stdin` end the session because the panel is
 * the one holding the process. `terminal` joined them since #329: the tier
 * itself now ends the process it once merely interrupted (Windows clean-exit-
 * then-force #358, POSIX SIGTERM-then-SIGKILL #366), and runtime.ts retires
 * the dwarf on exactly that delivered outcome. Every other channel —
 * `claude-relay`, `foreman-relay`, `codex-queue`, `held-session` — is an ask a
 * session may or may not act on.
 */
const SESSION_ENDING_KICK_CHANNELS: ReadonlySet<string> = new Set([
  'terminal',
  'launched-process',
  'hosted-stdin'
])

/**
 * Whether a kick on this channel ends the session rather than asking it to
 * stop. Read by the copy below and by `kickHasNothingToAwait`.
 */
export function kickEndedTheSession(via: string | undefined): boolean {
  return via !== undefined && SESSION_ENDING_KICK_CHANNELS.has(via)
}

/** Whether a kick took the dwarf off the board rather than reaching a session (#293). */
export function kickDismissedTheDwarf(via: string | undefined): boolean {
  return via === 'dismiss'
}

/**
 * Whether a delivered kick has anything left to watch for.
 *
 * Two verdicts answer no, for opposite reasons: an ended session has no later
 * snapshot that could prove anything, and a dismissal asked the session
 * nothing at all. Read by the kick store, which opens no reaction watch for
 * either — a watch would decay to "no reaction seen" about a session that was
 * never asked to react.
 */
export function kickHasNothingToAwait(via: string | undefined): boolean {
  return kickEndedTheSession(via) || kickDismissedTheDwarf(via)
}

/**
 * The one control a failed message offers, on its own bubble (#309).
 *
 * Here rather than in the panel for the reason every other sentence in this
 * file is: what the app says about a delivery verdict is decided in one place
 * and unit-tested. The title is the half that carries the consequence — a
 * retry is a second delivery and the first one's ✕ stays where it is, because
 * it is the only thing on screen saying the channel let the person down once.
 */
export const SEND_AGAIN_LABEL = 'Send again'
export const SEND_AGAIN_TITLE = 'Send this message again. The one that failed stays marked.'

/**
 * Whether a message on this channel reached the session as a relayed note
 * rather than as the prompt the person typed (#378).
 *
 * One channel and not two. 'foreman-relay' names the HOP and not the tier under
 * it — on Windows a worker's message reaches its foreman by console paste,
 * which carries no provenance line at all — so claiming the framing there would
 * describe a message that was never framed as a peer's. The panel cannot tell
 * those apart from the verdict alone, and saying nothing is the honest half of
 * that: a relayed worker message keeps the plain sentence, which is true as far
 * as it goes.
 */
export function messageWasRelayed(via: string | undefined): boolean {
  return via === 'claude-relay'
}

function deliveredMarker(awaitingReaction: boolean | undefined): DeliveryMarker {
  return {
    cls: 'is-delivered',
    glyph: '✓',
    title: awaitingReaction === false ? UNOBSERVED_TITLE : HANDED_TITLE
  }
}

/** `deliveredMarker` for a relay-carried message: same glyph, fuller sentence. */
function relayedDeliveredMarker(awaitingReaction: boolean | undefined): DeliveryMarker {
  return {
    cls: 'is-delivered',
    glyph: '✓',
    title: awaitingReaction === false ? RELAY_UNOBSERVED_TITLE : RELAY_HANDED_TITLE
  }
}

function reactedMarker(title: string): DeliveryMarker {
  return { cls: 'is-reacted', glyph: '✓✓', title }
}

export function sendMarker(state: DwarfSendState | undefined): DeliveryMarker | null {
  if (state === undefined) return null
  if (state.phase === 'sending') return { cls: 'is-sending', glyph: '…', title: 'Sending...' }
  if (state.phase === 'delivered') {
    // The relay's own sentence, and only on the delivered phase: a ✓✓ is the
    // session SEEN acting, which settles the question the framing raised.
    return messageWasRelayed(state.via)
      ? relayedDeliveredMarker(state.awaitingReaction)
      : deliveredMarker(state.awaitingReaction)
  }
  if (state.phase === 'reacted') return reactedMarker(SEND_REACTED_TITLE)
  return { cls: 'is-failed', glyph: '✕', title: state.error ?? SEND_FAILED_TITLE }
}

export function kickMarker(state: DwarfKickState | undefined): DeliveryMarker | null {
  if (state === undefined) return null
  if (state.phase === 'kicking') return { cls: 'is-sending', glyph: '…', title: 'Kicking...' }
  // Not a reacted marker: the panel ended that process, which is a fact it
  // observed rather than behaviour it inferred, and ✓✓ means a session was
  // SEEN acting. One tick, and its own sentence.
  if (state.phase === 'delivered' && kickEndedTheSession(state.via)) {
    return { cls: 'is-delivered', glyph: '✓', title: kickEndedTitle(state.via) }
  }
  // Nor a reacted one, and for the opposite reason (#293): nothing was asked,
  // so there is nothing a session could be seen doing about it.
  if (state.phase === 'delivered' && kickDismissedTheDwarf(state.via)) {
    return { cls: 'is-delivered', glyph: '✓', title: KICK_DISMISSED_TITLE }
  }
  if (state.phase === 'delivered') return deliveredMarker(state.awaitingReaction)
  if (state.phase === 'reacted') return reactedMarker(KICK_REACTED_TITLE)
  return { cls: 'is-failed', glyph: '✕', title: state.error ?? KICK_FAILED_TITLE }
}

/**
 * The line the open action bar shows under a successful action. Failures are
 * absent on purpose: the bar renders those through its own alert row, which
 * carries the reason verbatim.
 */
function statusLine(
  phase: string,
  via: string | undefined,
  awaitingReaction: boolean | undefined,
  what: string
): string | null {
  const channel = via ?? 'the session'
  if (phase === 'reacted') return `${what} via ${channel} — the session reacted.`
  if (phase !== 'delivered') return null
  return awaitingReaction === false
    ? `${what} via ${channel}; no reaction seen.`
    : `${what} via ${channel} — watching for the session to react.`
}

export function sendStatusLine(state: DwarfSendState | undefined): string | null {
  if (state === undefined) return null
  return statusLine(state.phase, state.via, state.awaitingReaction, 'Handed over')
}

export function kickStatusLine(state: DwarfKickState | undefined): string | null {
  if (state === undefined) return null
  // The two acts that are not hand-overs, and never described as one. Both
  // return before `statusLine` below, which would otherwise render the verdict
  // as "via dismiss" — naming a channel that does not exist.
  if (state.phase === 'delivered' && kickEndedTheSession(state.via)) return kickEndedLine(state.via)
  if (state.phase === 'delivered' && kickDismissedTheDwarf(state.via)) return KICK_DISMISSED_LINE
  return statusLine(state.phase, state.via, state.awaitingReaction, 'Kick handed over')
}
