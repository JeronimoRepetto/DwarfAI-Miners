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
const KICK_REACTED_TITLE = 'The session reacted to the kick.'
const SEND_REACTED_TITLE = 'The session reacted to the message.'
const SEND_FAILED_TITLE = 'The message could not be delivered.'
const KICK_FAILED_TITLE = 'The kick could not be delivered.'

function deliveredMarker(awaitingReaction: boolean | undefined): DeliveryMarker {
  return {
    cls: 'is-delivered',
    glyph: '✓',
    title: awaitingReaction === false ? UNOBSERVED_TITLE : HANDED_TITLE
  }
}

function reactedMarker(title: string): DeliveryMarker {
  return { cls: 'is-reacted', glyph: '✓✓', title }
}

export function sendMarker(state: DwarfSendState | undefined): DeliveryMarker | null {
  if (state === undefined) return null
  if (state.phase === 'sending') return { cls: 'is-sending', glyph: '…', title: 'Sending...' }
  if (state.phase === 'delivered') return deliveredMarker(state.awaitingReaction)
  if (state.phase === 'reacted') return reactedMarker(SEND_REACTED_TITLE)
  return { cls: 'is-failed', glyph: '✕', title: state.error ?? SEND_FAILED_TITLE }
}

export function kickMarker(state: DwarfKickState | undefined): DeliveryMarker | null {
  if (state === undefined) return null
  if (state.phase === 'kicking') return { cls: 'is-sending', glyph: '…', title: 'Kicking...' }
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
  return statusLine(state.phase, state.via, state.awaitingReaction, 'Kick handed over')
}
