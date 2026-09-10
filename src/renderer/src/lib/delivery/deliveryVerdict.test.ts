import { describe, expect, it } from 'vitest'
import type { DwarfKickState, DwarfSendState } from '../../types'
import {
  SEND_AGAIN_LABEL,
  SEND_AGAIN_TITLE,
  kickDismissedTheDwarf,
  kickEndedTheSession,
  kickHasNothingToAwait,
  kickMarker,
  kickStatusLine,
  messageWasRelayed,
  sendMarker,
  sendStatusLine
} from './deliveryVerdict'

/**
 * The whole point of the two-phase verdict: "delivered" means the message was
 * handed to the session's queue, which is NOT the same as the session acting on
 * it. Every string below has to keep those two apart.
 */

describe('sendMarker', () => {
  it('shows nothing when there is no delivery to report', () => {
    expect(sendMarker(undefined)).toBeNull()
  })

  it('marks an in-flight send', () => {
    const marker = sendMarker({ phase: 'sending' })
    expect(marker?.glyph).toBe('…')
    expect(marker?.cls).toBe('is-sending')
  })

  it('says the message was handed over, not that it was acted on', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    }
    const marker = sendMarker(state)

    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
    expect(marker?.title).toMatch(/handed to the session/i)
    expect(marker?.title).not.toMatch(/reacted/i)
  })

  it('admits when the window closed without a reaction', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: false
    }
    expect(sendMarker(state)?.title).toMatch(/no reaction/i)
  })

  it('claims a reaction only once one was observed', () => {
    const marker = sendMarker({ phase: 'reacted', via: 'claude-relay' })
    expect(marker?.glyph).toBe('✓✓')
    expect(marker?.cls).toBe('is-reacted')
    expect(marker?.title).toMatch(/reacted/i)
  })

  it('carries the failure reason so the marker can explain itself', () => {
    const marker = sendMarker({ phase: 'failed', via: 'terminal', error: 'The relay timed out.' })
    expect(marker?.glyph).toBe('✕')
    expect(marker?.cls).toBe('is-failed')
    expect(marker?.title).toBe('The relay timed out.')
  })

  it('falls back to a plain reason when the failure carried none', () => {
    expect(sendMarker({ phase: 'failed', via: 'terminal' })?.title).toBeTruthy()
  })
})

describe('kickMarker', () => {
  it('shows nothing when there is no kick to report', () => {
    expect(kickMarker(undefined)).toBeNull()
  })

  it('marks an in-flight kick', () => {
    expect(kickMarker({ phase: 'kicking' })?.glyph).toBe('…')
  })

  it('says the kick was handed over, not that the session stopped', () => {
    const state: DwarfKickState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    }
    const marker = kickMarker(state)

    expect(marker?.glyph).toBe('✓')
    expect(marker?.title).toMatch(/handed to the session/i)
    expect(marker?.title).not.toMatch(/reacted|stopped/i)
  })

  it('claims a reaction only once the session was seen acting on it', () => {
    const marker = kickMarker({ phase: 'reacted', via: 'terminal' })
    expect(marker?.glyph).toBe('✓✓')
    expect(marker?.cls).toBe('is-reacted')
    expect(marker?.title).toMatch(/reacted/i)
  })

  it('carries the failure reason', () => {
    const marker = kickMarker({ phase: 'failed', via: 'terminal', error: 'No console to reach.' })
    expect(marker?.title).toBe('No console to reach.')
  })
})

describe('sendStatusLine', () => {
  it('names the channel and stops short of claiming a reaction', () => {
    const line = sendStatusLine({ phase: 'delivered', via: 'claude-relay', awaitingReaction: true })
    expect(line).toContain('claude-relay')
    expect(line).toMatch(/handed/i)
    expect(line).not.toMatch(/reacted/i)
  })

  it('reports the reaction once it is real', () => {
    const line = sendStatusLine({ phase: 'reacted', via: 'terminal' })
    expect(line).toContain('terminal')
    expect(line).toMatch(/reacted/i)
  })

  it('says so when the window closed unobserved', () => {
    const line = sendStatusLine({ phase: 'delivered', via: 'terminal', awaitingReaction: false })
    expect(line).toMatch(/no reaction/i)
  })

  it('has nothing to say about an in-flight or failed send', () => {
    expect(sendStatusLine({ phase: 'sending' })).toBeNull()
    expect(sendStatusLine({ phase: 'failed', via: 'terminal', error: 'nope' })).toBeNull()
    expect(sendStatusLine(undefined)).toBeNull()
  })
})

describe('kickStatusLine', () => {
  it('names the channel and stops short of claiming the session stopped', () => {
    const line = kickStatusLine({ phase: 'delivered', via: 'claude-relay', awaitingReaction: true })
    expect(line).toContain('claude-relay')
    expect(line).toMatch(/handed/i)
    expect(line).not.toMatch(/reacted/i)
  })

  it('reports the reaction once it is real', () => {
    expect(kickStatusLine({ phase: 'reacted', via: 'terminal' })).toMatch(/reacted/i)
  })

  it('has nothing to say about an in-flight or failed kick', () => {
    expect(kickStatusLine({ phase: 'kicking' })).toBeNull()
    expect(kickStatusLine({ phase: 'failed', via: 'terminal', error: 'nope' })).toBeNull()
    expect(kickStatusLine(undefined)).toBeNull()
  })
})

/*
 * A kick that ENDED the session is a different act from one that was handed
 * over (#217), and the copy has to keep them apart the way ✓ and ✓✓ already
 * keep handed-over apart from reacted. Nothing is watched for afterwards:
 * there is no session left to react, so a marker that said "watching for it to
 * react" would be waiting for something that cannot happen — and one that
 * promoted itself to ✓✓ would claim a reaction from a process that is gone.
 */
describe('a kick that ended the session', () => {
  it('says the session was ended, never that a turn was interrupted', () => {
    const line = kickStatusLine({ phase: 'delivered', via: 'launched-process' })
    expect(line).toContain('Ended the session')
    expect(line).not.toContain('watching')
    expect(line).not.toContain('handed over')
  })

  it('marks it without ever claiming a reaction', () => {
    const marker = kickMarker({ phase: 'delivered', via: 'launched-process' })
    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
    expect(marker?.title).toContain('ended')
    expect(marker?.title).not.toContain('react')
  })

  it('leaves every other channel saying exactly what it said before', () => {
    expect(kickStatusLine({ phase: 'delivered', via: 'terminal', awaitingReaction: true })).toBe(
      'Kick handed over via terminal — watching for the session to react.'
    )
  })

  it('knows which channels end a session and which only ask', () => {
    expect(kickEndedTheSession('launched-process')).toBe(true)
    expect(kickEndedTheSession('held-session')).toBe(false)
    expect(kickEndedTheSession(undefined)).toBe(false)
  })
})

/*
 * A kick that DISMISSED the dwarf (#293). The third act behind one control,
 * and the only one that never touched the session at all: nothing can
 * interrupt it, so the person said they were done with it and the dwarf left
 * the board. That has to read as neither of the other two — a hand-over
 * promises a session that was asked something, and "the session was ended"
 * claims a process is gone — and, like an ended session, it awaits nothing.
 */
describe('a kick that dismissed the dwarf', () => {
  it('says the dwarf was sent off, never that the session was asked anything', () => {
    const line = kickStatusLine({ phase: 'delivered', via: 'dismiss' })
    expect(line).toContain('off the rock')
    expect(line).not.toContain('watching')
    expect(line).not.toContain('handed over')
    expect(line).not.toContain('Ended the session')
  })

  it('says out loud that the dwarf comes back if the session moves', () => {
    // The dismissal is the person's act and never a finding that the session
    // stopped, so its own copy has to carry the one thing that undoes it.
    expect(kickStatusLine({ phase: 'delivered', via: 'dismiss' })).toMatch(/new activity/i)
    expect(kickMarker({ phase: 'delivered', via: 'dismiss' })?.title).toMatch(/new activity/i)
  })

  it('marks it without ever claiming a reaction', () => {
    const marker = kickMarker({ phase: 'delivered', via: 'dismiss' })
    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
    expect(marker?.title).not.toMatch(/reacted/i)
  })

  it('never reads the channel name into the sentence', () => {
    // 'dismiss' is a verdict, not a route (see DwarfKickVia); the generic line
    // would render it as "via dismiss", which names a channel that does not
    // exist.
    expect(kickStatusLine({ phase: 'delivered', via: 'dismiss' })).not.toContain('via dismiss')
  })

  it('is told apart from an ended session, and from every real channel', () => {
    expect(kickDismissedTheDwarf('dismiss')).toBe(true)
    expect(kickDismissedTheDwarf('launched-process')).toBe(false)
    expect(kickDismissedTheDwarf('terminal')).toBe(false)
    expect(kickDismissedTheDwarf(undefined)).toBe(false)
    expect(kickEndedTheSession('dismiss')).toBe(false)
  })

  it('awaits nothing, for the same reason an ended session awaits nothing', () => {
    expect(kickHasNothingToAwait('dismiss')).toBe(true)
    expect(kickHasNothingToAwait('launched-process')).toBe(true)
    expect(kickHasNothingToAwait('terminal')).toBe(false)
    expect(kickHasNothingToAwait('codex-queue')).toBe(false)
  })
})

/*
 * A message the RELAY carried (#378).
 *
 * The ✓ is unchanged and still says handed over — that fact did not move. What
 * the person cannot otherwise see is HOW it arrived: Claude Code wraps a
 * relayed message in its cross-session envelope and tells the receiving agent
 * the words came from another session rather than from its user, so the panel
 * prepends a line naming the author (RELAY_PROVENANCE_LINE) and says as much on
 * the hover. Somebody whose agent treats their sentence differently deserves to
 * know why, and no glyph changes: the delivery is the same, the framing is not.
 */
describe('a message the relay carried', () => {
  it('says it arrived as a relayed note that names its author', () => {
    const state: DwarfSendState = {
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    }
    const title = sendMarker(state)?.title ?? ''
    expect(title).toMatch(/relayed note/i)
    expect(title).toMatch(/author/i)
    // Still a hand-over and still watching: #378 explains the framing, it does
    // not soften the two-phase verdict.
    expect(title).toMatch(/handed to the session/i)
    expect(title).not.toMatch(/reacted/i)
  })

  it('keeps the glyph, because the delivery is the same and only the framing differs', () => {
    const marker = sendMarker({ phase: 'delivered', via: 'claude-relay', awaitingReaction: true })
    expect(marker?.glyph).toBe('✓')
    expect(marker?.cls).toBe('is-delivered')
  })

  it('still names the framing once the window has closed unobserved', () => {
    const title =
      sendMarker({ phase: 'delivered', via: 'claude-relay', awaitingReaction: false })?.title ?? ''
    expect(title).toMatch(/relayed note/i)
    expect(title).toMatch(/no reaction/i)
  })

  it('says nothing of the sort for a channel that delivers the words as a prompt', () => {
    const pasted = sendMarker({ phase: 'delivered', via: 'terminal', awaitingReaction: true })
    expect(pasted?.title).toBe('Handed to the session — watching for it to react.')
    const held = sendMarker({ phase: 'delivered', via: 'held-session', awaitingReaction: true })
    expect(held?.title).not.toMatch(/relayed note/i)
  })

  it('claims nothing about a reaction that was actually observed', () => {
    // A ✓✓ is the session seen ACTING, which settles the question the framing
    // raised: it read the message. Nothing left to warn about.
    const marker = sendMarker({ phase: 'reacted', via: 'claude-relay' })
    expect(marker?.glyph).toBe('✓✓')
    expect(marker?.title).not.toMatch(/relayed note/i)
  })

  it('knows the one channel that proves a relay carried it', () => {
    // 'foreman-relay' names the HOP and not the tier under it: on Windows a
    // worker's message can reach its foreman by console paste, which carries no
    // provenance line at all. Claiming it there would describe a message that
    // was never framed as a peer's.
    expect(messageWasRelayed('claude-relay')).toBe(true)
    expect(messageWasRelayed('foreman-relay')).toBe(false)
    expect(messageWasRelayed('terminal')).toBe(false)
    expect(messageWasRelayed('held-session')).toBe(false)
    expect(messageWasRelayed(undefined)).toBe(false)
  })
})

/**
 * The retry a failed message offers on its own bubble (#309).
 *
 * Copy about a delivery verdict, so it lives with the rest of it and is pinned
 * here rather than eyeballed in the panel.
 */
describe('sending a failed message again', () => {
  it('names the act in the imperative, short enough to sit beside a bubble', () => {
    expect(SEND_AGAIN_LABEL).toBe('Send again')
  })

  it('says the failed one stays marked, because a retry is a second delivery', () => {
    // Nothing is corrected: the first attempt keeps its ✕, which is the only
    // thing on screen saying the channel let the person down once.
    expect(SEND_AGAIN_TITLE).toContain('stays marked')
    expect(SEND_AGAIN_TITLE).not.toMatch(/reacted/i)
  })
})
